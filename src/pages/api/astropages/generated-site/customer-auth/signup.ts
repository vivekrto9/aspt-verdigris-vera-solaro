import type { APIRoute } from "astro";
import { signupCustomer, verifyCustomerEmail } from "../../../../../server/aggregator/customer-auth.ts";
import { readJsonBody, requirePost } from "../../../../../server/generated-site/request.ts";
import { errorResponse, jsonResponse } from "../../../../../server/generated-site/responses.ts";
import { enforceVeraRateLimit, getVeraEnv } from "../../../../../server/vera/http.ts";

const feature = "aspt-verdigris-vera-solaro.customer-auth.signup";

export const GET: APIRoute = async (context) => {
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "customer-email-verification",
    limit: 20,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const result = await verifyCustomerEmail({
    env,
    token: context.url.searchParams.get("verify"),
  });
  const destination = new URL(result.ok ? "/login" : "/signup", context.url.origin);
  destination.searchParams.set("verification", result.ok ? "success" : "invalid");
  const response = new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  });
  return response;
};

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const env = await getVeraEnv(context);
  const limited = await enforceVeraRateLimit({
    env,
    request: context.request,
    feature,
    scope: "customer-signup",
    limit: 5,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;
  const parsedBody = await readJsonBody(context.request);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await signupCustomer({
    env,
    request: context.request,
    displayName: parsedBody.body.name ?? parsedBody.body.displayName,
    email: parsedBody.body.email,
    phone: parsedBody.body.phone,
    password: parsedBody.body.password,
    createSession: true,
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);

  const response = jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "customer-auth",
    message: "Customer account created.",
    data: {
      account: result.account,
      csrfToken: result.csrfToken,
      created: result.created,
    },
  });
  result.cookies.forEach((cookie) => response.headers.append("set-cookie", cookie));
  return response;
};
