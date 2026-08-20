import type { APIRoute } from "astro";
import { requireContentReleaseServiceAuth } from "../content-release/auth.ts";
import {
  listEmailEvents,
  listEmailTemplateWorkspace,
  listEmailVariableMappings,
  saveEmailEvent,
  saveEmailVariableMapping,
  saveManagedEmailTemplate,
} from "../../../../../server/aggregator/notifications/email-template-store.ts";
import { readJsonBody } from "../../../../../server/generated-site/request.ts";
import {
  errorResponse,
  jsonResponse,
} from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "aspt-verdigris-vera-solaro.generated-site-operations.email-templates";

export const GET: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "transactional-notifications",
    message: "Email templates loaded.",
    data: {
      emailTemplates: await listEmailTemplateWorkspace(auth.env),
      events: await listEmailEvents(auth.env),
      variableMappings: await listEmailVariableMappings(auth.env),
    },
  });
};

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const envelope =
    parsed.body.template &&
    typeof parsed.body.template === "object" &&
    !Array.isArray(parsed.body.template)
      ? parsed.body
      : { template: parsed.body };
  if (Array.isArray(envelope.variableMappings)) {
    for (const mapping of envelope.variableMappings) {
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
        return errorResponse(feature, "Email variable mapping is invalid.", 400);
      }
      await saveEmailVariableMapping(
        auth.env,
        mapping as Record<string, unknown>,
      );
    }
  }
  if (
    envelope.event &&
    typeof envelope.event === "object" &&
    !Array.isArray(envelope.event)
  ) {
    await saveEmailEvent(auth.env, envelope.event as Record<string, unknown>);
  }
  const result = await saveManagedEmailTemplate({
    env: auth.env,
    input: envelope.template as Record<string, unknown>,
    actor: auth.claims.sub || "astropages-control-plane",
  });
  if (!result.ok) return errorResponse(feature, result.message, 400);
  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    capabilityKey: "transactional-notifications",
    message: "Preview email template saved.",
    data: { emailTemplate: result.template },
  });
};
