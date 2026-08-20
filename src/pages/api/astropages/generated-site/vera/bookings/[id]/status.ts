import type { APIRoute } from "astro";

import { getVeraBookingStatus } from "../../../../../../../server/vera/bookings.ts";
import { retryPaidVeraBookingScheduling } from "../../../../../../../server/vera/calendly.ts";
import { getVeraEnv, readJsonObject, requestToken } from "../../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.bookings.status";
const privateResponse = (response: Response) => {
  response.headers.set("cache-control", "private, no-store");
  return response;
};

export const GET: APIRoute = async (context) => {
  const response = veraResultResponse(feature, await getVeraBookingStatus({
    env: await getVeraEnv(context),
    request: context.request,
    bookingId: context.params.id || "",
    manageToken: context.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "",
  }));
  return privateResponse(response);
};

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return privateResponse(errorResponse(feature, parsed.message, parsed.status));
  if (parsed.body.action !== "retry_scheduling") {
    return privateResponse(errorResponse(feature, "Action must be retry_scheduling.", 400));
  }
  const env = await getVeraEnv(context);
  const bookingId = context.params.id || "";
  const manageToken = requestToken(context.request, parsed.body);
  const retried = await retryPaidVeraBookingScheduling({
    env,
    request: context.request,
    bookingId,
    manageToken,
  });
  if (!retried.ok) {
    return privateResponse(veraResultResponse(feature, retried));
  }
  const authoritative = await getVeraBookingStatus({
    env,
    request: context.request,
    bookingId,
    manageToken,
  });
  const response = veraResultResponse(feature, authoritative.ok
    ? {
        ok: true,
        status: retried.status,
        message: retried.message,
        booking: authoritative.booking,
        reconciliation: retried.reconciliation,
      }
    : authoritative);
  return privateResponse(response);
};
