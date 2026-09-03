import type { APIRoute } from "astro";

import { listVeraAvailability } from "../../../../../server/vera/availability.ts";
import { getVeraBookingAccess } from "../../../../../server/vera/security.ts";
import { enforceVeraRateLimit, getVeraEnv } from "../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../server/vera/responses.ts";

export const prerender = false;
const feature = "vera.availability";

export const GET: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "calendly-availability",
    limit: 80,
    windowSeconds: 60,
  });
  if (limited) return limited;
  const globallyLimited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "calendly-availability-global",
    limit: 320,
    windowSeconds: 60,
    identity: "global",
  });
  if (globallyLimited) return globallyLimited;
  const url = new URL(context.request.url);
  const bookingId = url.searchParams.get("bookingId") || "";
  const access = bookingId ? await getVeraBookingAccess({ env, request: context.request, bookingId, manageToken: context.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "" }) : null;
  if (access && !access.ok) return veraResultResponse(feature, access);
  const result = await listVeraAvailability({
    env,
    booking: access?.ok ? access.booking : undefined,
    serviceSlug: access?.ok ? access.booking.service_slug : url.searchParams.get("serviceSlug"),
    mode: access?.ok ? access.booking.mode : url.searchParams.get("mode"),
    startTime: url.searchParams.get("start") || "",
    endTime: url.searchParams.get("end") || "",
  });
  return veraResultResponse(feature, result);
};
