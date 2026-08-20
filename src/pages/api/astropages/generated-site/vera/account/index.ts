import type { APIRoute } from "astro";

import {
  claimVeraBookingToAccount,
  getVeraAccountPortal,
  resendVeraBookingReceipt,
} from "../../../../../../server/vera/account.ts";
import { getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.account.portal";

export const GET: APIRoute = async (context) => {
  const response = veraResultResponse(
    feature,
    await getVeraAccountPortal(await getVeraEnv(context), context.request),
  );
  response.headers.set("cache-control", "private, no-store");
  return response;
};

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  if (!['resend_receipt', 'claim_booking'].includes(String(parsed.body.action))) {
    return errorResponse(feature, "Account action is invalid.", 400);
  }
  const env = await getVeraEnv(context);
  const result = parsed.body.action === "claim_booking"
    ? await claimVeraBookingToAccount(env, context.request, parsed.body)
    : await resendVeraBookingReceipt(env, context.request, parsed.body);
  const response = veraResultResponse(feature, result);
  response.headers.set("cache-control", "private, no-store");
  return response;
};
