import type { AnalyticsQueryDb } from "./analytics-query.ts";
import salesManifest from "../../../astropages/sales.manifest.json" with { type: "json" };

export const salesMcpMethods = [
  "sales_schema",
  "sales_resolve_entity",
  "sales_metric",
  "sales_breakdown",
  "sales_trend",
  "sales_compare",
  "sales_transactions",
] as const;

export type SalesMcpMethod = (typeof salesMcpMethods)[number];

const metricNames = [
  "gross_revenue",
  "net_revenue",
  "refunded_amount",
  "successful_sales",
  "pending_sales",
  "failed_sales",
  "cancelled_sales",
  "average_sale_value",
  "transaction_count",
] as const;

type MetricName = (typeof metricNames)[number];
type Range = { from: string; to: string };
type Filters = {
  currency?: string;
  transactionKind?: string;
  paymentStatus?: string;
  dimension?: string;
  dimensionValue?: string;
};
type Arguments = {
  metric?: MetricName;
  range: Range;
  filters?: Filters;
  groupBy?: string;
  interval?: "day" | "week" | "month";
  comparisonRange?: Range;
  sort?: "asc" | "desc";
  limit?: number;
};

type SalesEntity = {
  type: string;
  key: string;
  label: string;
  transactionKind?: string;
};

export class SalesMcpMethodError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const paidStatuses = ["paid", "captured", "succeeded", "completed"];
const transactionKindKeys = new Set(salesManifest.transactionKinds.map((kind) => kind.key));
const paymentStatusKeys = new Set(salesManifest.paymentStatuses);
const filterDimensionKeys = new Set([
  "transaction_kind",
  "item",
  "payment_provider",
  "payment_status",
  "business_status",
  "fulfillment_status",
  ...salesManifest.dimensions.map((dimension) => dimension.key),
]);

const rangeFrom = (value: unknown): Range => {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string" ||
      !isoDate.test(value.from) || !isoDate.test(value.to) || value.from > value.to) {
    throw new SalesMcpMethodError("A valid inclusive YYYY-MM-DD range is required", "INVALID_SALES_ARGUMENTS");
  }
  return { from: value.from, to: value.to };
};

