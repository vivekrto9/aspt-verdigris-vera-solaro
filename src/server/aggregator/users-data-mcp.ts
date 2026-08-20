import type { AnalyticsQueryDb } from "./analytics-query.ts";
import { authorizeMcpBearerToken } from "./analytics-mcp.ts";
import usersDataManifest from "../../../astropages/users-data.manifest.json" with { type: "json" };

export const usersDataMcpMethods = [
  "users_schema",
  "users_list",
  "users_get",
  "users_related",
] as const;

export type UsersDataMcpMethod = (typeof usersDataMcpMethods)[number];

export class UsersDataMcpMethodError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_USERS_DATA_ARGUMENTS") {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const allRows = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) =>
  (await db.prepare(sql).bind(...values).all?.<Record<string, unknown>>())?.results ?? [];

const firstRow = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) =>
  await db.prepare(sql).bind(...values).first?.<Record<string, unknown>>() ?? null;

const listColumns = [
  "id",
  "display_name",
  "email",
  "phone",
  "default_language",
  "email_verified_at",
  "created_at",
  "updated_at",
] as const;

const searchableColumns = ["display_name", "email", "phone"] as const;
const sortableColumns = new Set([
  "display_name",
  "email",
  "default_language",
  "email_verified_at",
  "created_at",
  "updated_at",
]);

type RelatedSectionDef = {
  key: string;
  title: string;
  columns: unknown[];
};

const relatedSectionsDef: RelatedSectionDef[] = usersDataManifest.relatedSections as unknown as RelatedSectionDef[];

const schema = () => ({
  contract: "users-data.v1" as const,
  method: "users_schema" as const,
  schemaRevision: usersDataManifest.schemaRevision,
  entity: usersDataManifest.entity,
  columns: usersDataManifest.columns,
  detailFields: usersDataManifest.detailFields,
  defaultSort: usersDataManifest.defaultSort,
  relatedSections: usersDataManifest.relatedSections,
});

