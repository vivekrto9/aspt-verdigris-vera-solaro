import type { APIRoute } from "astro";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";
import {
  sendManagedEmailTemplateTest,
} from "../../../../../server/aggregator/notifications/email-template-store.ts";
import { safeString } from "../../../../../server/aggregator/runtime.ts";
import {
  readJsonBody,
  requirePost,
} from "../../../../../server/generated-site/request.ts";
import {
  errorResponse,
  jsonResponse,
} from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.generated-site-operations.email-template-test";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const payload =
    parsed.body.payload &&
    typeof parsed.body.payload === "object" &&
    !Array.isArray(parsed.body.payload)
      ? parsed.body.payload as Record<string, unknown>
      : undefined;
  const result = await sendManagedEmailTemplateTest({
    env: auth.env,
    key: safeString(parsed.body.key),
    recipient: safeString(parsed.body.recipient),
    payload,
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);
  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    message: "Test email sent.",
    data: result,
  });
};
