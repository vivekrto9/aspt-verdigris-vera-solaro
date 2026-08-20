import type { APIRoute } from "astro";

import { enforceVeraRateLimit, getVeraEnv } from "../../../../../../server/vera/http.ts";
import { autocompleteVeraPlaces } from "../../../../../../server/vera/places.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";

export const prerender = false;
const feature = "vera.places.autocomplete";

export const GET: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "places-autocomplete", limit: 60, windowSeconds: 60,
  });
  if (limited) return limited;
  const url = new URL(context.request.url);
  return veraResultResponse(feature, await autocompleteVeraPlaces({
    env,
    input: url.searchParams.get("input"),
    sessionToken: url.searchParams.get("sessionToken"),
    language: url.searchParams.get("language"),
  }));
};
