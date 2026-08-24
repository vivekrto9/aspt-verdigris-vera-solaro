# Vera Solaro → runtime architecture record

Goal: booking, payment, account and email work exactly like
`aspt-western-single-astrologer` (base template). The shipped UI is the Vera Solaro Verdigris Almanac.
Env/secret names come from `.dev.vars` (base-template naming) — no invented names.

## Naming audit (source of truth = .dev.vars)

| Concern | .dev.vars / base template | Vera today | Action |
|---|---|---|---|
| Google Places | ASTROPAGES_PLATFORM_GOOGLE_PLACES_GOOGLE_PLACES_API_KEY | ASTROPAGES_PLATFORM_GOOGLE_PLACES_API_KEY | DONE (alias) → make canonical |
| Calendly event type | CALENDLY_30_MIN_EVENT_TYPE_URI | CALENDLY_30_MIN_EVENT_TYPE_URI | DONE (canonical) |
| Payment provider | PAYMENT_PROVIDER | absent (Stripe hardcoded) | ADD |
| Razorpay | RAZORPAY_KEY_ID / _KEY_SECRET / _WEBHOOK_SECRET | absent | ADD |
| Stripe | STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET | same | OK |
| SES | SES_SENDER_EMAIL / SES_SENDER_NAME / AWS_* | same | OK |
| Astrology API | ASTROLOGY_* / X_ASTROLOGYAPI_* | unused | ADD if charts needed |

## Phase 1 — env naming (low risk)
1. Make base-template names canonical; keep VERA_* only as deprecated fallback.
2. Add PAYMENT_PROVIDER + RAZORPAY_* to runtimeConfigKeys / sensitive bindings.
3. Update secrets.manifest.json + docs-contract expectations.

## Phase 2 — payment provider abstraction (medium risk)
Mirror base template `payments/`: provider.ts (PAYMENT_PROVIDER switch),
stripe.ts, razorpay.ts, repository.ts, checkout.ts.
Vera keeps deposit/balance + gift logic on top.
Webhooks: add razorpay webhook route beside existing stripe one.

## Phase 3 — booking flow (high risk, payment path)
Base: service → tier → Calendly slot → details → payment → confirmed,
plus /booking/[id]/confirmation, /manage, /birth-details routes.
Vera: single wizard page + holds/quote/reschedule.
Decision needed: keep Vera's holds/gift/reschedule (superset) or drop to match base exactly.

## Phase 4 — account portal (high risk)
Base: 6 SSR pages (index, profile, billing, messages, recordings, reports)
+ PortalShell nav + pagination.
Vera: 1 client-rendered page with panels.
Work: split account.astro (1638 lines), move to SSR via customerPortalData equivalent,
rebuild nav as a Verdigris component, rewrite vera-public-content contracts.

## Phase 5 — email
Align event/template keys and payload variable names with base template.
Requires migration + email-templates.manifest.json update (same pattern as 0010).

## Test impact
vera-public-content, vera-backend, docs-contract, secrets-manifest,
email-template-contract, cloudflare/wrangler-contract.

---

## NEXT SESSION — exact state (updated 18 Aug)

### A. 30-minute migration — DONE (verified on real D1)
`migrations/0011_natal_hour_thirty_minutes.sql` is in place. natal-hour is now 30
minutes; 190 tests green, typecheck 0 errors, applied cleanly to local D1.

The PORT_PLAN recipe (PRAGMA foreign_keys = OFF + rebuild + rename) does NOT work
on D1 and was replaced. Two findings:

1. D1 applies each migration inside a transaction, where `PRAGMA foreign_keys` is a
   no-op. The rebuild passed the test harness (which ran migrations without a
   transaction) and then failed on real D1 with FOREIGN KEY constraint failed.
2. `PRAGMA defer_foreign_keys = ON` alone is not enough either: DROPping a
   referenced parent registers a deferred violation per child row, and re-creating
   the table does not clear it — only inserting the parent rows back does.
   `ALTER TABLE ... RENAME` is also unusable here, because SQLite rewrites child FK
   clauses to follow the renamed parent (`legacy_alter_table` does not prevent it),
   which left ap_vera_calendly_mappings pointing at the discarded table.

