import type { APIRoute } from "astro";

import { subscribeVeraNewsletter } from "../../../../../../server/vera/email.ts";
import { enforceVeraRateLimit, getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.newsletter.subscribe";

export const POST: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "newsletter", limit: 5, windowSeconds: 900,
  });
  if (limited) return limited;
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  if (String(parsed.body.website || "").trim()) {
    return veraResultResponse(feature, { ok: true, status: 202, message: "Check your email to confirm the subscription." });
  }
  if (parsed.body.consentMarketing !== true) {
    return errorResponse(feature, "Marketing consent is required.", 400);
  }
  return veraResultResponse(feature, await subscribeVeraNewsletter({
    env,
    email: parsed.body.email,
    displayName: parsed.body.name,
    locale: parsed.body.locale,
    source: parsed.body.source,
    birthDate: parsed.body.birthDate,
    birthTime: parsed.body.birthTime,
  }));
};
