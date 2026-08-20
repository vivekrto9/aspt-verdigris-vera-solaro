import type { APIRoute } from "astro";
import { requestCustomerPasswordReset } from "../../../../../server/aggregator/customer-auth.ts";
import { readJsonBody, requirePost } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { enforceVeraRateLimit, getVeraEnv } from "../../../../../server/vera/http.ts";

const feature = "aspt-verdigris-vera-solaro.customer-auth.request-password-reset";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "customer-password-reset-request",
    limit: 5,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await requestCustomerPasswordReset({
    env,
    request: context.request,
    email: parsedBody.body.email,
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "customer-auth",
    message: result.message,
    // The link travels by email; the aggregator echoes it back to localhost callers
    // only, so this passes through whatever it decided rather than gating again.
    data: {
      emailSent: result.emailSent,
      resetUrl: result.resetUrl,
    },
  });
};
