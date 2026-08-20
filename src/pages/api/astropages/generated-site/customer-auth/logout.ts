import type { APIRoute } from "astro";
import { revokeCustomerSession } from "../../../../../server/aggregator/customer-auth.ts";
import { getRuntimeEnv, requirePost } from "../../../../../server/generated-site/request.ts";
import { jsonResponse } from "../../../../../server/generated-site/responses.ts";

const feature = "aspt-verdigris-vera-solaro.customer-auth.logout";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const env = await getRuntimeEnv(context);
  const cookies = await revokeCustomerSession(env, context.request);
  const response = jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "customer-auth",
    message: "Customer session has been closed.",
  });
  cookies.forEach((cookie) => response.headers.append("set-cookie", cookie));
  return response;
};