const listUsers = async (db: AnalyticsQueryDb, rawArguments: unknown) => {
  const input = isRecord(rawArguments) ? rawArguments : {};
  const page = typeof input.page === "number" && Number.isInteger(input.page)
    ? Math.max(1, input.page)
    : 1;
  const pageSize = typeof input.pageSize === "number" && Number.isInteger(input.pageSize)
    ? Math.min(100, Math.max(1, input.pageSize))
    : 25;
  const search = optionalString(input.search)?.slice(0, 200) ?? "";
  const requestedSort = optionalString(input.sort);
  const sort = requestedSort && sortableColumns.has(requestedSort)
    ? requestedSort
    : usersDataManifest.defaultSort.field;
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const where = search
    ? `WHERE ${searchableColumns.map((column) => `${column} LIKE ?`).join(" OR ")}`
    : "";
  const searchValues = search ? searchableColumns.map(() => `%${search}%`) : [];
  const offset = (page - 1) * pageSize;
  const [count, rows] = await Promise.all([
    firstRow(db, `SELECT COUNT(*) AS value FROM ap_customer_accounts ${where}`, searchValues),
    allRows(
      db,
      `SELECT ${listColumns.join(", ")} FROM ap_customer_accounts ${where} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      [...searchValues, pageSize, offset],
    ),
  ]);
  const total = Number(count?.value ?? 0);
  return {
    contract: "users-data.v1" as const,
    method: "users_list" as const,
    schema: schema(),
    rows,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

const relatedRows = async (db: AnalyticsQueryDb, userId: string, sectionKey: string) => {
  if (sectionKey === "bookings") {
    return allRows(
      db,
      `SELECT booking.booking_number, service.name AS service_name, booking.mode,
              booking.status, booking.payment_state, booking.selected_start_at,
              booking.price_cents, booking.paid_cents, booking.balance_cents,
              booking.currency, booking.created_at
       FROM ap_vera_bookings booking
       JOIN ap_vera_services service ON service.slug = booking.service_slug
       WHERE booking.account_id = ?
       ORDER BY booking.selected_start_at DESC
       LIMIT 100`,
      [userId],
    );
  }
  if (sectionKey === "reports") {
    return allRows(
      db,
      `SELECT booking.booking_number, report.title, report.status, report.published_at
       FROM ap_vera_reports report
       JOIN ap_vera_bookings booking ON booking.id = report.booking_id
       WHERE report.account_id = ?
       ORDER BY COALESCE(report.published_at, report.created_at) DESC
       LIMIT 100`,
      [userId],
    );
  }
  if (sectionKey === "files") {
    return allRows(
      db,
      `SELECT booking.booking_number, file.kind, file.file_name, file.content_type,
              file.size_bytes, file.created_at
       FROM ap_vera_private_files file
       LEFT JOIN ap_vera_bookings booking ON booking.id = file.booking_id
       WHERE file.account_id = ?
       ORDER BY file.created_at DESC
       LIMIT 100`,
      [userId],
    );
  }
  if (sectionKey === "messages") {
    return allRows(
      db,
      `SELECT booking.booking_number, thread.subject, thread.status, thread.updated_at
       FROM ap_vera_message_threads thread
       LEFT JOIN ap_vera_bookings booking ON booking.id = thread.booking_id
       WHERE thread.account_id = ?
       ORDER BY thread.updated_at DESC
       LIMIT 100`,
      [userId],
    );
  }
  if (sectionKey === "invoices") {
    return allRows(
      db,
      `SELECT invoice.invoice_number, booking.booking_number, invoice.status,
              invoice.amount_cents, invoice.currency, invoice.issued_at
       FROM ap_vera_invoices invoice
       JOIN ap_vera_bookings booking ON booking.id = invoice.booking_id
       WHERE booking.account_id = ?
       ORDER BY invoice.issued_at DESC
       LIMIT 100`,
      [userId],
    );
  }
  throw new UsersDataMcpMethodError(`Unsupported related section ${sectionKey}`);
};

const getUser = async (db: AnalyticsQueryDb, rawArguments: unknown) => {
  if (!isRecord(rawArguments)) throw new UsersDataMcpMethodError("User arguments are required");
  const userId = optionalString(rawArguments.userId);
  if (!userId) throw new UsersDataMcpMethodError("userId is required");
  const user = await firstRow(
    db,
    `SELECT ${listColumns.join(", ")} FROM ap_customer_accounts WHERE id = ? LIMIT 1`,
    [userId],
  );
  if (!user) throw new UsersDataMcpMethodError("User not found", "USER_NOT_FOUND");
  const relatedSections = await Promise.all(relatedSectionsDef.map(async (section) => ({
    key: section.key,
    title: section.title,
    columns: section.columns,
    rows: await relatedRows(db, userId, section.key),
  })));
  return {
    contract: "users-data.v1" as const,
    method: "users_get" as const,
    schema: schema(),
    userId,
    user,
    relatedSections,
  };
};

const getRelated = async (db: AnalyticsQueryDb, rawArguments: unknown) => {
  if (!isRecord(rawArguments)) throw new UsersDataMcpMethodError("Related-record arguments are required");
  const userId = optionalString(rawArguments.userId);
  const sectionKey = optionalString(rawArguments.sectionKey);
  if (!userId || !sectionKey) throw new UsersDataMcpMethodError("userId and sectionKey are required");
  const section = relatedSectionsDef.find((candidate) => candidate.key === sectionKey);
  if (!section) throw new UsersDataMcpMethodError(`Unsupported related section ${sectionKey}`);
  return {
    contract: "users-data.v1" as const,
    method: "users_related" as const,
    userId,
    section: {
      key: section.key,
      title: section.title,
      columns: section.columns,
      rows: await relatedRows(db, userId, sectionKey),
    },
  };
};

export const executeUsersDataMcpMethod = async (
  db: AnalyticsQueryDb | undefined,
  method: UsersDataMcpMethod,
  rawArguments: unknown,
) => {
  if (!db) throw new UsersDataMcpMethodError("D1 is unavailable", "USERS_DATA_UNAVAILABLE");
  if (method === "users_schema") return schema();
  if (method === "users_list") return listUsers(db, rawArguments);
  if (method === "users_get") return getUser(db, rawArguments);
  return getRelated(db, rawArguments);
};

type UsersDataJsonRpcRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

const usersDataMcpPath = "/_emdash/api/mcp";

const usersDataDbFromEnv = (env: unknown): AnalyticsQueryDb | undefined => {
  if (!isRecord(env)) return undefined;
  const candidate = env.DB;
  return isRecord(candidate) && typeof candidate.prepare === "function"
    ? candidate as AnalyticsQueryDb
    : undefined;
};

const usersDataJson = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const usersDataJsonRpcError = (id: unknown, code: number, message: string, status = 200) =>
  usersDataJson({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

export const maybeHandleUsersDataMcpToolCall = async (
  request: Request,
  env: unknown,
) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== usersDataMcpPath) return null;

  const parsed = await request.clone().json().catch(() => null);
  if (!isRecord(parsed)) return null;
  const rpc = parsed as UsersDataJsonRpcRequest;
  if (rpc.method !== "tools/call" || !isRecord(rpc.params)) return null;
  const name = typeof rpc.params.name === "string" ? rpc.params.name : "";
  if (!usersDataMcpMethods.includes(name as UsersDataMcpMethod)) return null;

  const db = usersDataDbFromEnv(env);
  const authorization = await authorizeMcpBearerToken(request, db, "users:read");
  if (authorization === "unauthorized") {
    return usersDataJsonRpcError(rpc.id, -32001, "unauthorized", 401);
  }
  if (authorization === "forbidden") {
    return usersDataJsonRpcError(rpc.id, -32003, "forbidden: users:read scope is required", 403);
  }

  const argumentsValue = isRecord(rpc.params.arguments) ? rpc.params.arguments : {};
  try {
    const result = await executeUsersDataMcpMethod(db, name as UsersDataMcpMethod, argumentsValue);
    return usersDataJson({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      },
    });
  } catch (error) {
    const code = error instanceof UsersDataMcpMethodError
      ? error.code
      : "USERS_DATA_QUERY_EXECUTION_FAILED";
    const message = error instanceof Error ? error.message : "Users Data MCP method failed";
    const structuredContent = { error: true, code, message };
    return usersDataJson({
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
