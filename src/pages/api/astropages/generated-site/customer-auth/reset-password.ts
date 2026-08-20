import type { APIRoute } from "astro";
import { resetCustomerPassword } from "../../../../../server/aggregator/customer-auth.ts";
import { readJsonBody, requirePost } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { enforceVeraRateLimit, getVeraEnv } from "../../../../../server/vera/http.ts";

const feature = "aspt-verdigris-vera-solaro.customer-auth.reset-password";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "customer-password-reset-complete",
    limit: 10,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await resetCustomerPassword({
    env,
    token: parsedBody.body.token,
    password: parsedBody.body.password,
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "customer-auth",
    message: result.message,
    data: {},
  });
};
