import type { APIRoute } from "astro";
import { getCustomerSession } from "../../../../../server/aggregator/customer-auth.ts";
import { getRuntimeEnv } from "../../../../../server/generated-site/request.ts";
import { jsonResponse } from "../../../../../server/generated-site/responses.ts";

const feature = "aspt-verdigris-vera-solaro.customer-auth.me";

export const GET: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const session = await getCustomerSession(env, context.request).catch(() => null);

  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "customer-auth",
    message: session ? "Customer session is active." : "Customer session is not active.",
    data: {
      account: session?.account ?? null,
      csrfToken: session?.csrfToken ?? "",
    },
  });
};
