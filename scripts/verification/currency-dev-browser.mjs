// Actual Astro DEV adapter with isolated source/D1 and a loopback Cloudflare quick-tunnel simulation.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { verifyVeraCurrencySurfaces } from "./currency-surface-checks.mjs";

const source = process.cwd();
const output = resolve("output/playwright/currency-dev");
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), "vera-currency-dev-"));
const tunnelHost = "currency-verification.trycloudflare.com";
const cleanEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(cleanEnv, { NODE_ENV: "development", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" });
let dev; let proxy; let browser; let database; let visitorCountry = "US";
const results = [];
const log = createWriteStream(join(output, "server.log"));
const closeServer = (server) => new Promise((resolveClose) => server ? server.close(resolveClose) : resolveClose());
const listen = (server) => new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(server.address().port)));

try {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    if (/^(?:\.env|\.dev\.vars|\.git|node_modules\/|output\/|dist\/|\.astro\/|\.wrangler\/)/.test(file)) continue;
    const target = join(fixture, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(source, file), target);
  }
  execFileSync("cp", ["-cR", join(source, "node_modules"), join(fixture, "node_modules")], { timeout: 120_000 });
  writeFileSync(join(fixture, "astro.verification.config.mjs"), `import base from './astro.config.mjs';\nexport default { ...base, cacheDir: './.currency-dev-cache/astro', vite: { ...base.vite, cacheDir: new URL('./.currency-dev-cache/vite/', import.meta.url).pathname, server: { ...base.vite?.server, allowedHosts: ['currency-verification.trycloudflare.com'] } } };\n`);
  writeFileSync(join(fixture, "wrangler.jsonc"), JSON.stringify({ name: "vera-currency-dev", main: "src/worker.ts", compatibility_date: "2026-02-24", compatibility_flags: ["nodejs_compat"], assets: { directory: "public", binding: "ASSETS" }, vars: { EMDASH_ENCRYPTION_KEY: "currency-secret", CALENDLY_EVENT_TYPE_URI: "https://api.calendly.com/event_types/vera_currency_fixture", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture", RAZORPAY_WEBHOOK_SECRET: "fixture" }, d1_databases: [{ binding: "DB", database_name: "vera-currency-dev", database_id: crypto.randomUUID(), migrations_dir: "migrations" }], kv_namespaces: [{ binding: "SESSION", id: "vera-currency-session" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "vera-currency-media" }], images: { binding: "IMAGES" }, worker_loaders: [{ binding: "LOADER" }] }, null, 2));
  execFileSync(process.execPath, [join(source, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local"], { cwd: fixture, env: cleanEnv, stdio: ["ignore", log.fd, "pipe"], timeout: 120_000 });
  const storage = join(fixture, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  for (const file of readdirSync(storage).filter((name) => name.endsWith(".sqlite"))) { const candidate = new DatabaseSync(join(storage, file)); if (candidate.prepare("SELECT name FROM sqlite_master WHERE name='ap_business_settings'").get()) { database = candidate; break; } candidate.close(); }
  assert.ok(database, "isolated migrated D1");
  database.exec("UPDATE ap_vera_services SET price_usd_cents=200,price_cents=200 WHERE slug='natal-hour'; UPDATE ap_vera_services SET price_inr_cents=10000 WHERE slug='natal-hour'");
  const setPreference = (value, revision) => database.prepare("UPDATE ap_business_settings SET value_json=? WHERE key='payment_preference'").run(JSON.stringify({ value, schemaVersion: 1, revision }));
  const reserve = createServer(); const devPort = await listen(reserve); await closeServer(reserve);
  dev = spawn(process.execPath, [join(source, "node_modules/astro/bin/astro.mjs"), "dev", "--config", "astro.verification.config.mjs", "--host", "127.0.0.1", "--port", String(devPort)], { cwd: fixture, env: cleanEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  dev.stdout.pipe(log, { end: false }); dev.stderr.pipe(log, { end: false });
  const direct = `http://127.0.0.1:${devPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) { if (dev.exitCode !== null) throw new Error("Astro DEV exited; inspect currency-dev/server.log"); try { if ((await fetch(`${direct}/api/astropages/generated-site/vera/catalog`, { signal: AbortSignal.timeout(5_000) })).ok) { ready = true; break; } } catch {} await delay(1_000); }
  assert.ok(ready, "Astro DEV ready"); await delay(5_000);
  proxy = createServer((incoming, outgoing) => { const headers = { ...incoming.headers, host: tunnelHost, "cf-ray": "vera-dev-fixture" }; delete headers["cf-ipcountry"]; if (visitorCountry) headers["cf-ipcountry"] = visitorCountry; const upstream = httpRequest({ hostname: "127.0.0.1", port: devPort, path: incoming.url, method: incoming.method, headers }, (response) => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); }); upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream); });
  const tunnelBase = `http://127.0.0.1:${await listen(proxy)}`;
  browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage(); page.setDefaultTimeout(30_000); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const cases = [["INR", "US", "INR", tunnelBase], ["USD", "IN", "USD", tunnelBase], ["AUTO", "IN", "INR", tunnelBase], ["AUTO", "NL", "USD", tunnelBase], ["AUTO", undefined, "USD", direct], ["AUTO", "IN", "INR", tunnelBase]];
  for (const [index, [preference, country, currency, base]] of cases.entries()) { visitorCountry = country; setPreference(preference, index + 2); const label = `${index}-${preference}-${country ?? "unknown"}`; results.push({ preference, country: country ?? "unknown", ...(await verifyVeraCurrencySurfaces({ page, request: context.request, base, currency, label, output, browserErrors: errors })) }); }
  assert.deepEqual(errors, [], "browser runtime errors");
  writeFileSync(join(output, "results.json"), JSON.stringify({ runtime: "actual Astro DEV", cases: results, sameBrowserCountryChanges: true, customIndependentPrices: { INR: 10000, USD: 200 }, status: "PASS" }, null, 2));
  console.log("PASS: actual Astro DEV six-case Vera payment-currency browser matrix.");
} finally {
  await browser?.close(); await closeServer(proxy); database?.close();
  if (dev && dev.exitCode === null) { const exited = new Promise((resolveExit) => dev.once("exit", resolveExit)); try { process.kill(-dev.pid, "SIGTERM"); } catch {} await Promise.race([exited, delay(5_000)]); if (dev.exitCode === null) try { process.kill(-dev.pid, "SIGKILL"); } catch {} }
  log.end(); rmSync(fixture, { recursive: true, force: true });
}
