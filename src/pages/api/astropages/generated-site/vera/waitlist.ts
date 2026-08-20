import type { APIRoute } from "astro";

import { joinVeraWaitlist } from "../../../../../server/vera/engagement.ts";
import { enforceVeraRateLimit, getVeraEnv, readJsonObject } from "../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.waitlist";

export const POST: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "waitlist", limit: 5, windowSeconds: 900,
  });
  if (limited) return limited;
  const parsed = await readJsonObject(context.request, 16_384);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await joinVeraWaitlist({
    env, request: context.request, input: parsed.body,
  }));
};
