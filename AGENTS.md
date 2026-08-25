# Vera Solaro — Agent Runbook

This site is the complete Vera Solaro AstroPages customer project. It provides the source-authorized 17-route visitor experience, 22-entry EmDash content model, Project Assets, customer authentication and account rooms, consultation booking and Stripe payment, Calendly scheduling, waitlist/contact/newsletter capture, transactional email, reports and private files, operations tooling, PostHog analytics, and generated-site release operations. Use the current project source and tested behavior as implementation truth; do not import branded pages or business flows from another site unless the user explicitly requests them.

## Authority And Preflight

The user request defines the outcome. The work package defines the allowed project, target branch, protected paths, prohibited operations, exact test command, and safety policy; all are mandatory. Never broaden its file scope, choose another branch, or weaken a constraint.

Before every user-facing layout, component, typography, color, styling, imagery, responsive, or interaction change, read and follow both `DESIGN_PHILOSOPHY.md` and `DESIGN.md`. They govern visual intent; the user request and work-package constraints may coherently override their defaults within platform safety, while this `AGENTS.md`, current project behavior, and tests govern implementation.

At the start of every task:

1. Read the complete request and work package. Identify the environment, locale, requested publication state, acceptance criteria, target branch, protected paths, prohibited operations, and exact test command.
2. Inspect the current branch and `git status --short`. Preserve unrelated work; never reset, restore, overwrite, reformat, or include changes outside the request.
3. Trace every visible value from its route to its loader and canonical owner before editing. Matching source text is not proof of ownership.
4. Read the nearest tests and relevant contracts such as `README.md`, `docs/cloudflare-runtime.md`, and `docs/openhands-playbook.md` when the task touches them.
5. Make the smallest complete change, validate the canonical store or focused behavior, then run the exact work-package test.

Explicitly selected skills are mandatory. In automatic mode, invoke only genuinely relevant pinned skills and follow their instructions. Project-local `.agents/skills` must never replace or imitate the pinned catalog.

## Route Work To The Canonical Owner

| Requested change | Canonical owner | Required route |
| --- | --- | --- |
| Existing visitor copy, chrome, 404 copy, or SEO | One of the 22 EmDash Builder entries for `en` | Resolve the route through `src/data/vera/content.ts` and `src/builder/registry.ts`, then use the content workflow below; do not hardcode visible copy in a route or component |
| Customer media | Project Assets | Use the asset workflow and returned `sitePath` |
| Layout, component, styling, route, schema, or new editable field | Project code and focused tests | Extend the closest current production pattern |
| Consultation, waitlist, newsletter, contact, or another visitor form | D1 source record plus `leads.v1` linkage | Keep contact consent, allowlists, dedupe, and conversion evidence |
| Customer account, session, or password reset | Server-owned D1 auth flow | Preserve hashing, expiry, authorization, cookies, and safe errors |
| Runtime configuration or a secret | Existing runtime binding or Secret Store contract | Never place values in code, content, logs, or D1 public copy |
| Transactional email | Generated-site email tools for preview; control plane for production | Follow the email workflow below |
| Article copy, body, slug, or article SEO | An entry in the EmDash `posts` collection | Use the content workflow below; `/writing/[slug]` renders it, so never add a per-article route |
| Reusable article chrome (back label, byline, author card, CTA, read-next heading) | EmDash entry `vera_article/main` | Use the content workflow below; this entry holds no article body and no slug |
| Additional article or blog creation | A new `posts` entry | Publish it through the content workflow; do not invent a raw-SQL, seed-file, or component-local article store |

Never fall back to locale defaults, raw SQL, migrations, or Astro components when an existing EmDash field owns the value. Source defaults are bootstrap/fallback code, not a shortcut for editing saved customer content.

## EmDash Content Workflow

`content_publish` publishes only to this project's preview EmDash environment; it never authorizes production release. Ordinary content should finish published in preview unless the user explicitly requests a draft.

For existing copy or SEO:

1. Resolve the physical target and field in `src/builder/registry.ts`, then confirm the consuming route through `src/builder/public-page.ts`.
2. Use exactly: `content_get` → minimal `content_update` with `_rev` → `content_publish` → `content_get`.
3. Send only changed fields. Verify the final value, `en` locale, published status, and rendered route using the trusted preview URL.
4. On a revision conflict, re-read the entry, preserve concurrent changes, reapply the minimal edit with the current `_rev`, publish, and verify again.

This site has a single active query-parameter locale, `en`, and exactly 22 editable release targets:

