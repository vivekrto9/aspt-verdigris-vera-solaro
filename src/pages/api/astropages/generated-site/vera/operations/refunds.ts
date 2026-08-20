import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import { createStripeRefund } from "../../../../../../server/vera/stripe.ts";
import { readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.refunds";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const amount = parsed.body.amountCents === undefined ? undefined : Number(parsed.body.amountCents);
  return veraResultResponse(feature, await createStripeRefund({
    env: auth.env as VeraEnv,
    bookingId: String(parsed.body.bookingId || ""),
    amountCents: amount,
    reason: String(parsed.body.reason || ""),
  }));
};
