import type { APIRoute } from "astro";

import { buildVeraBookingAccessCookie } from "../../../../../../server/vera/booking-session.ts";
import { createVeraBooking } from "../../../../../../server/vera/bookings.ts";
import { enforceVeraRateLimit, getVeraEnv, readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.bookings.create";

export const POST: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env, request: context.request, feature, scope: "booking-create", limit: 8, windowSeconds: 900,
  });
  if (limited) return limited;
  const parsed = await readJsonObject(context.request, 32_768);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const result = await createVeraBooking({
    env,
    request: context.request,
    input: parsed.body,
  });
  const response = veraResultResponse(feature, result);
  // Mirror the manage token into an HttpOnly cookie so the confirmation route can
  // load the booking server-side. The JSON body still
  // carries the token for the wizard's own authenticated API calls.
  if (result.ok && result.manageToken && result.booking?.id) {
    response.headers.append("set-cookie", buildVeraBookingAccessCookie({
      request: context.request,
      bookingId: String(result.booking.id),
      manageToken: String(result.manageToken),
      expiresAt: String(result.booking.holdExpiresAt ?? ""),
    }));
  }
  return response;
};
