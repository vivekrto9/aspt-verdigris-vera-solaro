import {
  getManagedEmailTemplate,
  listEmailEvents,
  listEmailTemplateWorkspace,
  listEmailVariableMappings,
  renderManagedEmailTemplate,
  saveEmailEvent,
  saveEmailVariableMapping,
  saveManagedEmailTemplate,
} from "../aggregator/notifications/email-template-store.ts";
import type { RuntimeEnv } from "../aggregator/runtime.ts";

type JsonRpcRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type D1 = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
};

const mcpPath = "/_emdash/api/mcp";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const result = (id: unknown, data: unknown) =>
  json({
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
      ...(isRecord(data) ? { structuredContent: data } : {}),
    },
  });
const error = (id: unknown, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const tokenHash = async (value: string) =>
  base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );

const authorize = async (request: Request, env: RuntimeEnv) => {
  const token =
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const db = env.DB as D1 | undefined;
  if (!token || !db?.prepare) return false;
  const row = await db.prepare(
    "SELECT id, expires_at FROM _emdash_api_tokens WHERE token_hash = ? LIMIT 1",
  ).bind(await tokenHash(token)).first<{ id?: unknown; expires_at?: unknown }>();
  if (!row?.id) return false;
  return !(
    typeof row.expires_at === "string" &&
    Date.parse(row.expires_at) <= Date.now()
  );
};

export const projectEmailMcpTools = [
  {
    name: "email_template_list",
    description: "List this project's active preview email templates from D1.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "email_template_get",
    description: "Read one active preview email template from D1.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "email_event_list",
    description: "List this project's email event definitions from D1.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "email_event_save",
    description:
      "Create or update an active preview email event contract before saving a template for it.",
    inputSchema: {
      type: "object",
      properties: {
        eventType: { type: "string" },
        audience: { type: "string" },
        emailType: {
          enum: [
            "transactional",
            "scheduled",
            "reminder",
            "follow_up",
            "notification",
            "marketing",
          ],
        },
        schedule: { type: "object" },
      },
      required: ["eventType", "audience", "emailType"],
      additionalProperties: false,
    },
  },
  {
    name: "email_variable_catalog",
    description: "List approved safe email variable mappings from D1.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "email_variable_add_mapping",
    description: "Add an approved non-sensitive email variable mapping in D1.",
    inputSchema: {
      type: "object",
      properties: {
        variableKey: { type: "string" },
        sourceType: {
          enum: ["event_payload", "business_setting", "generated_url"],
        },
        sourcePath: { type: "string" },
        sampleValue: {},
      },
      required: ["variableKey", "sourceType", "sourcePath"],
      additionalProperties: false,
    },
  },
  {
    name: "email_template_save_preview",
    description:
      "Create or update the active preview email template. The referenced event must already exist.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        displayName: { type: "string" },
        eventType: { type: "string" },
        audience: { type: "string" },
        locale: { type: "string" },
        subject: { type: "string" },
        preheader: { type: "string" },
        htmlBody: { type: "string" },
        textBody: { type: "string" },
        requiredVariables: { type: "array", items: { type: "string" } },
        samplePayload: { type: "object" },
      },
      required: [
        "key",
        "displayName",
        "eventType",
        "audience",
        "subject",
        "htmlBody",
        "textBody",
        "requiredVariables",
        "samplePayload",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "email_template_save_draft",
    description:
      "Deprecated alias for email_template_save_preview; saves directly to the active preview template.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        displayName: { type: "string" },
        eventType: { type: "string" },
        audience: { type: "string" },
        locale: { type: "string" },
        subject: { type: "string" },
        preheader: { type: "string" },
        htmlBody: { type: "string" },
        textBody: { type: "string" },
        requiredVariables: { type: "array", items: { type: "string" } },
        samplePayload: { type: "object" },
      },
      required: [
        "key",
        "displayName",
        "eventType",
        "audience",
        "subject",
        "htmlBody",
        "textBody",
        "requiredVariables",
        "samplePayload",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "email_template_render_sample",
    description: "Validate and render the active preview template with its sample payload.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
];

const appendTools = (payload: unknown) => {
  if (
    !isRecord(payload) ||
    !isRecord(payload.result) ||
    !Array.isArray(payload.result.tools)
  ) {
    return false;
  }
  const names = new Set(
    payload.result.tools.map((tool) => isRecord(tool) ? tool.name : undefined),
  );
  payload.result.tools.push(
    ...projectEmailMcpTools.filter((tool) => !names.has(tool.name)),
  );
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
        return appendTools(payload) ? `${match[1]}${JSON.stringify(payload)}` : line;
      } catch {
        return line;
      }
    }).join("");
  } else if (body) {
    try {
      const payload = JSON.parse(body);
      if (appendTools(payload)) augmented = JSON.stringify(payload);
    } catch {
      // Preserve non-JSON downstream responses.
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

const callTool = async (
  env: RuntimeEnv,
  name: unknown,
  args: Record<string, unknown>,
) => {
  if (name === "email_template_list") return listEmailTemplateWorkspace(env);
  if (name === "email_template_get") {
    const key = String(args.key ?? "");
    return { key, live: await getManagedEmailTemplate(env, key), draft: null };
  }
  if (name === "email_event_list") return listEmailEvents(env);
  if (name === "email_event_save") return saveEmailEvent(env, args);
  if (name === "email_variable_catalog") return listEmailVariableMappings(env);
  if (name === "email_variable_add_mapping") {
    return saveEmailVariableMapping(env, args);
  }
  if (
    name === "email_template_save_preview" ||
    name === "email_template_save_draft"
  ) {
    const saved = await saveManagedEmailTemplate({
      env,
      input: args,
      actor: "openhands",
    });
    if (!saved.ok) throw new Error(saved.message);
    return saved.template;
  }
  if (name === "email_template_render_sample") {
    const rendered = await renderManagedEmailTemplate({
      env,
      key: String(args.key ?? ""),
    });
    if (!rendered.ok) throw new Error(rendered.message);
    return rendered;
  }
  throw new Error("Unknown email template tool.");
};

export const maybeHandleEmailTemplatesMcp = async (
  request: Request,
  env: RuntimeEnv,
  downstream: () => Promise<Response>,
) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== mcpPath) return null;
  const rpc = await request.clone().json().catch(() => null) as JsonRpcRequest | null;
  if (!isRecord(rpc)) return null;
  if (rpc.method === "tools/list") {
    return augmentToolsListResponse(await downstream());
  }
  if (
    rpc.method !== "tools/call" ||
    !isRecord(rpc.params) ||
    !String(rpc.params.name ?? "").startsWith("email_")
  ) {
    return null;
  }
  if (!(await authorize(request, env))) {
    return error(rpc.id, -32001, "unauthorized", 401);
  }
  try {
    return result(
      rpc.id,
      await callTool(
        env,
        rpc.params.name,
        isRecord(rpc.params.arguments) ? rpc.params.arguments : {},
      ),
    );
  } catch (caught) {
    return error(
      rpc.id,
      -32000,
      caught instanceof Error ? caught.message : "Email template tool failed.",
    );
  }
};
