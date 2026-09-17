import type { APIRoute } from "astro";
import { processRazorpayWebhook } from "../../../../../../server/vera/razorpay.ts";
import { getVeraEnv } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";

export const prerender = false;
const feature = "vera.payments.webhook.razorpay";
export const POST: APIRoute = async (context) => veraResultResponse(feature, await processRazorpayWebhook({
  env: await getVeraEnv(context),
  body: await context.request.text(),
  signatureHeader: context.request.headers.get("x-razorpay-signature") || "",
  eventIdHeader: context.request.headers.get("x-razorpay-event-id") || "",
}));
