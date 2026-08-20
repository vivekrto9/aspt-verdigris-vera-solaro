import type { APIRoute } from "astro";

import type { D1DatabaseLike } from "../../../../server/aggregator/runtime.ts";
import { readAstroPagesEmDashBootstrapStatus } from "../../../../server/generated-site/emdash-bootstrap.ts";
import { getRuntimeEnv } from "../../../../server/generated-site/request.ts";

export const prerender = false;

const requiredTables = [
  "users",
  "ap_admin_sessions",
  "ap_admin_sso_exchanges",
  "ap_content_revision_log",
  "ap_content_environment_state",
  "_emdash_collections",
  "_emdash_fields",
  "revisions",
];

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

type TableNameRow = { name: string };

export const GET: APIRoute = async (context) => {
  const env = await getRuntimeEnv(context);
  const db = env.DB as D1DatabaseLike | undefined;
  const requestUrl = new URL(context.request?.url ?? "https://example.test/");
  const mode = requestUrl.searchParams.get("deep") === "1" ? "deep" : "fast";
  if (!db) {
    return json({
      status: "not_ready",
      state: "missing_d1",
      feature: "aspt-verdigris-vera-solaro.generated-site.edit-readiness",
      ready: false,
      mode,
      missingTables: requiredTables,
    }, 503);
  }

  const placeholders = requiredTables.map(() => "?").join(", ");
  const statement = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .bind(...requiredTables) as { all: () => Promise<{ results?: TableNameRow[] }> };
  const result = await statement.all();
  const existing = new Set((result.results ?? []).map((row) => row.name));
  const missingTables = requiredTables.filter((table) => !existing.has(table));
  let bootstrap = null;
  if (missingTables.length === 0) {
    bootstrap = await readAstroPagesEmDashBootstrapStatus({ env, mode });
  }
  const ready = missingTables.length === 0 && Boolean(bootstrap?.ready);

  return json({
    status: ready ? "ready" : "not_ready",
    state: ready ? "ready" : missingTables.length ? "missing_tables" : "missing_builder_content",
    feature: "aspt-verdigris-vera-solaro.generated-site.edit-readiness",
    ready,
    missingTables,
    bootstrap,
  }, ready ? 200 : 503);
};