const toExclusive = (to: string) => {
  const value = new Date(`${to}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const argumentsFrom = (value: unknown): Arguments => {
  if (!isRecord(value)) throw new SalesMcpMethodError("Sales method arguments are required", "INVALID_SALES_ARGUMENTS");
  const args: Arguments = { range: rangeFrom(value.range) };
  const metric = optionalString(value.metric);
  if (metric) {
    if (!metricNames.includes(metric as MetricName)) throw new SalesMcpMethodError(`Unsupported Sales metric ${metric}`, "UNSUPPORTED_SALES_METRIC");
    args.metric = metric as MetricName;
  }
  if (isRecord(value.filters)) {
    const filters: Filters = {};
    const currency = optionalString(value.filters.currency)?.toUpperCase();
    const transactionKind = optionalString(value.filters.transactionKind)?.toLowerCase();
    const paymentStatus = optionalString(value.filters.paymentStatus)?.toLowerCase();
    const dimension = optionalString(value.filters.dimension)?.toLowerCase();
    const dimensionValue = optionalString(value.filters.dimensionValue);
    if (currency) filters.currency = currency;
    if (transactionKind && transactionKind !== "all") {
      if (!transactionKindKeys.has(transactionKind)) {
        throw new SalesMcpMethodError(`Unsupported Sales transaction kind ${transactionKind}`, "INVALID_SALES_ARGUMENTS");
      }
      filters.transactionKind = transactionKind;
    }
    if (paymentStatus) {
      if (!paymentStatusKeys.has(paymentStatus)) {
        throw new SalesMcpMethodError(`Unsupported Sales payment status ${paymentStatus}`, "INVALID_SALES_ARGUMENTS");
      }
      filters.paymentStatus = paymentStatus;
    }
    if (dimension) {
      if (!filterDimensionKeys.has(dimension)) {
        throw new SalesMcpMethodError(`Unsupported Sales dimension ${dimension}`, "UNSUPPORTED_SALES_DIMENSION");
      }
      filters.dimension = dimension;
    }
    if (dimensionValue) filters.dimensionValue = dimensionValue;
    if (Object.keys(filters).length) args.filters = filters;
  }
  const groupBy = optionalString(value.groupBy)?.toLowerCase();
  if (groupBy) args.groupBy = groupBy;
  if (value.interval === "day" || value.interval === "week" || value.interval === "month") args.interval = value.interval;
  if (value.comparisonRange !== undefined && value.comparisonRange !== null) args.comparisonRange = rangeFrom(value.comparisonRange);
  if (value.sort === "asc" || value.sort === "desc") args.sort = value.sort;
  if (typeof value.limit === "number" && Number.isInteger(value.limit)) args.limit = Math.min(100, Math.max(1, value.limit));
  return args;
};

const allRows = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) =>
  (await db.prepare(sql).bind(...values).all?.<Record<string, unknown>>())?.results ?? [];

const firstRow = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) =>
  await db.prepare(sql).bind(...values).first?.<Record<string, unknown>>() ?? {};

const builtInDimensions = [
  { key: "transaction_kind", label: "Transaction type", description: "The canonical payable business flow.", keyColumn: "kind_key", labelColumn: "kind_label" },
  { key: "item", label: "Consultation service", description: "The Vera Solaro consultation service.", keyColumn: "item_key", labelColumn: "item_label" },
  { key: "payment_provider", label: "Payment provider", keyColumn: "payment_provider", labelColumn: "payment_provider" },
  { key: "payment_status", label: "Payment status", keyColumn: "payment_status", labelColumn: "payment_status" },
  { key: "business_status", label: "Business status", keyColumn: "business_status", labelColumn: "business_status" },
  { key: "fulfillment_status", label: "Fulfilment status", keyColumn: "fulfillment_status", labelColumn: "fulfillment_status" },
] as const;

const salesSchema = async (db: AnalyticsQueryDb) => {
  const [currencies, statuses, customDimensions] = await Promise.all([
    allRows(db, "SELECT DISTINCT currency FROM ap_sales_transactions_v1 WHERE currency IS NOT NULL AND currency <> '' ORDER BY currency"),
    allRows(db, "SELECT DISTINCT payment_status AS status FROM ap_sales_transactions_v1 WHERE payment_status IS NOT NULL AND payment_status <> '' ORDER BY status"),
    allRows(db, "SELECT dimension_key AS key, MAX(dimension_label) AS label FROM ap_sales_dimensions_v1 WHERE dimension_key NOT GLOB '*email*' AND dimension_key NOT GLOB '*phone*' AND dimension_key NOT GLOB '*address*' GROUP BY dimension_key ORDER BY label"),
  ]);
  return {
    contract: "sales-mcp.v1" as const,
    semanticModel: "commerce.v1" as const,
    schemaRevision: salesManifest.schemaRevision,
    metrics: [...metricNames],
    currencies: currencies.map((row) => String(row.currency)),
    transactionKinds: salesManifest.transactionKinds,
    dimensions: [
      ...builtInDimensions.map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        ...(Object.hasOwn(dimension, "description") ? { description: (dimension as { description: string }).description } : {}),
      })),
      ...salesManifest.dimensions.filter((dimension) => !builtInDimensions.some((item) => item.key === dimension.key)),
      ...customDimensions
        .filter((row) => !salesManifest.dimensions.some((item) => item.key === String(row.key)))
        .map((row) => ({ key: String(row.key), label: String(row.label) })),
    ],
    paymentStatuses: [...new Set([
      ...salesManifest.paymentStatuses,
      ...statuses.map((row) => String(row.status)),
    ])].sort(),
    entityTypes: [
      { key: "item", label: "Consultation service", description: "One of Vera Solaro's three consultation services." },
    ],
  };
};

const normalizeSearch = (value: string) => value
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const editDistance = (left: string, right: string) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
};

const similarity = (query: string, entity: SalesEntity) => {
  const normalizedQuery = normalizeSearch(query);
  const candidates = [entity.key, entity.label].map(normalizeSearch).filter(Boolean);
  return Math.max(...candidates.map((candidate) => {
    if (candidate === normalizedQuery) return 1;
    if (candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)) return 0.92;
    return 1 - editDistance(normalizedQuery, candidate) / Math.max(normalizedQuery.length, candidate.length, 1);
  }));
};

const salesResolveEntity = (rawArguments: unknown) => {
  if (!isRecord(rawArguments)) throw new SalesMcpMethodError("Entity resolver arguments are required", "INVALID_SALES_ARGUMENTS");
  const type = optionalString(rawArguments.entityType)?.toLowerCase();
  const query = optionalString(rawArguments.query);
  const transactionKind = optionalString(rawArguments.transactionKind)?.toLowerCase();
  if (!type || !query || type !== "item") {
    throw new SalesMcpMethodError("A supported entityType and query are required", "INVALID_SALES_ARGUMENTS");
  }
  const ranked = (salesManifest.entities as SalesEntity[])
    .filter((entity) => entity.type === type && (!transactionKind || entity.transactionKind === transactionKind))
    .map((entity) => ({ ...entity, score: similarity(query, entity) }))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
  const best = ranked[0];
  if (!best || best.score < 0.58) {
    return { contract: "sales-mcp.v1", method: "sales_resolve_entity", status: "not_found", query, entityType: type, matches: [] };
  }
  const matches = ranked.filter((entity) => entity.score >= Math.max(0.58, best.score - 0.08)).slice(0, 5);
  return {
    contract: "sales-mcp.v1",
    method: "sales_resolve_entity",
    status: matches.length === 1 ? "matched" : "ambiguous",
    query,
    entityType: type,
    matches,
  };
};

const metricSql = (metric: MetricName) => {
  const paid = `LOWER(t.payment_status) IN (${paidStatuses.map(() => "?").join(", ")})`;
  if (metric === "gross_revenue") return { expression: `COALESCE(SUM(CASE WHEN ${paid} THEN t.amount_minor ELSE 0 END), 0)`, unit: "minor_currency" as const, dateColumn: "paid_at", leading: paidStatuses };
  if (metric === "net_revenue") return { expression: `COALESCE(SUM(CASE WHEN ${paid} THEN t.amount_minor - t.refunded_minor ELSE 0 END), 0)`, unit: "minor_currency" as const, dateColumn: "paid_at", leading: paidStatuses };
  if (metric === "refunded_amount") return { expression: `COALESCE(SUM(CASE WHEN ${paid} THEN t.refunded_minor ELSE 0 END), 0)`, unit: "minor_currency" as const, dateColumn: "paid_at", leading: paidStatuses };
  if (metric === "average_sale_value") return { expression: `COALESCE(AVG(CASE WHEN ${paid} THEN t.amount_minor END), 0)`, unit: "minor_currency" as const, dateColumn: "paid_at", leading: paidStatuses };
  if (metric === "successful_sales") return { expression: `SUM(CASE WHEN ${paid} THEN 1 ELSE 0 END)`, unit: "count" as const, dateColumn: "paid_at", leading: paidStatuses };
  const status = metric.replace("_sales", "");
  if (["pending", "failed", "cancelled"].includes(status)) return { expression: "SUM(CASE WHEN LOWER(t.payment_status) = ? THEN 1 ELSE 0 END)", unit: "count" as const, dateColumn: "created_at", leading: [status] };
  return { expression: "COUNT(*)", unit: "count" as const, dateColumn: "created_at", leading: [] as string[] };
};

const whereFor = (args: Arguments, dateColumn: string) => {
  const clauses = [`t.${dateColumn} >= ?`, `t.${dateColumn} < ?`];
  const values: unknown[] = [args.range.from, toExclusive(args.range.to)];
  if (args.filters?.currency) { clauses.push("t.currency = ?"); values.push(args.filters.currency); }
  if (args.filters?.transactionKind) { clauses.push("t.kind_key = ?"); values.push(args.filters.transactionKind); }
  if (args.filters?.paymentStatus) { clauses.push("LOWER(t.payment_status) = ?"); values.push(args.filters.paymentStatus); }
  if (args.filters?.dimension) {
    const builtIn = builtInDimensions.find((item) => item.key === args.filters?.dimension);
    if (builtIn) {
      if (args.filters.dimensionValue) {
        clauses.push(`(t.${builtIn.keyColumn} = ? OR LOWER(t.${builtIn.labelColumn}) = LOWER(?))`);
        values.push(args.filters.dimensionValue, args.filters.dimensionValue);
      }
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM ap_sales_dimensions_v1 filter_dimension WHERE filter_dimension.transaction_id = t.transaction_id AND filter_dimension.dimension_key = ?${args.filters.dimensionValue ? " AND (filter_dimension.value_key = ? OR LOWER(filter_dimension.value_label) = LOWER(?))" : ""})`);
      values.push(args.filters.dimension);
      if (args.filters.dimensionValue) values.push(args.filters.dimensionValue, args.filters.dimensionValue);
    }
  }
  return { sql: clauses.join(" AND "), values };
};

