export type GeneratedSiteStatus = "ready" | "blocked-provider" | "error";

export interface GeneratedSiteResponseBody {
  status: GeneratedSiteStatus;
  state: GeneratedSiteStatus;
  feature: string;
  message: string;
  capabilityKey?: string;
  missingSecretNames?: string[];
  sid?: string;
  data?: Record<string, unknown>;
}

export const jsonResponse = (
  body: GeneratedSiteResponseBody,
  init: ResponseInit = {},
) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

export const errorResponse = (
  feature: string,
  message: string,
  status = 400,
) =>
  jsonResponse(
    {
      status: "error",
      state: "error",
      feature,
      message,
    },
    { status },
  );

export const blockedProviderResponse = ({
  feature,
  capabilityKey,
  missingSecretNames,
  message = "Provider credentials are not configured for this capability.",
  status = 200,
  data,
  sid,
}: {
  feature: string;
  capabilityKey: string;
  missingSecretNames: string[];
  message?: string;
  status?: number;
  data?: Record<string, unknown>;
  sid?: string;
}) =>
  jsonResponse(
    {
      status: "blocked-provider",
      state: "blocked-provider",
      feature,
      capabilityKey,
      missingSecretNames,
      message,
      sid,
      data,
    },
    { status },
  );
