# Cloudflare Runtime Contract

The Vera Solaro template supports two repository modes.

## Template Source Mode

This repo keeps template release workflows:

- `.github/workflows/deploy-template-preview.yml`
- `.github/workflows/deploy-production.yml`
- `.astropages/generated-site-workflows/*`

Template release workflows may use template deployment secrets such as `BUILDER_MCP_TOKEN` and `BUILDER_MCP_PROVISION_SECRET` because they validate and release the source template itself.

## Generated-Site Mode

The control plane installs generated-site workflows into generated repos:

- `.github/workflows/deploy-preview.yml`
- `.github/workflows/deploy-production.yml`

Generated-site Worker runtime secrets are:

- `EMDASH_ENCRYPTION_KEY`
- `ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN`

Provider credentials are not copied into the workflow environment or generated
Worker secrets file. The control plane synchronizes them directly as individual
Worker secrets. The generated config binds only the platform Places Secret Store value
`ASTROPAGES_PLATFORM_GOOGLE_PLACES_GOOGLE_PLACES_API_KEY` as the runtime binding
`ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY`. Therefore
`CLOUDFLARE_SECRETS_STORE_ID` is required whenever `ASTROPAGES_PROJECT_ID` is
set.

The Vera individual Worker-secret set contains only the credentials used by
this template:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `CALENDLY_API_TOKEN`
- `CALENDLY_WEBHOOK_SIGNING_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- optional `POSTHOG_PERSONAL_API_KEY`

Google Places is supplied through the separate platform binding. Do not place
any of these values in `wrangler.jsonc`, a manifest, a workflow command, or a
committed dotenv file.

`ASTROPAGES_INTEGRATION_SECRETS_JSON` is retained only as a legacy read fallback when an individual Worker secret is absent; generated Wrangler configuration must not bind it.

Generated-site deployments require generic resource variables only:

- `PREVIEW_SITE_URL`
- `PREVIEW_SITE_D1_DATABASE_ID`
- `PREVIEW_SITE_SESSION_KV_NAMESPACE_ID`
- `PRODUCTION_SITE_URL`
- `PRODUCTION_SITE_D1_DATABASE_ID`
- `PRODUCTION_SITE_SESSION_KV_NAMESPACE_ID`

`render-wrangler-config.mjs` validates the selected environment URL as an HTTPS
origin and exposes it to the Worker as `ASTROPAGES_SITE_URL`. This is the
canonical origin for Stripe return URLs, booking/account links, newsletter
confirmation, reports, and lifecycle email links.

Generated-site deployments must not require Builder MCP deploy secrets. MCP access is provisioned through generated-site editor/token endpoints and EmDash, not by Worker deploy secrets.

## Vera Runtime Configuration

After migrations, the control plane must configure these non-secret values in
the existing D1 runtime configuration/operations surface:

- `STRIPE_PUBLISHABLE_KEY`
- `VERA_CALENDLY_NATAL_HOUR_CALL_URI`
- `VERA_CALENDLY_NATAL_HOUR_IN_PERSON_URI`
- `VERA_CALENDLY_YEAR_AHEAD_CALL_URI`
- `VERA_CALENDLY_YEAR_AHEAD_IN_PERSON_URI`
- `VERA_CALENDLY_TWO_CHARTS_CALL_URI`
- `VERA_CALENDLY_TWO_CHARTS_IN_PERSON_URI`
- `SES_SENDER_EMAIL`, `SES_SENDER_NAME`, and `AWS_REGION`
- `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST`, and `POSTHOG_PROJECT_ID` when
  consented analytics is enabled

Calendly mapping updates validate all six event types and their service
durations before activation. `PUBLIC_STRIPE_PUBLISHABLE_KEY` is only the
local/template fallback; generated sites use the D1 `STRIPE_PUBLISHABLE_KEY`.

Launch readiness also verifies active provider-side webhook registrations for
the exact `ASTROPAGES_SITE_URL` callbacks and the event sets handled by this
Worker. Stripe and Calendly intentionally do not return an existing endpoint's
signing secret. After creating or rotating those endpoints, the authenticated
control plane must call `POST /api/astropages/generated-site/vera/operations`
with action `validate_provider_webhooks` and SHA-256 fingerprints of the two
creation-time signing secrets. The Worker compares those fingerprints with its
Secret Store values and persists one aggregate, origin- and provider-bound
proof; no token, signing secret, individual secret fingerprint, endpoint
identifier, or provider payload is stored or returned. Secret, origin, or
provider-account rotation invalidates that proof. Readiness rechecks the live
registrations with bounded calls and a short KV cache, so a stale proof cannot
make a removed or misconfigured webhook ready.

The same service-authenticated operations route supports
`list_calendly_reconciliations` and `resolve_calendly_reconciliation`. Staff can
reconcile a known invitee, retry a definitive create failure, or explicitly
confirm that an ambiguous create produced no provider event before one
idempotently audited retry. These actions preserve terminal booking states,
verified-payment requirements, and active-refund guards; they replace raw D1
repair queries.

## Email Queue And Scheduled Delivery

Each environment declares an `EMAIL_QUEUE` producer and consumer, a dedicated dead-letter Queue, and a two-minute scheduled trigger. The D1 email outbox is the authoritative idempotency and retry ledger; Queue delivery wakes the Worker promptly, while the scheduled handler recovers persisted work if a Queue publish or provider call is interrupted. Preview and production use environment-specific Queue names, and `ensure-cloudflare-resources.mjs` creates both the delivery Queue and DLQ before deployment.

## Bootstrap And Readiness

The deployment order is fixed:

1. provision/repair the environment-specific D1, R2, KV, email Queue, and DLQ;
2. render the environment config and attach Images, Worker Loader, Secret
   Store, static assets, Queue consumer/producer, and cron bindings;
3. apply every forward D1 migration in `migrations/`;
4. deploy the Worker;
5. prepare EmDash and idempotently bootstrap Content Studio entries;
6. run health/edit-readiness smokes (plus public/admin smokes in production);
7. acknowledge the exact preview or production deployment to the control plane.

Template-source deployments also seed the approved Project Assets into the
environment R2/D1 projection before Worker deploy. Generated projects receive
their release asset projection through the control-plane project lifecycle and
must not invent a second asset manifest.

After D1 migrations and Worker deploy, workflows run:

```sh
node scripts/prepare-deployed-emdash.mjs preview
node scripts/prepare-deployed-emdash.mjs production
```

The script first checks:

```text
/api/astropages/generated-site/edit-readiness
```

If bootstrap state is current, it skips the full content bootstrap. If state is missing or stale, it calls:

```text
POST /api/astropages/generated-site/emdash/bootstrap
```

The full bootstrap is idempotent and must not overwrite non-empty edited content.

Expected smoke endpoints:

```text
/api/astropages/generated-site/health
/api/astropages/generated-site/edit-readiness
/
/_emdash/admin
```