const resolveCurrency = async (db: AnalyticsQueryDb, args: Arguments, unit: "minor_currency" | "count") => {
  if (unit === "count") return args.filters?.currency ?? null;
  if (args.filters?.currency) return args.filters.currency;
  const schema = await salesSchema(db);
  if (schema.currencies.length > 1) throw new SalesMcpMethodError("A currency must be selected before aggregating monetary values", "INVALID_SALES_ARGUMENTS");
  return schema.currencies[0] ?? null;
};

const metricResult = async (db: AnalyticsQueryDb, args: Arguments, overrideRange?: Range) => {
  if (!args.metric) throw new SalesMcpMethodError("A metric is required", "INVALID_SALES_ARGUMENTS");
  const scoped = overrideRange ? { ...args, range: overrideRange } : args;
  const definition = metricSql(args.metric);
  const where = whereFor(scoped, definition.dateColumn);
  const row = await firstRow(db, `SELECT ${definition.expression} AS value, COUNT(*) AS matched_rows FROM ap_sales_transactions_v1 t WHERE ${where.sql}`, [...definition.leading, ...where.values]);
  const value = Number(row.value ?? 0);
  const matchedRows = Number(row.matched_rows ?? 0);
  return {
    value: Number.isFinite(value) ? value : 0,
    unit: definition.unit,
    currency: matchedRows > 0 ? await resolveCurrency(db, args, definition.unit) : null,
  };
};