- `site_chrome/main`
- `site_pages/home`
- `site_pages/not_found_page`
- `vera_home_sections/main`
- `vera_readings/main`
- `vera_booking/main`
- `vera_booking_payment/main`
- `vera_writing/main`
- `vera_article/main`
- `vera_about/main`
- `vera_questions/main`
- `vera_contact/main`
- `vera_legal/main`
- `vera_letters/main`
- `vera_letters_status/main`
- `vera_account/main`
- `vera_account_room/main`
- `vera_account_schedule/main`
- `vera_account_cancel/main`
- `vera_account_receipt/main`
- `vera_closed/main`
- `vera_auth/main`

`src/data/vera/content.ts` supplies the source-authorized bootstrap and fallback copy for those targets; `src/builder/registry.ts` is the field and release registry; `src/builder/public-page.ts` is the public loader. Do not place new visitor-facing text directly in Astro routes, components, client scripts, or server handlers when it belongs to one of these entries. Public rendering, including `GET /` and `GET /?preview=1`, is read-only and must not create schema, entries, drafts, revisions, or release rows.

Articles are dynamic EmDash content. The `posts` collection defined in `seed/seed.json` owns every piece of writing; `/writing` lists published posts and `/writing/[slug]` renders one, both through `src/data/blog-posts.ts`. `vera_article/main` owns only the reusable article chrome (back label, byline, author card, CTA, read-next heading). Never hardcode an article, its list, or its slug in a route or component, and never invent a second article store: no raw-SQL content table, component-local article array, or parallel `ap_*` articles schema.

### New article

1. Inspect the `posts` collection with `schema_get_collection`; confirm its fields and check the requested slug for collision. Never create test, disposable, or probe content to discover whether a mutation tool works.
2. Compose the article body as Markdown, then pipe it through `scripts/markdown-to-portable-text.mjs`. Parse its JSON output and pass that parsed Portable Text array directly as `data.content`. Do not hand-author Portable Text or embed Markdown markers in normal spans.
3. Give `content_create` only supported collection fields: the required title plus supported values such as `excerpt`, `category`, the parsed Portable Text `content`, and optional `featured_image`. Pass the requested slug through the tool's dedicated slug argument.
4. Use exactly: `content_create` → `content_get` → minimal `content_update` with `_rev` for SEO → `content_publish` → `content_get`.
5. Verify the requested slug, published status, SEO values, and Portable Text structure on the final read. On a revision conflict, reread the same item, preserve concurrent changes, and retry with its current `_rev`.
6. Open both `/writing` and `/writing/<slug>` on the trusted preview URL and verify the listing card, category pill, detail route, headings, and metadata. `content_get` proves saved state, not rendered behavior.

### Existing article

Use `content_get` → minimal `content_update` with `_rev` → `content_publish` → `content_get`, then verify both `/writing` and the detail route. Preserve its slug unless the user requests a URL change. Never create another article to probe an update.

The listing intentionally reads published posts. `posts` sit outside the Builder page-content release snapshot, so preview article publication must not be described as production promotion.

Content-only work must leave Git unchanged and must not trigger a code build, commit, or preview deployment.

## Project Assets

Customer media belongs to Project Assets. Reuse asset references supplied by the work package and the returned `sitePath` verbatim; never persist a preview hostname.

- Inspect existing records with `asset_list` and `asset_get`.
- Create AI-provided bytes with `asset_create`; import a public HTTPS source with `asset_import_url`.
- Change display name, folder, category, alt text, caption, or aliases with `asset_update`.
- Replace bytes with `asset_replace` using the current `expectedRevisionId`; on conflict, read the asset again before retrying.
- Use `asset_delete` only for an explicitly requested and confirmed soft deletion; use `asset_restore` to recover the same asset.
- Preserve stable asset identity, aliases such as `vera-portrait`, alt text, captions, and immutable revision history.

Never use raw R2 operations, bucket names, storage keys, or signed URLs, and never write directly to asset D1 tables. Customer media does not belong under `public/` or `src/assets/`. The source-controlled Vera seed set is exactly `vera-portrait.webp`, `brass-protractor.webp`, `ephemeris-pages.webp`, and `night-sky.webp` under `astropages/assets/`, projected through the existing `astropages/assets.manifest.json` contract. Do not add parallel asset metadata sidecars. Changing a seed asset is code work, not a one-project media edit.

## Code, Data, And Safety Boundaries

