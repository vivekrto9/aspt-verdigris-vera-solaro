import assert from "node:assert/strict";
import test from "node:test";
import {
  executeUsersDataMcpMethod,
  maybeHandleUsersDataMcpToolCall,
  usersDataMcpMethods,
} from "../src/server/aggregator/users-data-mcp.ts";

const rowsFor = (sql, values) => {
  if (sql.includes("COUNT(*)")) return [{ value: 1 }];
  if (sql.includes("FROM ap_vera_bookings")) return [{ booking_number: "VS-100", service_name: "The Natal Hour" }];
  if (sql.includes("FROM ap_vera_reports")) return [{ booking_number: "VS-100", title: "Natal report", status: "published" }];
  if (sql.includes("FROM ap_vera_private_files")) return [{ booking_number: "VS-100", file_name: "natal-report.pdf", kind: "report_pdf" }];
  if (sql.includes("FROM ap_vera_message_threads")) return [{ booking_number: "VS-100", subject: "Your reading", status: "open" }];
  if (sql.includes("FROM ap_vera_invoices")) return [{ invoice_number: "VSI-100", booking_number: "VS-100", status: "paid" }];
  if (sql.includes("FROM ap_customer_accounts") && sql.includes("WHERE id = ?")) {
    return values[0] === "user-1" ? [{ id: "user-1", display_name: "Clara", email: "clara@example.com", created_at: "2026-07-01" }] : [];
  }
  if (sql.includes("FROM ap_customer_accounts")) return [{ id: "user-1", display_name: "Clara", email: "clara@example.com", created_at: "2026-07-01" }];
  return [];
};

const db = {
  prepare(sql) {
    let values = [];
    return {
      bind(...nextValues) {
        values = nextValues;
        return this;
      },
      async all() { return { results: rowsFor(sql, values) }; },
      async first() { return rowsFor(sql, values)[0] ?? null; },
    };
  },
};

test("exposes the independent Users Data methods", () => {
  assert.deepEqual(usersDataMcpMethods, ["users_schema", "users_list", "users_get", "users_related"]);
});

test("returns a dynamic schema and paginated users", async () => {
  const result = await executeUsersDataMcpMethod(db, "users_list", { page: 1, pageSize: 25, search: "Clara" });
  assert.equal(result.contract, "users-data.v1");
  assert.equal(result.method, "users_list");
  assert.equal(result.schema.entity.idField, "id");
  assert.equal(result.pagination.total, 1);
  assert.equal(result.rows[0].id, "user-1");
  assert.deepEqual(
    result.schema.columns.map((column) => column.key),
    ["id", "display_name", "email", "phone", "default_language", "email_verified_at", "created_at", "updated_at"],
  );
});

test("returns user details with template-specific related sections", async () => {
  const result = await executeUsersDataMcpMethod(db, "users_get", { userId: "user-1" });
  assert.equal(result.contract, "users-data.v1");
  assert.deepEqual(result.relatedSections.map((section) => section.key), ["bookings", "reports", "files", "messages", "invoices"]);
});

test("rejects unknown sort fields without interpolating them", async () => {
  const result = await executeUsersDataMcpMethod(db, "users_list", { sort: "password_hash" });
  assert.equal(result.contract, "users-data.v1");
});

test("Users Data metadata and fixed queries exclude private astrology and message payloads", async () => {
  const result = await executeUsersDataMcpMethod(db, "users_schema", {});
  assert.doesNotMatch(
    JSON.stringify(result),
    /password|salt|token|session|birth_|encrypted|storage_key|provider_payment|message_body/i,
  );
});

const usersMcpRequest = () => new Request("https://example.com/_emdash/api/mcp", {
  method: "POST",
  headers: {
    authorization: "Bearer users-data-token",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "users_schema", arguments: {} },
  }),
});

const usersMcpDb = (scopes) => ({
  prepare(sql) {
    let values = [];
    return {
      bind(...nextValues) {
        values = nextValues;
        return this;
      },
      async all() { return { results: rowsFor(sql, values) }; },
      async first() {
        if (sql.includes("_emdash_api_tokens")) {
          return { id: "users-token", scopes, expires_at: null };
        }
        return rowsFor(sql, values)[0] ?? null;
      },
    };
  },
});

test("dispatches Users Data MCP only for users:read tokens", async () => {
  const allowed = await maybeHandleUsersDataMcpToolCall(usersMcpRequest(), {
    DB: usersMcpDb('["users:read"]'),
  });
  assert.ok(allowed);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result.structuredContent.contract, "users-data.v1");

  const forbidden = await maybeHandleUsersDataMcpToolCall(usersMcpRequest(), {
    DB: usersMcpDb("analytics:read"),
  });
  assert.ok(forbidden);
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, -32003);
});
