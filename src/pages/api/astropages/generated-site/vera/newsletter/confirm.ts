import type { APIRoute } from "astro";

import { confirmVeraNewsletter } from "../../../../../../server/vera/email.ts";
import { getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.newsletter.confirm";

export const GET: APIRoute = async (context) => {
  const url = new URL(context.request.url);
  const result = await confirmVeraNewsletter({
    env: await getVeraEnv(context),
    subscriptionId: url.searchParams.get("id"),
    token: url.searchParams.get("token"),
  });
  const destination = new URL("/letters", context.request.url);
  if (result.ok) destination.searchParams.set("confirmed", "1");
  else destination.searchParams.set("confirmation", "invalid-or-expired");
  return Response.redirect(destination.toString(), 303);
};

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await confirmVeraNewsletter({
    env: await getVeraEnv(context),
    subscriptionId: parsed.body.id,
    token: parsed.body.token,
  }));
};
