import type { APIRoute } from "astro";

import { requireContentReleaseServiceAuth } from "../../content-release/auth.ts";
import { storeVeraPrivateFile } from "../../../../../../server/vera/operations.ts";
import { veraResultResponse } from "../../../../../../server/vera/responses.ts";
import { errorResponse } from "../../../../../../server/generated-site/responses.ts";
import type { VeraEnv } from "../../../../../../server/vera/types.ts";

export const prerender = false;
const feature = "vera.operations.private-files";

export const POST: APIRoute = async (context) => {
  const auth = await requireContentReleaseServiceAuth(context, feature);
  if (!auth.ok) return auth.response;
  const contentLength = Number(context.request.headers.get("content-length"));
  if (!Number.isFinite(contentLength) || contentLength < 1) {
    return errorResponse(feature, "A bounded multipart Content-Length is required.", 411);
  }
  // Cloudflare caps the entire request at 100 MB. Reserve multipart overhead
  // while allowing the source's 84 MB recording through to kind-aware checks.
  if (contentLength > 96 * 1024 * 1024) return errorResponse(feature, "Upload is too large.", 413);
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return errorResponse(feature, "A multipart form upload is required.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(feature, "A file is required.", 400);
  return veraResultResponse(feature, await storeVeraPrivateFile({
    env: auth.env as VeraEnv,
    bookingId: String(form.get("bookingId") || ""),
    reportId: String(form.get("reportId") || ""),
    kind: String(form.get("kind") || ""),
    file,
  }));
};
