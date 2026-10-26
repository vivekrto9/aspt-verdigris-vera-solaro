import type { APIRoute } from "astro";
import { verifyPaymentSettingsJwt } from "../../../../../server/aggregator/admin-sso.ts";
import { PaymentPreferenceError, paymentPreferences, readPaymentPreference, updatePaymentPreference } from "../../../../../server/aggregator/payment-preference.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";

export const prerender = false;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, message: string) => json({ status: "error", code, message }, status);

const handle: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const request = context.request;
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  let claims: Record<string, unknown>;
  try { claims = await verifyPaymentSettingsJwt(token, env.ASTROPAGES_SSO_PUBLIC_JWK); }
  catch { return fail(401, "PAYMENT_UNAUTHORIZED", "A valid control-plane payment-settings token is required."); }
  const projectId = env.ASTROPAGES_PROJECT_ID;
  const environment = env.ASTROPAGES_SITE_ENVIRONMENT;
  if (typeof projectId !== "string" || !projectId || (environment !== "preview" && environment !== "production")) {
    return fail(503, "PAYMENT_SETTINGS_UNAVAILABLE", "The payment runtime target is not configured.");
  }
  if (claims.projectId !== projectId || claims.environment !== environment || claims.method !== request.method || claims.path !== new URL(request.url).pathname) {
    return fail(403, "PAYMENT_FORBIDDEN", "Payment-settings token target does not match.");
  }
  if (request.method === "PATCH" && !["owner", "admin"].includes(String(claims.role))) {
    return fail(403, "PAYMENT_FORBIDDEN", "Only owners and admins can change payment preference.");
  }
  let bodyText = "";
  try {
    if (request.method === "PATCH") {
      const reader = request.body?.getReader();
      if (!reader) return fail(400, "PAYMENT_INVALID_INPUT", "A JSON body is required.");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) { await reader.cancel(); return fail(413, "PAYMENT_INVALID_INPUT", "Preference update is too large."); }
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
      reader.releaseLock();
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== claims.bodyHash) return fail(403, "PAYMENT_FORBIDDEN", "Payment-settings body does not match the signed request.");
    let input: unknown;
    if (request.method === "PATCH") {
      try { input = JSON.parse(bodyText); } catch { return fail(400, "PAYMENT_INVALID_INPUT", "A valid JSON object is required."); }
    }
    const setting = request.method === "PATCH" ? await updatePaymentPreference(env, input) : await readPaymentPreference(env);
    return json({ data: { supported: true, contractVersion: "payment-settings.v1", projectId, environment, ...setting, allowedValues: paymentPreferences, walletPolicy: "not_applicable" } });
  } catch (error) {
    if (error instanceof PaymentPreferenceError) return fail(error.status, error.code, error.message);
    return fail(503, "PAYMENT_SETTINGS_UNAVAILABLE", "Payment settings could not be read or saved. Read the current value before retrying.");
  }
};

export const GET = handle;
export const PATCH = handle;
