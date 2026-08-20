import type { APIRoute } from "astro";

import { completeVeraReschedule, requestFreeVeraReschedule } from "../../../../../../../server/vera/bookings.ts";
import { getVeraEnv, readJsonObject, requestToken } from "../../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.bookings.reschedule";

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const shared = {
    env: await getVeraEnv(context),
    request: context.request,
    bookingId: context.params.id || "",
    manageToken: requestToken(context.request, parsed.body),
  };
  const newStartAt = parsed.body.newStartAt || parsed.body.startAt;
  return veraResultResponse(feature, newStartAt
    ? await completeVeraReschedule({ ...shared, newStartAt })
    : await requestFreeVeraReschedule(shared));
};