- Public routes are under `src/pages/`; the 17 manifest-owned visitor routes are `/`, `/about`, `/readings`, `/readings/[service]`, `/booking`, `/writing`, `/writing/[slug]`, `/questions`, `/contact`, `/letters`, `/legal`, `/account`, `/closed`, `/login`, `/signup`, `/forgot-password`, and `/reset-password`.
- Writing routes `/writing` and `/writing/[slug]` read dynamic EmDash `posts` through `src/data/blog-posts.ts`; `seed/seed.json` defines the collection schema but does not store ordinary articles.
- Builder ownership is defined by `src/builder/registry.ts`; public content is loaded through `src/builder/public-page.ts`.
- Generated-site APIs and lifecycle code live in `src/server/generated-site/` and `src/pages/api/astropages/generated-site/`.
- Vera booking, scheduling, payment, engagement, email, account, file, report, and operations services live in `src/server/vera/`; reusable platform services live in `src/server/aggregator/`. Durable D1 changes use the next numbered forward-only file in `migrations/`.
- `ap_customer_accounts`, `ap_customer_sessions`, and `ap_customer_password_resets` own customer authentication. Never expose password material, session tokens, reset tokens, or private customer data.
- `ap_leads` and `ap_business_events` implement `leads.v1`. Persist the authoritative business record before linking a lead, allowlist details, require consent where applicable, deduplicate retries, and mark conversion only after verified business evidence.
- `ap_vera_*` tables own the consultation catalog, Calendly mappings, bookings, payments, refunds, invoices, gifts, waitlist, contact, newsletter, outbox, suppressions, private files, reports, messages, and follow-ups. Never replace them with browser state, content fields, or a second vertical schema.
- `ap_runtime_config` and `ap_business_settings` are not secret stores. Runtime secrets resolve only through the existing binding contract.
- Generated-site Worker runtime uses `EMDASH_ENCRYPTION_KEY` and `ASTROPAGES_CONTROL_PLANE_CALLBACK_TOKEN`. Generated-site Worker deploys must not require `BUILDER_MCP_TOKEN` or `BUILDER_MCP_PROVISION_SECRET`.
- Keep `dist/`, `.astro/`, `.wrangler/generated/`, `node_modules/`, and work-package protected paths untouched unless the request explicitly owns them.

Do not bypass or clone the existing Vera booking, Stripe, Calendly, report, private-file, messaging, newsletter, contact, waitlist, or generic lead boundaries. A new business feature must define its server-owned record, validation, authorization, privacy boundary, lead linkage, tests, runtime configuration, and generated-site contract together.

## Email Preview Workflow

1. Inspect templates and events with `email_template_list`, `email_template_get`, and `email_event_list`.
2. Inspect approved variables with `email_variable_catalog` and trace the real event producer before using a value.
3. Create a missing event contract with `email_event_save`; add only non-sensitive approved mappings with `email_variable_add_mapping`.
4. Save the active preview template with `email_template_save_preview` (`email_template_save_draft` is only a deprecated alias), then validate with `email_template_render_sample`.
5. Verify event type, audience, locale, subject, HTML/text bodies, declared variables, representative sample data, missing-variable behavior, and `unsubscribeUrl` for marketing mail.

Email tools are preview-only. Production promotion remains with the control plane; never promote by raw SQL, row copying, provider calls, or an invented publish tool.

## Completion Contract

- Run the exact test command supplied by the work package; it takes precedence over broader guidance. When no narrower command exists for authorized code work, the current complete local gate is `pnpm run project-assets:contract`, `pnpm run sales:contract`, `pnpm run users-data:contract`, `pnpm run secrets:contract`, `pnpm run test`, `pnpm run scan:safety`, `pnpm run d1:schema:check`, `pnpm run cloudflare:contract`, `pnpm run typecheck`, `pnpm run build`, then `git diff --check`, run serially.
- A generated preview may be reported `ready`, and production may be reported `live`, only after the service-authenticated `GET /api/astropages/generated-site/vera/operations` readiness check returns HTTP 200 with `status: "ready"`, `state: "ready"`, and `data.ready: true`. Base health and edit readiness are necessary but not sufficient; missing provider secrets, runtime configuration, bindings, or Calendly mappings must block the release callback.
- Do not run a generated-site build when the work package prohibits it. Never weaken a test or edit protected files to obtain a pass.
- Code changes may be committed and pushed only to the work package's provided target branch after its required checks succeed. Content-only and Project-Asset-only work must leave Git unchanged.
- Never deploy or publish production. Preview content publication is not production release.
- Finish with `git status --short` and the relevant diff. Provide a concise customer-facing summary of verified outcomes and genuine limitations; omit internal tool names, branches, lifecycle terminology, schemas, commands, and test counts unless the user asks for technical detail.
