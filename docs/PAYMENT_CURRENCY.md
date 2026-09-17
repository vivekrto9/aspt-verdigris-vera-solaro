# Payment currency implementation

## Local acceptance

Status: **Done locally** on `feature/payment-preference`, based on `develop` at `8e3493486fbeede7bae149fa727fd1974f865b29`. Ported from the Retro Vera branch diff while preserving Verdigris's page layout.

The implementation keeps INR and USD as unrelated business prices. There is no FX arithmetic, exchange-rate lookup, or cross-currency fallback. The three catalog services have explicit values:

| Service | USD minor units | INR minor units |
| --- | ---: | ---: |
| Natal Hour | 24000 | 1990000 |
| Year Ahead | 38500 | 3150000 |
| Two Charts | 42000 | 3490000 |

The default deposit is independently stored as USD 8000 and INR 650000. All three services remain in the authoritative active catalog; the pre-existing public offering policy currently exposes Natal Hour in booking/cards while retaining detail/SEO and server catalog data for the other two.

## Behavior

- The project preference is `INR`, `USD`, or `AUTO`; migration `0019_payment_preference.sql` creates AUTO revision 1 without overwriting an existing preference.
- AUTO maps trusted Cloudflare country `IN` to INR/Razorpay and every other or unknown country to USD/Stripe. Direct localhost has no trusted country and therefore selects USD.
- Home, readings, detail JSON-LD, deposit copy, and booking labels use one request-scoped catalog. The catalog is private/no-store and shows only the selected denomination.
- Booking creation snapshots exact service price, deposit, and currency. Provider checkout is selected from that saved currency, so a later preference or country change cannot alter a retry or balance.
- Gifts are queried and applied only in the booking currency. Invoices, balances, refunds, emails, analytics, and account records retain saved money.
- Stripe and Razorpay order/session creation use server amounts only. Browser returns are processing/cancel navigation only; authentic signed webhooks are the sole settlement authority.
- Razorpay capture/failure/refund webhooks validate signature, local attempt/refund ownership, provider IDs, amount, currency, and event id. Duplicate delivery is idempotent. Stripe retains the corresponding existing authoritative checks.
- Signed GET/PATCH preference management uses exact project/environment/method/path/body hash/role claims plus optimistic revision control.

## Migration evidence

This theme had no prior local D1 database. Local migrations `0000`–`0019` created one successfully; AUTO preference, independent USD/INR deposits and all six service-price columns read back correctly. `PRAGMA foreign_key_check` returned no rows, `pnpm run d1:verify:local` passed, and `wrangler d1 migrations list --local` reported no migrations to apply.

## Verification evidence

- Baseline before implementation: `pnpm run test` — 219/219 passed.
- Focused contract: `node --test tests/payment-preference.test.mjs` — 7/7 passed, including unrelated ₹100/$2 values, signed settings auth/CAS, forced/AUTO geography, provider routing, Razorpay failure/capture/refund signatures, replay safety, invoices, and the no-conversion invariant.
- Existing Vera backend contract: `node --test tests/generated-site/vera-backend.test.mjs` — 34/34 passed after both-provider readiness was added.
- Typecheck: zero errors (two pre-existing unused-value hints).
- Production build: passed.
- Complete repository gate: `pnpm run verify` passed, including 226/226 tests, asset/sales/users/secrets contracts, safety scan, D1 schema contract, Cloudflare runtime contract, typecheck, and build.
- `node scripts/verification/currency-dev-browser.mjs` — 6/6 actual Astro DEV cases passed in one browser: forced INR/US, forced USD/IN, AUTO IN, AUTO NL, AUTO localhost/unknown, and returning AUTO IN. It verified catalog, home, readings, detail/deposit, booking labels, mobile overflow, and custom independent ₹100/$2 prices.
- `node scripts/verification/currency-matrix-browser.mjs` — 5/5 built production Worker cases passed. It verified exact provider request amounts/currencies, INR→Razorpay, USD→Stripe, authentic signed settlement webhooks, invoice creation, and persisted booking currency.
- Mobile Chromium screenshots of `/readings/natal-hour` confirmed Verdigris's preserved layout and correct INR rendering. The local browser matrix used provider fixtures, not a live Calendly or payment account.

Generated browser evidence is under `output/playwright/currency-dev/` and `output/playwright/currency-matrix/`.

## Production pending

No remote D1 migration, deployment, real provider order/charge/refund, provider-dashboard webhook registration, hosted payment completion, production email delivery, or production control-plane preference change was performed. Those remain production acceptance work. Local signed fixtures prove the application contracts, not provider-dashboard delivery. Production readiness requires both Stripe and Razorpay credentials/signing secrets and the existing scheduling, email, analytics, storage, origin, and webhook readiness checks.
