import {
  listAssets,
  type AssetRuntimeEnv,
} from "./project-assets.ts";

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type D1 = { prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } } };
const mcpPath = "/_emdash/api/mcp";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
export const projectAssetMcpResult = (id: unknown, data: unknown) => json({
  jsonrpc: "2.0",
  id: id ?? null,
  result: {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
  },
});
const error = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
const base64Url = (bytes: Uint8Array) => { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); };
const tokenHash = async (value: string) => base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";

const authorize = async (request: Request, env: AssetRuntimeEnv) => {
  const token = bearer(request);
  const db = env.DB as D1 | undefined;
  if (!token || !db?.prepare) return false;
  const row = await db.prepare("SELECT id, expires_at FROM _emdash_api_tokens WHERE token_hash = ? LIMIT 1").bind(await tokenHash(token)).first<{ id?: unknown; expires_at?: unknown }>();
  if (!row?.id) return false;
  return !(typeof row.expires_at === "string" && Date.parse(row.expires_at) <= Date.now());
};

const tools = [
  { name: "asset_list", description: "List the project's active R2-backed assets and stable URLs.", inputSchema: { type: "object", properties: { search: { type: "string" }, includeDeleted: { type: "boolean" } }, additionalProperties: false } },
  { name: "asset_get", description: "Get one project asset by its opaque stable asset ID.", inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"], additionalProperties: false } },
  { name: "asset_create", description: "Create an AI-origin project asset from base64 bytes (maximum 10 MB).", inputSchema: { type: "object", properties: { fileName: { type: "string" }, mimeType: { type: "string" }, base64: { type: "string" }, displayName: { type: "string" }, alias: { type: "string" }, altText: { type: "string" } }, required: ["fileName", "mimeType", "base64"], additionalProperties: false } },
  { name: "asset_import_url", description: "Import a public HTTPS media URL into the project's R2 asset library (maximum 10 MB).", inputSchema: { type: "object", properties: { url: { type: "string" }, displayName: { type: "string" }, alias: { type: "string" }, altText: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "asset_update", description: "Update asset metadata or optional aliases without changing site structure.", inputSchema: { type: "object", properties: { assetId: { type: "string" }, displayName: { type: "string" }, folder: { type: ["string", "null"] }, category: { type: ["string", "null"] }, altText: { type: ["string", "null"] }, caption: { type: ["string", "null"] }, aliases: { type: "array", items: { type: "string" } } }, required: ["assetId"], additionalProperties: false } },
  { name: "asset_replace", description: "Create an immutable replacement revision while preserving the stable asset ID.", inputSchema: { type: "object", properties: { assetId: { type: "string" }, expectedRevisionId: { type: "string" }, fileName: { type: "string" }, mimeType: { type: "string" }, base64: { type: "string" }, altText: { type: "string" } }, required: ["assetId", "expectedRevisionId", "fileName", "mimeType", "base64"], additionalProperties: false } },
  { name: "asset_delete", description: "Soft-delete an unprotected asset after Control Plane usage checks.", inputSchema: { type: "object", properties: { assetId: { type: "string" }, force: { type: "boolean", description: "Confirm deletion when code usage is uncertain." } }, required: ["assetId"], additionalProperties: false } },
  { name: "asset_restore", description: "Restore a soft-deleted project asset using its same stable identity.", inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"], additionalProperties: false } },
];

const appendAssetTools = (payload: unknown) => {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) return false;
  const names = new Set(payload.result.tools.map((tool) => isRecord(tool) ? tool.name : undefined));
  payload.result.tools.push(...tools.filter((tool) => !names.has(tool.name)));
  return true;
};

const augmentToolsListResponse = async (response: Response) => {
  if (!response.ok) return response;
  const body = await response.text();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let augmented = body;

  if (contentType.includes("text/event-stream")) {
    augmented = body.split(/(\r?\n)/).map((line) => {
      const match = line.match(/^(\s*data:\s*)(.+)$/);
      if (!match) return line;
      try {
        const payload = JSON.parse(match[2]);
        return appendAssetTools(payload) ? `${match[1]}${JSON.stringify(payload)}` : line;
      } catch {
        return line;
      }
    }).join("");
  } else if (body) {
    try {
      const payload = JSON.parse(body);
      if (appendAssetTools(payload)) augmented = JSON.stringify(payload);
    } catch {
      // Preserve non-JSON downstream responses while returning a fresh body.
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(augmented || null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const decode = (value: unknown) => {
  if (typeof value !== "string" || value.length > 14_000_000) throw new Error("Asset base64 payload is invalid or larger than 10 MB.");
  const binary = atob(value.replace(/^data:[^,]+,/, ""));
  if (binary.length > 10 * 1024 * 1024) throw new Error("AI asset writes are limited to 10 MB.");
  const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif", "image/svg+xml", "application/pdf", "audio/mpeg", "audio/ogg", "video/mp4", "video/webm"]);
const safeFile = (value: unknown) => typeof value === "string" ? value.split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "asset" : "asset";
const assertPublicImportUrl = (value: string) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("A public HTTPS URL is required.");
  if (!hostname || /(^|\.)(localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname)) throw new Error("A public HTTPS URL is required.");
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) || a >= 224) throw new Error("A public HTTPS URL is required.");
  }
  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) || hostname.startsWith("ff") || hostname === "2001:db8" ||
      hostname.startsWith("2001:db8:") || hostname.startsWith("::ffff:")) throw new Error("A public HTTPS URL is required.");
  }
  return url;
};
const opaque = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
};
const r2 = (env: AssetRuntimeEnv) => {
  const media = env.MEDIA as { put?(key: string, value: Uint8Array, options?: unknown): Promise<{ httpEtag?: string } | null> } | undefined;
  if (!media?.put) throw new Error("Project R2 media binding is not configured.");
  return media;
};

