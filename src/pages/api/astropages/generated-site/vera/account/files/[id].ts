import type { APIRoute } from "astro";

import { getAuthorizedVeraFile } from "../../../../../../../server/vera/account.ts";
import { getVeraEnv } from "../../../../../../../server/vera/http.ts";
import { errorResponse } from "../../../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.account.files";

export const GET: APIRoute = async (context) => {
  const result = await getAuthorizedVeraFile(
    await getVeraEnv(context), context.request, context.params.id || "",
  );
  if (!result.ok) {
    if (result.status === 416 && "contentRange" in result) {
      return new Response(result.message, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "content-range": result.contentRange,
          "x-content-type-options": "nosniff",
        },
      });
    }
    const response = errorResponse(feature, result.message, result.status);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  const fileName = String(result.file.file_name || "private-file").replace(/["\r\n]/g, "");
  const range = result.range;
  return new Response(result.body, {
    status: result.status,
    headers: {
      "accept-ranges": "bytes",
      "content-type": String(result.file.content_type || "application/octet-stream"),
      "content-disposition": `inline; filename="${fileName}"`,
      "content-length": String(range?.length ?? result.size),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.end}/${result.size}` } : {}),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
};
