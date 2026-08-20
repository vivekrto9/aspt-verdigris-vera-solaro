import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import {
  listVeraCalendlyReconciliations,
  listVeraOperationsReadiness,
  resolveVeraCalendlyReconciliation,
  validateVeraProviderWebhookSetup,
} from "../../../../../../server/vera/operations.ts";
import { readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { blockedProviderResponse, errorResponse, jsonResponse } from "../../../../../../server/generated-site/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.readiness";

export const GET: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const data = await listVeraOperationsReadiness(auth.env as VeraEnv);
  if (!data.ready) {
    return blockedProviderResponse({
      feature,
      capabilityKey: feature,
      missingSecretNames: data.missingSecretNames,
      message: "Vera operations setup is incomplete.",
      status: 503,
      data,
    });
  }
  return jsonResponse({
    status: "ready", state: "ready", feature,
    message: "Vera operations are ready.",
    data,
  });
};

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonObject(context.request, 16_384);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const action = typeof parsed.body.action === "string" ? parsed.body.action.trim() : "";
  const env = auth.env as VeraEnv;
  if (action === "validate_provider_webhooks") {
    return veraResultResponse(feature, await validateVeraProviderWebhookSetup(env, parsed.body));
  }
  if (action === "list_calendly_reconciliations") {
    return veraResultResponse(feature, await listVeraCalendlyReconciliations(env, parsed.body));
  }
  if (action === "resolve_calendly_reconciliation") {
    return veraResultResponse(feature, await resolveVeraCalendlyReconciliation(env, parsed.body));
  }
  return errorResponse(feature, "Vera operations action is invalid.", 400);
};
