# Vera Solaro

`aspt-verdigris-vera-solaro` is the Verdigris Almanac edition of the Vera Solaro astrology template, built on the reusable AstroPages Cloudflare and EmDash runtime. The public experience is English-first, uses USD, and operates in the `Europe/Rome` timezone. AstroPages Admin owns the semantic version, release notes, and changelog for every released template commit.

## Release Metadata

Template source identifies an immutable technical commit, but never gates a release on a source-controlled template version. After a production workflow succeeds, use AstroPages Admin to verify that commit and select its semantic version, release notes, and changelog. Do not add `version`, `registryVersionId`, or a template registry-version lock to a derived template manifest.

Included runtime:

- Astro 6 on Cloudflare Workers with D1, R2, KV, Images, assets, and worker-loader bindings.
- EmDash as the canonical content system for builder-managed public copy and SEO.
- Explicit generated-site EmDash bootstrap before smoke checks, with fast edit-readiness on later deploys.
- Read-only public and `?preview=1` rendering; page loads must not create schema, entries, drafts, or release revisions.
- Content Studio and MCP editing through EmDash mutation handlers.
- Content release state, deterministic snapshots, import/export APIs, and content hash versus snapshot hash semantics.
- Generated-site SSO sessions, roles, CSRF support, and bounded browser-safe SSO exchange failures.
- Runtime config sync and D1 cache.
- Customer signup, login, password recovery, protected account data, reports,
  files, invoices, and message threads.
- The three source-defined Vera readings, all call-only and backed by one
  canonical 30-minute Calendly event.
- Server-authoritative availability, twelve-minute D1 slot holds, encrypted
  intake data, Stripe PaymentIntents, signed webhooks, refunds, invoices, and
  Calendly invitee reconciliation.
- Contact, waitlist, and double-opt-in monthly-letter flows linked to the
  canonical privacy-bounded `leads.v1` model.
- Editable lifecycle email templates, a D1 outbox, Cloudflare Queue delivery
  with a dead-letter queue, scheduled retries, and recipient suppression.
- Consent-gated PostHog page and booking-funnel events. Autocapture and session
  recording are disabled, and event properties are allowlisted to exclude
  contact and birth data.
- Vera-specific fixed-query analytics plus Sales and Users Data MCP contracts.
- Current generated-site workflow seeds in `.astropages/generated-site-workflows`.

Deliberate source limits:

- The source package supplies a complete body for one article only. The other
  source titles remain catalog metadata and are not presented as invented
  articles.
- Gift certificates can be issued by authenticated operations and redeemed in
  checkout; the source package does not define a gift-purchase flow.
- Only the registered Vera media files inherited by the Verdigris edition are seeded. Other
  source image slots intentionally retain their designed placeholders.
- There is no generic endpoint accepting arbitrary leads. Vera consultation,
  waitlist, newsletter, and contact flows create their authoritative records
  before linking `leads.v1`.
- No generated-site `/astropages/admin` console.
- No production launch without live Calendly mappings, Stripe keys and webhook,
  SES credentials, the platform Google Places binding, encryption, and the
  environment-specific Cloudflare resources declared by the existing manifests.

Project credentials are synchronized as individual Worker secrets. Google Places uses the shared platform Secrets Store binding; `ASTROPAGES_INTEGRATION_SECRETS_JSON` remains a legacy read fallback only.

## EmDash Contract

Generated sites must materialize editable content explicitly through:

```text
POST /api/astropages/generated-site/emdash/bootstrap
```

Public render paths only read:

```text
GET /
GET /?preview=1
```

Mutation paths are explicit:

- Content Studio editor APIs.
- EmDash MCP.
- EmDash REST/admin handlers.
- Service-authenticated content release import.

Content release endpoints:

```text
GET  /api/astropages/generated-site/content-release/status
POST /api/astropages/generated-site/content-release/export
POST /api/astropages/generated-site/content-release/import
```

Worker deploys use only:

- `EMDASH_ENCRYPTION_KEY`
- `ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN`

Template-source preview/production pipelines generate the callback token in memory before writing the Worker secrets file. Neither template-source nor generated-site deploys require `BUILDER_MCP_TOKEN` or `BUILDER_MCP_PROVISION_SECRET`.

## Commands

```sh
pnpm install
pnpm run test
pnpm run scan:safety
pnpm run d1:schema:check
pnpm run cloudflare:contract
pnpm run typecheck
pnpm run build
```

Run `pnpm run cloudflare:resources:print` to inspect local preview/production resource names.

## Vera Configuration

Configure values through the existing runtime and secrets contracts; do not add
parallel sidecar manifests.

- Configure `CALENDLY_EVENT_TYPE_URI` with one active 30-minute Calendly
  event type shared by all three readings.
- Sync the public Stripe publishable key through runtime config and store the
  Stripe secret/webhook values through the existing secrets manifest.
- Configure SES sender settings plus AWS credentials, and provision both the
  email queue and its dead-letter queue.
- Provide `CLOUDFLARE_SECRETS_STORE_ID` as a deployment variable so generated
  deployments can bind the shared platform Google Places key. Vera project
  credentials are synchronized separately as individual Worker secrets; the
  legacy JSON bundle is never rendered as a new Secrets Store binding.
- Keep `PREVIEW_SITE_URL` and `PRODUCTION_SITE_URL` as absolute HTTPS origins.
  Deployment renders the selected value into `ASTROPAGES_SITE_URL` for Stripe,
  account, newsletter, report, and email links.
- Enable PostHog only when the consented analytics integration is wanted. The
  legal disclosure and preference control remain visible either way.
- Bootstrap EmDash, seed Project Assets, and apply every forward D1 migration
  before running deployment smoke checks.

## Release Checklist

Template CI and deployments are generated centrally by the signed AstroPages
Control Plane extension. This repository intentionally has no checked-in
`.woodpecker.yml` and no GitHub deployment workflows.

- Pull requests and `develop` run only in DEV Woodpecker. A successful current
  `develop` push may be explicitly deployed to the DEV Cloudflare account with
  target `preview`.
- `main` runs only in PROD Woodpecker. A successful current `main` push may be
  explicitly deployed to the PROD Cloudflare account with target `production`.
- Environment credentials are encrypted repository secrets in the respective
  Woodpecker system. Values are never stored here or copied between environments.
- `.github/workflows/ci.yml` remains secretless safety CI only.

1. Commit and push the reviewed template change to `develop`.
2. Require DEV `template_ci`, then explicitly deploy to `preview`.
3. Promote `develop` to `main` through an approved pull request.
4. Require PROD `template_ci`, then explicitly deploy to `production`.
5. Verify the exact release SHA and Admin-managed semantic version in AstroPages Admin.
