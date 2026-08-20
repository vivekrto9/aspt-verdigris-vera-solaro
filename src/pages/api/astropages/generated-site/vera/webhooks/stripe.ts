import type { APIRoute } from "astro";

import { processStripeWebhook } from "../../../../../../server/vera/stripe.ts";
import { getVeraEnv, readBoundedText } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.webhooks.stripe";

export const POST: APIRoute = async (context) => {
  const body = await readBoundedText(context.request, 512 * 1024);
  if (!body.ok) return errorResponse(feature, body.message, body.status);
  return veraResultResponse(feature, await processStripeWebhook({
    env: await getVeraEnv(context),
    body: body.text,
    signatureHeader: context.request.headers.get("stripe-signature") || "",
  }));
};