Shipped shape: defer_foreign_keys ON → drop both 0009 views → copy rows to a staging
table → empty + drop the parent → re-create with CHECK (30, 90, 120) → restore rows
(this clears the deferred counter) → drop staging → set natal-hour to 30 → re-create
both views verbatim.

All three test harnesses now wrap each migration file in BEGIN/COMMIT to model D1
faithfully, so this class of bug fails in `pnpm test` instead of at deploy:
vera-backend, vera-reporting-contract, email-template-contract.

Source changes beyond the plan: `src/server/vera/bookings.ts:770` had a second
hardcoded `[90, 120]` duration allowlist that rejected the reschedule path; widened
to `[30, 90, 120]`. Also updated operations.ts:60 and the 3 content.ts keys as planned.

Tests updated (the 4 named in the plan): duration_minutes 90→30; slot-hold counts
3→1 (30 min = 1 × 30min segment); reschedule newEndAt 11:30→10:30 and its
balance_reminder due_at; Calendly mock durations 90→30.

LOCAL DEV TRAP (pre-existing, not caused by this work): wrangler 4.123.0 bundles
miniflare 5.20260811.1-alpha, while @astrojs/cloudflare pins miniflare 4.20260521.0.
Running `pnpm run d1:migrate:local` writes DO/SQLite state in the miniflare 5 format
(3-column `_cf_ALARM`), after which `pnpm run typecheck` and `astro dev` die with
"table _cf_ALARM has 3 columns but 2 values were supplied". Fix: `rm -rf
.wrangler/state/v3`. The two tools cannot share `.wrangler/state` until the miniflare
versions converge.

### B. Payment flow parity with base template — NOT started
User decided Stripe-only (no Razorpay, contract test stays intact).
Reference: src/server/aggregator/payments/{provider,checkout,repository,stripe}.ts
Vera today: src/server/vera/stripe.ts + bookings/[id]/payment-intent.ts + quote.ts
+ webhooks/stripe. Vera adds deposit/balance, gift certificates, slot holds.
Decide per-piece whether to keep Vera's superset or flatten to base template.
Webhooks: compare Vera webhooks/stripe.ts against reference before changing.

### B1. Stripe: hosted Checkout vs inline Elements — ROOT DIFFERENCE
Reference posts to `https://api.stripe.com/v1/checkout/sessions` and redirects
the buyer to Stripe's hosted page (payments/stripe.ts:46). Server-side only:
needs STRIPE_SECRET_KEY, NO publishable key — which is why .dev.vars has none.

Vera mounts inline Stripe Elements in the browser
(src/pages/booking.astro loadStripe + src/server/vera/stripe.ts payment intents),
so it needs a publishable key that the base template never required.
catalog.ts:71 falls back to `PUBLIC_STRIPE_PUBLISHABLE_KEY` — an invented name.
Do NOT add that var. Switch Vera to hosted Checkout instead:
- create checkout session server-side from bookings/[id]/payment-intent.ts
- redirect to session.url, return to /booking?confirmed=<id> on success
- confirm via existing webhooks/stripe.ts (checkout.session.completed)
- drop loadStripe/@stripe/stripe-js from booking.astro
- remove the publishable-key fallback from catalog.ts

### B2. Webhook — the exact missing link (found 18 Aug)
Reference creates a payment ATTEMPT ROW when it creates the checkout session,
storing session.id as providerOrderId. Its webhook then matches the attempt and
flips it (payment/stripe.ts:60-90): paid when
checkout.session.completed + payment_status === "paid";
failed on checkout.session.expired / async_payment_failed.

Vera's createStripeCheckoutForBooking does NOT insert into
ap_vera_payment_attempts, so vera/stripe.ts:750 `if (!attempt) return
"Unknown Stripe payment ignored"` drops the event and the booking never
becomes paid.

TO FINISH:
1. In createStripeCheckoutForBooking, insert a paymentAttempts row exactly as
   createStripePaymentIntent does (kind, amount, currency, status 'creating'),
   then store the returned session id in provider_payment_intent_id.
