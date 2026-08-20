import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import { suppressVeraRecipient } from "../../../../../../server/vera/operations.ts";
import { readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.suppressions";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonObject(context.request, 8_192);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  const reason = String(parsed.body.reason || "") as "bounce" | "complaint" | "manual";
  if (!["bounce", "complaint", "manual"].includes(reason)) {
    return errorResponse(feature, "Suppression reason is invalid.", 400);
  }
  return veraResultResponse(feature, {
    ...(await suppressVeraRecipient({
      env: auth.env as VeraEnv,
      email: parsed.body.email,
      reason,
      providerEventId: String(parsed.body.providerEventId || ""),
      detailCode: String(parsed.body.detailCode || ""),
    })),
    status: 200,
    message: "Recipient suppressed.",
  });
};
