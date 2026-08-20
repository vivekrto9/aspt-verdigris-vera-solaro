import type { APIRoute } from "astro";

import { listVeraCatalog } from "../../../../../server/vera/catalog.ts";
import { getVeraEnv } from "../../../../../server/vera/http.ts";
import { jsonResponse } from "../../../../../server/generated-site/responses.ts";

export const prerender = false;
const feature = "vera.catalog";

export const GET: APIRoute = async (context) => jsonResponse({
  status: "ready",
  state: "ready",
  feature,
  message: "Vera sitting catalog loaded.",
  data: await listVeraCatalog(await getVeraEnv(context)),
});
