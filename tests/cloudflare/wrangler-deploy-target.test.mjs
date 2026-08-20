import assert from "node:assert/strict";
import test from "node:test";

import { databaseNameForEnvironment } from "../../scripts/wrangler-deploy-target.mjs";

const config = {
  d1_databases: [
    { binding: "DB", database_name: "aspt-verdigris-vera-solaro-site" },
  ],
  env: {
    preview: {
      d1_databases: [
        { binding: "DB", database_name: "aspt-verdigris-vera-solaro-preview-site" },
      ],
    },
    production: {
      d1_databases: [
        { binding: "DB", database_name: "aspt-verdigris-vera-solaro-production-site" },
      ],
    },
  },
};

test("selects the D1 database from the requested deployment environment", () => {
  assert.equal(
    databaseNameForEnvironment(config, "preview"),
    "aspt-verdigris-vera-solaro-preview-site",
  );
  assert.equal(
    databaseNameForEnvironment(config, "production"),
    "aspt-verdigris-vera-solaro-production-site",
  );
});

test("does not fall back to the local top-level D1 database", () => {
  assert.throws(
    () => databaseNameForEnvironment(config, "missing"),
    /missing environment/i,
  );
});
