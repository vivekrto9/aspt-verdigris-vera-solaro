import type { APIRoute } from "astro";

import { unsubscribeVeraNewsletter } from "../../../../../../server/vera/email.ts";
import { getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.newsletter.unsubscribe";

export const GET: APIRoute = async (context) => {
  const url = new URL(context.request.url);
  return veraResultResponse(feature, await unsubscribeVeraNewsletter({
    env: await getVeraEnv(context), token: url.searchParams.get("token"),
  }));
};
export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await unsubscribeVeraNewsletter({
    env: await getVeraEnv(context), token: parsed.body.token,
  }));
};
