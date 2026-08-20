import type { APIRoute } from "astro";

import { enforceVeraRateLimit, getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { resolveVeraPlaceDetails } from "../../../../../../server/vera/places.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.places.details";

export const POST: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "places-details", limit: 30, windowSeconds: 60,
  });
  if (limited) return limited;
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const response = veraResultResponse(feature, await resolveVeraPlaceDetails({
    env,
    placeId: parsed.body.placeId,
    sessionToken: parsed.body.sessionToken,
    birthDate: parsed.body.birthDate,
    birthTime: parsed.body.birthTime,
    birthTimeUnknown: parsed.body.birthTimeUnknown === true,
  }));
  response.headers.set("cache-control", "private, no-store");
  return response;
};
