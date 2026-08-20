import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("shared layout installs consent-gated private PostHog analytics", () => {
  const layout = read("src/layouts/BaseLayout.astro");
  const client = read("src/scripts/posthog-analytics.ts");

  assert.match(layout, /getPublicPosthogConfig/);
  assert.match(layout, /data-posthog-config/);
  assert.match(layout, /data-analytics-consent-banner/);
  assert.match(layout, /data-analytics-consent-decline/);
  assert.match(layout, /data-analytics-consent-accept/);
  assert.match(layout, /posthog-analytics\.ts/);
  assert.match(client, /capture_pageview:\s*false/);
  assert.match(client, /capture_pageleave:\s*false/);
  assert.match(client, /autocapture:\s*false/);
  assert.match(client, /disable_session_recording:\s*true/);
  assert.match(client, /readConsent\(\) !== "granted"/);
  assert.match(client, /vera-solaro:analytics-consent/);
  assert.match(client, /allowedEvents/);
  assert.match(client, /"payment_failed"/);
  assert.match(client, /"scheduling_retry_requested"/);
  assert.match(client, /allowedPayloadKeys = new Set\(\["service", "mode", "step", "status", "source"\]\)/);
  assert.match(client, /safePayload/);
  // Payment failures belong to the same-page wizard; scheduling retries belong to
  // the authoritative confirmation screen.
  const bookingPayment = read("src/pages/booking.astro");
  const bookingConfirmation = read("src/pages/booking/[id]/confirmation.astro");
  const booking = `${bookingPayment}\n${bookingConfirmation}`;
  assert.match(bookingPayment, /track\("payment_failed",\s*\{/);
  assert.match(bookingConfirmation, /track\("scheduling_retry_requested",\s*\{/);
  assert.doesNotMatch(booking, /(?:payment_failed|scheduling_retry_requested)[\s\S]{0,180}\breason\s*:/);
  assert.doesNotMatch(client, /void initializePosthog\(\);\s*\/\*\s*To restore consent/);
  assert.doesNotMatch(client, /phc_[a-z0-9]+/i);
  assert.doesNotMatch(layout, /phx_[a-z0-9]+/i);
});

test("analytics consent copy makes the privacy boundary explicit", () => {
  const copy = read("src/data/vera/content.ts");
  assert.match(copy, /No name, email, birth details or session recording is collected/);
  assert.match(copy, /Decline/);
  assert.match(copy, /Allow analytics/);
  assert.equal(
    existsSync(new URL("../src/data/analytics-consent.ts", import.meta.url)),
    false,
    "analytics consent copy belongs in the existing Vera content registry",
  );
});

test("template manifest declares PostHog runtime values without an analytics file", () => {
  const manifest = JSON.parse(read("template.manifest.json"));
  assert.equal(Object.hasOwn(manifest, "analytics"), false);
  for (const key of ["POSTHOG_PROJECT_API_KEY", "POSTHOG_HOST", "POSTHOG_PROJECT_ID"]) {
    assert.equal(manifest.secrets.generatedSiteRuntimeConfig.includes(key), true, `${key} must sync to generated sites`);
    assert.equal(manifest.secrets.providerCredentials.includes(key), true, `${key} must be declared as a provider value`);
  }
});

test("public PostHog config reads runtime values without exposing the personal key", async () => {
  const source = read("src/server/aggregator/integrations/posthog.ts");
  assert.match(source, /POSTHOG_PROJECT_API_KEY/);
  assert.match(source, /POSTHOG_HOST/);
  assert.doesNotMatch(source, /POSTHOG_PERSONAL_API_KEY/);

  const { getPublicPosthogConfig } = await import("../src/server/aggregator/integrations/posthog.ts");
  const config = await getPublicPosthogConfig({
    ASTROPAGES_PROJECT_ID: "posthog-test-project",
    ASTROPAGES_SITE_ENVIRONMENT: "preview",
    DB: {
      prepare: () => ({
        bind: () => undefined,
        all: async () => ({
          results: [
            { key: "POSTHOG_PROJECT_API_KEY", value: "project-token" },
            { key: "POSTHOG_HOST", value: "us.i.posthog.com/ignored-path" },
            { key: "POSTHOG_PERSONAL_API_KEY", value: "must-not-be-read" },
          ],
        }),
      }),
    },
  });

  assert.deepEqual(config, {
    enabled: true,
    projectApiKey: "project-token",
    host: "https://us.i.posthog.com",
  });
});
