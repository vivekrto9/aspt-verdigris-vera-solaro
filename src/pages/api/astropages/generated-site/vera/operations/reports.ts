import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import { publishVeraReport } from "../../../../../../server/vera/operations.ts";
import { readJsonObject } from "../../../../../../server/vera/http.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.reports";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonObject(context.request, 128 * 1024);
  if (!parsed.ok) return errorResponse(feature, parsed.message, parsed.status);
  return veraResultResponse(feature, await publishVeraReport(auth.env as VeraEnv, parsed.body));
};
