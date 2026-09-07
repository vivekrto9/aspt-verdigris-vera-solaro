import { getBookingPreviewPolicy } from "../integrations/booking-preview-policy.ts";
import type { RuntimeEnv } from "../runtime.ts";
import { getRuntimeConfigValue } from "../runtime-config.ts";
import { googleAccessToken, providerFetch } from "../integrations/google.ts";
import { sendSesTransactionalEmail } from "./ses.ts";
export * from "./ses.ts";

export type EmailMessage = {
  to: Array<{ email: string; name?: string }>;
  sender: { email: string; name?: string };
  replyTo?: { email: string; name?: string };
  subject: string; html: string; text: string; tags?: string[]; metadata?: Record<string, unknown>;
};

export type EmailProvider = "ses" | "gmail";
export const selectedEmailProvider = async (env: RuntimeEnv): Promise<EmailProvider> => {
  const value = await getRuntimeConfigValue(env, "TRANSACTIONAL_EMAIL_PROVIDER");
  if (value && value !== "ses" && value !== "gmail") throw new Error("Selected email provider is unavailable.");
  return value === "gmail" ? "gmail" : "ses";
};

export const readSenderSettings = async (env: RuntimeEnv, provider?: EmailProvider) =>
  (provider ?? await selectedEmailProvider(env)) === "ses" ? ({
    senderEmail: await getRuntimeConfigValue(env, "SES_SENDER_EMAIL"),
    senderName: await getRuntimeConfigValue(env, "SES_SENDER_NAME") || "AstroPages",
  }) : ({
    senderEmail: await getRuntimeConfigValue(env, "GMAIL_SENDER_EMAIL"),
    senderName: await getRuntimeConfigValue(env, "GMAIL_SENDER_NAME") || "AstroPages",
  });

const base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const safeHeader = (value: string) => {
  if (/[\r\n]/.test(value)) throw new Error("Invalid email header.");
  return value;
};
const address = (email: string) => {
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new Error("Invalid email address.");
  return safeHeader(email);
};

export const sendTransactionalEmail = async (input: {
  env: RuntimeEnv; message: EmailMessage; provider?: EmailProvider; fetch?: typeof fetch;
}) => {
  const { env, message } = input;
  let gmailSendAttempted = false;
  try {
    const provider = input.provider ?? await selectedEmailProvider(env);
    if (String(env.ASTROPAGES_SITE_ENVIRONMENT) !== "production") {
      const allowed = (await getBookingPreviewPolicy(env)).recipients;
      if (!message.to.length || message.to.some((item) => !allowed.includes(item.email.toLowerCase()))) {
        return { ok: false as const, message: "Preview email requires an explicitly allowlisted test recipient." };
      }
    }
    if (provider === "ses") return sendSesTransactionalEmail(input);
    const sender = await readSenderSettings(env, "gmail");
    if (!sender.senderEmail) return { ok: false as const, message: "Gmail sender is not configured." };
    const token = await googleAccessToken(env, "gmail");
    const boundary = `ap_${crypto.randomUUID().replaceAll("-", "")}`;
    const mime = [
      `From: =?UTF-8?B?${base64(safeHeader(sender.senderName))}?= <${address(sender.senderEmail)}>`,
      `To: ${message.to.map((item) => address(item.email)).join(", ")}`,
      `Subject: =?UTF-8?B?${base64(safeHeader(message.subject))}?=`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
      ...[["text/plain", message.text], ["text/html", message.html]].flatMap(([type, body]) => [
        `--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", base64(body).match(/.{1,76}/g)?.join("\r\n") || "", "",
      ]),
      `--${boundary}--`, "",
    ].join("\r\n");
    // Never retry a send automatically: a lost response can still mean delivered.
    gmailSendAttempted = true;
    const response = await (input.fetch ?? providerFetch(env))("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64(mime).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false as const, outcomeUnknown: response.status >= 500, message: `Gmail send failed (HTTP ${response.status}). Check permissions and sending limits.` };
    const result = await response.json() as { id?: string };
    if (!result.id) throw new Error("Gmail response is missing a message ID.");
    return { ok: true as const, providerMessageId: result.id };
  } catch {
    return { ok: false as const, outcomeUnknown: gmailSendAttempted, message: "Email delivery could not be confirmed. Check the provider before retrying." };
  }
};