2. In vera/stripe.ts webhook dispatch (~line 742) accept
   checkout.session.completed / .expired / .async_payment_failed, look the
   attempt up by session id, and route the paid case through
   processPaymentSucceeded.
3. Verify with `stripe listen --forward-to localhost:4321/api/astropages/
   generated-site/vera/webhooks/stripe` + a real test-card payment.
4. Only then remove PUBLIC_STRIPE_PUBLISHABLE_KEY (3 source + 2 test spots).

### C. Split the booking wizard into routes — DONE

booking.astro (2387 lines) is now four SSR routes. 190 tests green, typecheck 0
errors, production build clean, all seven contract scripts pass.

  /booking                     step 1 — service, mode, live Calendly calendar
  /booking/details             step 2 — sitter + birth details, creates the booking
  /booking/[id]/payment        step 3 — SSR summary, gift/quote, hands off to Stripe
  /booking/[id]/confirmation   step 4 — SSR pending until the webhook flips it to paid

ROUTE SHAPE — why step 2 is not id-scoped. createVeraBooking takes the whole intake in
one call (name, email, birth date/time, verified place token, consent) and atomically
holds the Calendly segments with it, so no booking id exists before details are
submitted. /booking/[id]/details was therefore impossible without making intake
optional at creation — a schema + validation + hold-contract change. The pandit
reference works the same way: its step-2/3/4 pages are not id-scoped, and it only
redirects to `payment?bookingId=` after creating the order. Decided with the user:
keep the API untouched and scope ids from creation onward.

CONTENT CAP — the plan's premise was wrong. vera_booking is 81/84 (3 free) and
vera_booking_payment is 82/84 (2 free), not 84/84. More importantly no new fields were
needed at all: all four routes share the existing "booking" page key, which already
merges both collections, so veraEntries stays at exactly 22. This is the same trick the
four auth routes use (all → vera_auth/main). The pending-until-webhook state reuses the
existing processing_title / processing_body / processing_step keys.

SSR ACCESS — new src/server/vera/booking-session.ts. The manage token is mirrored into
an HttpOnly, SameSite=Lax cookie scoped to Path=/booking, set by the bookings create
route. The /api paths never receive it, so state-changing calls still require the
explicit bearer header and cannot be driven cross-origin; the cookie only lets the two
id-scoped pages resolve the booking server-side, exactly like account/profile.astro.
A signed-in owner still resolves by session. SameSite=Lax is what lets the cookie
survive Stripe's redirect back to the confirmation route.

PAYMENT LEFT ALONE — hosted Checkout is still tried first with the inline Elements
fallback behind it, unchanged from the single page. loadStripe, confirmCardPayment and
the publishable-key path are all still there, per B1/B2 being the user's own work.

Shared client spine: src/scripts/vera/booking/shared.ts (request envelope, money/date
formatting, and the session-storage selection + access records that carry state across
the real navigations that replaced panel switching).
Shared progress trail: src/components/vera/booking/BookingProgress.astro.

Tests updated: "booking shell delegates..." became "booking routes delegate..." and now
asserts each guarantee on the route that owns it; posthog-analytics splits the
payment_failed / scheduling_retry_requested assertions across payment and confirmation.
Both kept every original guarantee. Routes added to template.manifest.json
visitorRoutes, to manifest.test.mjs, and to the Vera-frame coverage list. /booking stays
indexable; "/booking/" is added to ROBOTS_DISALLOW so the transactional steps are not.

Gotcha worth knowing: the Astro frontmatter parser reads a `/` division sitting next to
a template literal inside a ternary as the start of a regex literal, and fails with
"Expression expected" pointing at the closing `---`. Split such expressions over
statements (see payment.astro durationCopy).

NOT VERIFIED IN A BROWSER. The routes typecheck, build and pass the contract tests, but
no page was loaded end-to-end: local D1 was empty after the miniflare reset described in
section A, and port 4321 is held by the stripe-listen dev server. Worth a manual pass
through /booking → details → payment → confirmation before this ships.
