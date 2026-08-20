import { blockedProviderResponse, errorResponse, jsonResponse } from "../generated-site/responses.ts";

export const veraResultResponse = (
  feature: string,
  result: Record<string, unknown> & {
    ok: boolean;
    status?: number;
    message?: string;
    missingSecretNames?: string[];
  },
) => {
  if (!result.ok && result.missingSecretNames?.length) {
    return blockedProviderResponse({
      feature,
      capabilityKey: feature,
      missingSecretNames: result.missingSecretNames,
      message: result.message || "Provider setup is incomplete.",
      status: result.status || 503,
    });
  }
  if (!result.ok) return errorResponse(feature, result.message || "Request failed.", result.status || 400);
  const { ok: _ok, status: statusCode, message, missingSecretNames: _missing, ...data } = result;
  return jsonResponse({
    status: "ready",
    state: "ready",
    feature,
    message: message || "Request completed.",
    data,
  }, { status: statusCode || 200 });
};
