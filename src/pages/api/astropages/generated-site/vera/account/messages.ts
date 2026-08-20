import type { APIRoute } from "astro";

import { listVeraThreadMessages, sendVeraCustomerMessage } from "../../../../../../server/vera/account.ts";
import { getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.account.messages";

export const GET: APIRoute = async (context) => {
  const url = new URL(context.request.url);
  const response = veraResultResponse(feature, await listVeraThreadMessages(
    await getVeraEnv(context), context.request, url.searchParams.get("threadId") || "",
  ));
  response.headers.set("cache-control", "private, no-store");
  return response;
};

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 16_384);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const response = veraResultResponse(feature, await sendVeraCustomerMessage(
    await getVeraEnv(context), context.request, parsed.body,
  ));
  response.headers.set("cache-control", "private, no-store");
  return response;
};
