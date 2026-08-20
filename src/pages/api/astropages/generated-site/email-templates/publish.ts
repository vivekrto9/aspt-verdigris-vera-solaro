import type { APIRoute } from "astro";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";
import {
  saveEmailEvent,
  saveEmailVariableMapping,
  saveManagedEmailTemplate,
} from "../../../../../server/aggregator/notifications/email-template-store.ts";
import {
  readJsonBody,
  requirePost,
} from "../../../../../server/generated-site/request.ts";
import {
  errorResponse,
  jsonResponse,
} from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.generated-site-operations.email-template-publish";

export const POST: APIRoute = async (context) => {
  const methodError = requirePost(context.request);
  if (methodError) return methodError;
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const template = parsed.body.template;
  const event = parsed.body.event;
  if (
    !template ||
    typeof template !== "object" ||
    Array.isArray(template) ||
    !event ||
    typeof event !== "object" ||
    Array.isArray(event)
  ) {
    return errorResponse(
      feature,
      "A preview template and email event are required.",
      400,
    );
  }
  if (Array.isArray(parsed.body.variableMappings)) {
    for (const mapping of parsed.body.variableMappings) {
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
        return errorResponse(feature, "Email variable mapping is invalid.", 400);
      }
      await saveEmailVariableMapping(
        auth.env,
        mapping as Record<string, unknown>,
      );
    }
  }
  await saveEmailEvent(auth.env, event as Record<string, unknown>);
  const result = await saveManagedEmailTemplate({
    env: auth.env,
    input: template as Record<string, unknown>,
    actor: auth.claims.sub || "astropages-control-plane",
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);
  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    message: "Preview email template published to production.",
    data: result,
  });
};