const breakdownResult = async (db: AnalyticsQueryDb, args: Arguments) => {
  if (!args.metric || !args.groupBy) throw new SalesMcpMethodError("A metric and groupBy are required", "INVALID_SALES_ARGUMENTS");
  const definition = metricSql(args.metric);
  const where = whereFor(args, definition.dateColumn);
  const builtIn = builtInDimensions.find((item) => item.key === args.groupBy);
  const limit = args.limit ?? 12;
  if (builtIn) {
    const rows = await allRows(db, `SELECT COALESCE(t.${builtIn.keyColumn}, 'unknown') AS key, COALESCE(t.${builtIn.labelColumn}, 'Unknown') AS label, ${definition.expression} AS value FROM ap_sales_transactions_v1 t WHERE ${where.sql} GROUP BY t.${builtIn.keyColumn}, t.${builtIn.labelColumn} ORDER BY value ${args.sort === "asc" ? "ASC" : "DESC"}, label ASC LIMIT ?`, [...definition.leading, ...where.values, limit]);
    return rows.map((row) => ({ key: String(row.key), label: String(row.label), value: Number(row.value ?? 0) }));
  }
  const schema = await salesSchema(db);
  if (!schema.dimensions.some((item) => item.key === args.groupBy)) throw new SalesMcpMethodError(`Unsupported Sales dimension ${args.groupBy}`, "UNSUPPORTED_SALES_DIMENSION");
  const rows = await allRows(db, `SELECT d.value_key AS key, d.value_label AS label, ${definition.expression} AS value FROM ap_sales_transactions_v1 t JOIN ap_sales_dimensions_v1 d ON d.transaction_id = t.transaction_id AND d.dimension_key = ? WHERE ${where.sql} GROUP BY d.value_key, d.value_label ORDER BY value ${args.sort === "asc" ? "ASC" : "DESC"}, label ASC LIMIT ?`, [...definition.leading, args.groupBy, ...where.values, limit]);
  return rows.map((row) => ({ key: String(row.key), label: String(row.label), value: Number(row.value ?? 0) }));
};

