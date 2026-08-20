import type { APIRoute } from "astro";

import { createStripeCheckoutForBooking } from "../../../../../../../server/vera/stripe.ts";
import { getVeraEnv, readJsonObject, requestToken } from "../../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../../server/generated-site/responses.ts";
import type { VeraPaymentKind } from "../../../../../../../server/vera/catalog.ts";

export const prerender = false;
const feature = "vera.payments.checkout-session";

export const POST: APIRoute = async (context) => {
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const result = await createStripeCheckoutForBooking({
    env: await getVeraEnv(context),
    request: context.request,
    bookingId: context.params.id || "",
    manageToken: requestToken(context.request, parsed.body),
    kind: String(parsed.body.kind || "") as VeraPaymentKind,
    origin: new URL(context.request.url).origin,
  });
  return veraResultResponse(feature, result);
};
