import { getRuntimeConfigValue, isRuntimeConfigKey } from "../runtime-config.ts";
import { resolveSecretBinding } from "../runtime-bindings.ts";
import type { RuntimeEnv } from "../runtime.ts";

type EmailAddress = {
  email: string;
  name?: string;
};

export type EmailMessage = {
  to: EmailAddress[];
  sender: EmailAddress;
  subject: string;
  html: string;
  text: string;
  tags?: string[];
};

const encoder = new TextEncoder();
const sesProviderTimeoutMs = 8_000;

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmac = async (key: ArrayBuffer | Uint8Array | string, value: string) => {
  const keyBytes =
    typeof key === "string" ? encoder.encode(key) : key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
};

const hmacHex = async (key: ArrayBuffer | Uint8Array | string, value: string) =>
  toHex(await hmac(key, value));

const getSignatureKey = async (
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
) => {
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = await hmac(dateKey, region);
  const dateRegionServiceKey = await hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, "aws4_request");
};

const formatAmzDate = (date = new Date()) => {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
};

const formatAddress = ({ email, name }: EmailAddress) => {
  const safeName = String(name || "").trim().replace(/["\\]/g, "");
  return safeName ? `${safeName} <${email.trim()}>` : email.trim();
};

const toSesTags = (tags: string[] = []) =>
  tags.filter(Boolean).slice(0, 10).map((tag, index) => ({
    Name: index === 0 ? "template" : `tag_${index}`,
    Value: tag.replace(/[^A-Za-z0-9_.@=-]/g, "_").slice(0, 256),
  }));

const readSetting = async (env: RuntimeEnv, key: string) => {
  const configured = isRuntimeConfigKey(key) ? await getRuntimeConfigValue(env, key) : "";
  return configured || (typeof env[key] === "string" ? String(env[key]).trim() : "");
};

export const sendSesTransactionalEmail = async ({
  env,
  message,
  fetch: fetchImpl = fetch,
}: {
  env: RuntimeEnv;
  message: EmailMessage;
  fetch?: typeof fetch;
}) => {
  const region = await readSetting(env, "AWS_REGION");
  const accessKeyId = await resolveSecretBinding(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = await resolveSecretBinding(env, "AWS_SECRET_ACCESS_KEY");
  const missing = [
    region ? "" : "AWS_REGION",
    accessKeyId ? "" : "AWS_ACCESS_KEY_ID",
    secretAccessKey ? "" : "AWS_SECRET_ACCESS_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false as const, message: `AWS SES setup is incomplete: ${missing.join(", ")}` };
  }

  const endpoint = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const host = `email.${region}.amazonaws.com`;
  const body = JSON.stringify({
    FromEmailAddress: formatAddress(message.sender),
    Destination: { ToAddresses: message.to.map(formatAddress) },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: message.html, Charset: "UTF-8" },
          Text: { Data: message.text, Charset: "UTF-8" },
        },
      },
    },
    EmailTags: toSesTags(message.tags),
  });
  const { amzDate, dateStamp } = formatAmzDate();
  const payloadHash = await sha256Hex(body);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    "POST",
    "/v2/email/outbound-emails",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = await hmacHex(
    await getSignatureKey(secretAccessKey, dateStamp, region, "ses"),
    stringToSign,
  );
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": "application/json",
        host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body,
      signal: AbortSignal.timeout(sesProviderTimeoutMs),
    });
  } catch {
    return { ok: false as const, message: "AWS SES is temporarily unavailable." };
  }
  const responseBody = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false as const,
      message: `AWS SES send failed with status ${response.status}.`,
    };
  }
  return {
    ok: true as const,
    providerMessageId: typeof responseBody.MessageId === "string" ? responseBody.MessageId : null,
  };
};

export const readSenderSettings = async (env: RuntimeEnv) => ({
  senderEmail: await readSetting(env, "SES_SENDER_EMAIL"),
  senderName: await readSetting(env, "SES_SENDER_NAME") || "AstroPages",
});
