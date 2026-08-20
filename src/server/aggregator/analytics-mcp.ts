import { answerAnalyticsQuery, type AnalyticsQueryDb } from "./analytics-query.ts";
import { executeSalesMcpMethod, SalesMcpMethodError, salesMcpMethods, type SalesMcpMethod } from "./sales-mcp.ts";

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type TokenRow = {
  id?: unknown;
  scopes?: unknown;
  expires_at?: unknown;
};

export type McpBearerAuthorization = "authorized" | "unauthorized" | "forbidden";

const mcpPath = "/_emdash/api/mcp";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (body: Record<string, unknown>, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(headers ?? {}),
    },
  });

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const sha256Base64Url = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
};

const readBearerToken = (request: Request) => {
  const authorization = request.headers.get("Authorization") || "";
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : "";
};

const toolName = (body: JsonRpcRequest) => {
  if (body.method !== "tools/call" || !isRecord(body.params)) {
    return undefined;
  }
  return typeof body.params.name === "string" ? body.params.name : undefined;
};

const dbFromEnv = (env: unknown): AnalyticsQueryDb | undefined => {
  if (!isRecord(env)) {
    return undefined;
  }
  const candidate = env.DB;
  return isRecord(candidate) && typeof candidate.prepare === "function"
    ? candidate as AnalyticsQueryDb
    : undefined;
};

const readJsonRpcRequest = async (request: Request): Promise<JsonRpcRequest | null> => {
  const body = await request.clone().json().catch(() => null);
  return isRecord(body) ? body : null;
};

const storedTokenScopes = (value: unknown) => {
  if (Array.isArray(value)) {
    return new Set(value.filter((scope): scope is string => typeof scope === "string"));
  }
  if (typeof value !== "string") return new Set<string>();
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((scope): scope is string => typeof scope === "string"));
    }
  } catch {
    // Older EmDash tokens may store a single scope or a comma-separated list.
  }
  return new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean));
};

export const authorizeMcpBearerToken = async (
  request: Request,
  db: AnalyticsQueryDb | undefined,
  requiredScope: string,
): Promise<McpBearerAuthorization> => {
  const token = readBearerToken(request);
  if (!token || !db) {
    return "unauthorized";
  }
  const tokenHash = await sha256Base64Url(token);
  const row = await db.prepare(
    "SELECT id, scopes, expires_at FROM _emdash_api_tokens WHERE token_hash = ? LIMIT 1",
  ).bind(tokenHash).first?.<TokenRow>();
  if (!row?.id) {
    return "unauthorized";
  }
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at : "";
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    return "unauthorized";
  }

  const scopes = storedTokenScopes(row.scopes);
  return scopes.has(requiredScope) || scopes.has("*") ? "authorized" : "forbidden";
};

const authorizationError = (rpc: JsonRpcRequest, authorization: McpBearerAuthorization) =>
  authorization === "forbidden"
    ? jsonRpcError(rpc.id, -32003, "forbidden: analytics:read scope is required", 403)
    : jsonRpcError(rpc.id, -32001, "unauthorized", 401);

const jsonRpcError = (id: unknown, code: number, message: string, status = 200) =>
  json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  }, status);

const analyticsToolResult = async (
  request: Request,
  env: unknown,
  rpc: JsonRpcRequest,
) => {
  const params = isRecord(rpc.params) ? rpc.params : {};
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  const question = typeof argumentsValue.question === "string" ? argumentsValue.question.trim() : "";
  if (!question) {
    return jsonRpcError(rpc.id, -32602, "analytics_query.question is required");
  }

  const db = dbFromEnv(env);
  const authorization = await authorizeMcpBearerToken(request, db, "analytics:read");
  if (authorization !== "authorized") return authorizationError(rpc, authorization);

  try {
    const result = await answerAnalyticsQuery({
      db,
      question,
      projectId: typeof argumentsValue.projectId === "string" ? argumentsValue.projectId : undefined,
      timezone: typeof argumentsValue.timezone === "string" ? argumentsValue.timezone : undefined,
      now: typeof argumentsValue.now === "string" ? argumentsValue.now : undefined,
    });

    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        structuredContent: result,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "analytics_query failed";
    return jsonRpcError(rpc.id, -32000, message);
  }
};

const salesToolResult = async (
  request: Request,
  env: unknown,
  rpc: JsonRpcRequest,
  method: SalesMcpMethod,
) => {
  const params = isRecord(rpc.params) ? rpc.params : {};
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  const db = dbFromEnv(env);
  const authorization = await authorizeMcpBearerToken(request, db, "analytics:read");
  if (authorization !== "authorized") return authorizationError(rpc, authorization);
  try {
    const result = await executeSalesMcpMethod(db, method, argumentsValue);
    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      },
    });
  } catch (error) {
    const code = error instanceof SalesMcpMethodError ? error.code : "SALES_QUERY_EXECUTION_FAILED";
    const message = error instanceof Error ? error.message : "Sales MCP method failed";
    const structuredContent = { error: true, code, message };
    return json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      },
    });
  }
};

export const maybeHandleAnalyticsMcpToolCall = async (
  request: Request,
  env: unknown,
) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== mcpPath) {
    return null;
  }

  const rpc = await readJsonRpcRequest(request);
  if (!rpc) {
    return null;
  }
  const name = toolName(rpc);
  if (name === "analytics_query") return analyticsToolResult(request, env, rpc);
  if (salesMcpMethods.includes(name as SalesMcpMethod)) {
    return salesToolResult(request, env, rpc, name as SalesMcpMethod);
  }
  return null;
};