const controlPlaneCall = async (env: AssetRuntimeEnv, mutation: Record<string, unknown>) => {
  const baseUrl = typeof env.ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL === "string" ? env.ASTROPAGES_CONTROL_PLANE_CALLBACK_BASE_URL.trim() : "";
  const projectId = typeof env.ASTROPAGES_PROJECT_ID === "string" ? env.ASTROPAGES_PROJECT_ID.trim() : "";
  const token = typeof env.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN === "string" ? env.ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN.trim() : "";
  if (!baseUrl || !projectId || !token) throw new Error("Control Plane project asset callback is not configured.");
  const response = await fetch(new URL(`/callback/project-assets/${encodeURIComponent(projectId)}/mutations`, baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const payload = await response.json().catch(() => ({})) as { data?: unknown; message?: unknown };
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : `Control Plane asset mutation failed (${response.status}).`);
  return payload.data;
};

const createRevision = async (env: AssetRuntimeEnv, args: Record<string, unknown>, existing?: Awaited<ReturnType<typeof listAssets>>[number]) => {
  const bytes = decode(args.base64);
  const mimeType = typeof args.mimeType === "string" ? args.mimeType.toLowerCase() : "";
  if (!allowed.has(mimeType)) throw new Error("Unsupported AI project asset type.");
  if (mimeType === "image/svg+xml") {
    const svg = new TextDecoder().decode(bytes);
    if (!/<svg[\s>]/i.test(svg) || /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:text\/html)/i.test(svg)) throw new Error("SVG contains unsafe active or remote content.");
  }
  const assetId = existing?.assetId ?? opaque("asset");
  const revisionId = opaque("arev");
  const fileName = safeFile(args.fileName);
  const storageKey = `assets/${assetId}/revisions/${revisionId}/${fileName}`;
  const stored = await r2(env).put!(storageKey, bytes, { httpMetadata: { contentType: mimeType } });
  await controlPlaneCall(env, {
    operation: "register", assetId, revisionId, expectedRevisionId: existing?.revisionId,
    storageKey, fileName, mimeType, sizeBytes: bytes.byteLength,
    displayName: typeof args.displayName === "string" ? args.displayName : existing?.displayName ?? fileName,
    altText: typeof args.altText === "string" ? args.altText : existing?.altText,
    aliases: typeof args.alias === "string" ? [args.alias] : existing?.aliases,
    uploadEtag: stored?.httpEtag,
  });
  return (await listAssets({ env, includeDeleted: true })).find((item) => item.assetId === assetId);
};

const callTool = async (env: AssetRuntimeEnv, name: unknown, args: Record<string, unknown>) => {
  if (name === "asset_list") return listAssets({ env, includeDeleted: args.includeDeleted === true, search: typeof args.search === "string" ? args.search : undefined });
  if (name === "asset_get") return (await listAssets({ env, includeDeleted: true })).find((item) => item.assetId === args.assetId) ?? null;
  if (name === "asset_create") return createRevision(env, args);
  if (name === "asset_replace") {
    const existing = (await listAssets({ env })).find((item) => item.assetId === args.assetId);
    if (!existing || existing.revisionId !== args.expectedRevisionId) throw new Error("Asset revision conflict: refresh and try again.");
    return createRevision(env, args, existing);
  }
  if (name === "asset_import_url") {
    if (typeof args.url !== "string") throw new Error("A public HTTPS URL is required.");
    const url = assertPublicImportUrl(args.url);
    const response = await fetch(url, { redirect: "error", headers: { accept: [...allowed].join(",") } });
    const length = Number(response.headers.get("content-length") ?? 0); if (!response.ok || length > 10 * 1024 * 1024) throw new Error("Remote asset could not be imported or is larger than 10 MB.");
    const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Remote asset is larger than 10 MB.");
    return createRevision(env, { ...args, fileName: safeFile(url.pathname), mimeType: response.headers.get("content-type")?.split(";")[0] ?? "", base64: encodeBase64(bytes) });
  }
  if (name === "asset_update") return controlPlaneCall(env, { ...args, operation: "update", assetId: String(args.assetId ?? "") });
  if (name === "asset_delete") return controlPlaneCall(env, { operation: "delete", assetId: String(args.assetId ?? ""), force: args.force === true });
  if (name === "asset_restore") return controlPlaneCall(env, { operation: "restore", assetId: String(args.assetId ?? "") });
  throw new Error("Unknown project asset tool.");
};

export const maybeHandleProjectAssetsMcp = async (request: Request, env: AssetRuntimeEnv, downstream: () => Promise<Response>) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== mcpPath) return null;
  const rpc = await request.clone().json().catch(() => null) as JsonRpcRequest | null;
  if (!isRecord(rpc)) return null;
  if (rpc.method === "tools/list") {
    return augmentToolsListResponse(await downstream());
  }
  if (rpc.method !== "tools/call" || !isRecord(rpc.params) || !String(rpc.params.name ?? "").startsWith("asset_")) return null;
  if (!(await authorize(request, env))) return error(rpc.id, -32001, "unauthorized", 401);
  try {
    return projectAssetMcpResult(rpc.id, await callTool(env, rpc.params.name, isRecord(rpc.params.arguments) ? rpc.params.arguments : {}));
  } catch (caught) {
    return error(rpc.id, -32000, caught instanceof Error ? caught.message : "Project asset tool failed.");
  }
};

export const projectAssetMcpTools = tools;
