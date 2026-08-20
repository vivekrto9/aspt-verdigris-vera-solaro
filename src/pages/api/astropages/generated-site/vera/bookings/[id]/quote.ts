import type { APIRoute } from "astro";

import { updateVeraBookingQuote } from "../../../../../../../server/vera/bookings.ts";
import { getVeraEnv, readJsonObject, requestToken } from "../../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.bookings.quote";

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await updateVeraBookingQuote({
    env: await getVeraEnv(context),
    request: context.request,
    bookingId: context.params.id || "",
    manageToken: requestToken(context.request, parsed.body),
    input: parsed.body,
  }));
};