const trendResult = async (db: AnalyticsQueryDb, args: Arguments) => {
  if (!args.metric) throw new SalesMcpMethodError("A metric is required", "INVALID_SALES_ARGUMENTS");
  const definition = metricSql(args.metric);
  const where = whereFor(args, definition.dateColumn);
  const label = args.interval === "month" ? `substr(t.${definition.dateColumn}, 1, 7)`
    : args.interval === "week" ? `strftime('%Y-W%W', t.${definition.dateColumn})`
      : `substr(t.${definition.dateColumn}, 1, 10)`;
  const rows = await allRows(db, `SELECT ${label} AS label, ${definition.expression} AS value FROM ap_sales_transactions_v1 t WHERE ${where.sql} GROUP BY label ORDER BY label ASC LIMIT 100`, [...definition.leading, ...where.values]);
  return rows.map((row) => ({ label: String(row.label), value: Number(row.value ?? 0) }));
};

export const executeSalesMcpMethod = async (
  db: AnalyticsQueryDb | undefined,
  method: SalesMcpMethod,
  rawArguments: unknown,
) => {
  if (!db) throw new SalesMcpMethodError("The generated site D1 binding is unavailable", "SALES_QUERY_EXECUTION_FAILED");
  if (method === "sales_schema") return salesSchema(db);
  if (method === "sales_resolve_entity") return salesResolveEntity(rawArguments);
  const args = argumentsFrom(rawArguments);
  if (method === "sales_metric") {
    const result = await metricResult(db, args);
    return { contract: "sales-mcp.v1", method, metric: args.metric, range: args.range, ...result };
  }
  if (method === "sales_breakdown") {
    const definition = metricSql(args.metric!);
    return { contract: "sales-mcp.v1", method, metric: args.metric, range: args.range, currency: await resolveCurrency(db, args, definition.unit), unit: definition.unit, rows: await breakdownResult(db, args) };
  }
  if (method === "sales_trend") {
    const definition = metricSql(args.metric!);
    return { contract: "sales-mcp.v1", method, metric: args.metric, range: args.range, currency: await resolveCurrency(db, args, definition.unit), unit: definition.unit, rows: await trendResult(db, args) };
  }
  if (method === "sales_compare") {
    if (!args.comparisonRange) throw new SalesMcpMethodError("A comparisonRange is required", "INVALID_SALES_ARGUMENTS");
    const [current, comparison] = await Promise.all([metricResult(db, args), metricResult(db, args, args.comparisonRange)]);
    return { contract: "sales-mcp.v1", method, metric: args.metric, range: args.range, comparisonRange: args.comparisonRange, currency: current.currency, unit: current.unit, value: current.value, comparisonValue: comparison.value };
  }
  const where = whereFor(args, "created_at");
  const rows = await allRows(db, `SELECT t.transaction_id, t.reference, t.kind_label, t.item_label, t.owner_label, t.amount_minor, t.currency, t.payment_status, t.created_at, t.paid_at FROM ap_sales_transactions_v1 t WHERE ${where.sql} ORDER BY t.created_at ${args.sort === "asc" ? "ASC" : "DESC"}, t.transaction_id DESC LIMIT ?`, [...where.values, args.limit ?? 20]);
  return {
    contract: "sales-mcp.v1",
    method,
    range: args.range,
    currency: args.filters?.currency ?? null,
    transactions: rows.map((row) => ({
      transactionId: String(row.transaction_id), reference: row.reference === null ? null : String(row.reference),
      kindLabel: String(row.kind_label), itemLabel: row.item_label === null ? null : String(row.item_label),
      ownerLabel: row.owner_label === null ? null : String(row.owner_label), amountMinor: Number(row.amount_minor ?? 0),
      currency: String(row.currency), paymentStatus: String(row.payment_status), createdAt: String(row.created_at),
      paidAt: row.paid_at === null ? null : String(row.paid_at),
    })),
  };
};
