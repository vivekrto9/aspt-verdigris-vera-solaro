import type { APIRoute } from "astro";

import { submitVeraContact } from "../../../../../server/vera/engagement.ts";
import { enforceVeraRateLimit, getVeraEnv, readJsonObject } from "../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.contact";

export const POST: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "contact", limit: 5, windowSeconds: 900,
  });
  if (limited) return limited;
  const parsed = await readJsonObject(context.request, 16_384);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await submitVeraContact({
    env, request: context.request, input: parsed.body,
  }));
};
