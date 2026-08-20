# AstroPages Leads (`leads.v1`)

This file is the implementation reference for the Vera Solaro site. Its inherited AstroPages substrate provides the generic D1 contract and server helpers, but intentionally does not expose a standalone public lead endpoint or ship unbounded vertical forms.

## Source of truth

- `astropages/leads.manifest.json` defines the semantic model, kinds, sources, and the only detail fields that may be persisted.
- `migrations/0005_leads.sql` creates `ap_leads`, its indexes, and the privacy-safe `ap_business_events` timeline.
- `src/server/aggregator/lead-records.ts` validates contact details, records consent, normalizes identifiers, allowlists JSON, deduplicates records, and links conversions.
- `src/server/aggregator/db/tables.ts` owns table names.
- `tests/generated-site/lead-records.test.mjs` protects the reusable behavior.

Do not create a second lead table, put unbounded request bodies into `details_json`, or log contact/birth data.

## Canonical sources

| Source | Kind | When to link |
| --- | --- | --- |
| `consultation_booking` | `consultation` | After the `ap_vera_bookings` row and slot hold are created |
| `waitlist` | `waitlist` | After the `ap_vera_waitlist_entries` row is created or idempotently updated |
| `newsletter` | `newsletter` | After double opt-in confirmation activates the subscription |
| `contact` | `contact` | After the validated `ap_vera_contact_requests` row is created |

The manifest lists the allowed `details` keys for each source. Add a key to the manifest only when the product flow genuinely needs it and add a test proving unexpected fields are discarded.

## Wiring a business form

Persist the authoritative Vera booking, waitlist, or contact row first. Then call `linkBusinessLead`; the source record remains successful if the lead migration is temporarily unavailable.

```ts
import { linkBusinessLead } from "../aggregator/lead-records.ts";

await linkBusinessLead({
  env,
  submission: {
    kind: "consultation",
    source: "consultation_booking",
    formKey: "vera-booking",
    pagePath: "/booking",
    locale: "en",
    fullName: name,
    email,
    phone: rawPhone,
    sourceReferenceType: "vera_booking",
    sourceReferenceId: booking.id,
    details: {
      bookingNumber: number,
      serviceSlug: selection.slug,
      serviceName: selection.name,
      consultationMode: input.mode === "in_person" ? "in person" : "call",
      consultationDate: startAt.slice(0, 10),
      consultationSlot: startAt,
      paymentOption,
      amountCents: selection.priceCents,
      currency: selection.currency,
    },
  },
});
```

`linkBusinessLead` uses `<sourceReferenceType>:<sourceReferenceId>` as the deterministic dedupe key. Retries update the same lead instead of creating duplicates.

For contact and waitlist forms, require `consentContact: true`, write the authoritative Vera row, and link it using `sourceReferenceType` values `vera_contact_request` and `vera_waitlist_entry`. The source row ID is the deterministic lead reference; never send message bodies, birth details, or arbitrary form payloads in lead details.

For newsletters, call `linkNewsletterLead` only after the confirmation token succeeds and the subscription becomes active. It deduplicates by normalized email and records both contact and marketing consent; the initial subscription request is not a confirmed marketing lead.

## Payment conversion

After a verified payment transition succeeds, mark the linked lead converted:

```ts
await markLeadConvertedBySourceReference({
  env,
  sourceReferenceType: "vera_booking",
  sourceReferenceId: booking.id,
  conversionReference: paymentReference,
});
```

Call this after the authoritative paid-state update. The helper is non-blocking when the leads migration has not reached an older deployment.

## Privacy and validation

- Booking, contact, and waitlist capture require a name, valid email, and explicit contact consent; an optional phone must pass the shared phone validator.
- Newsletter capture requires a valid email, explicit marketing consent, and successful double opt-in confirmation before lead linkage.
- Store marketing consent separately; never infer it from ordinary contact consent.
- `attribution_json` accepts only UTM fields and `referrer`.
- `details_json` accepts only the source fields declared in the manifest plus `tool`.
- Business events contain only `kind`, `source`, and `formKey`; never contact or birth details.
- Do not expose a generic unauthenticated endpoint that accepts arbitrary lead payloads.
- Never print contact fields, birth details, tokens, or payment payloads in logs.

## Agent checklist for this site

1. Read the existing form/order implementation before changing it.
2. Keep the `leads.v1` table contract and the exact four manifest sources aligned with the Vera implementation.
3. Create the authoritative source row before linking the lead.
4. Map the source to one canonical kind and source name.
5. Pass only manifest-allowlisted `details`.
6. Use the source row ID for deterministic dedupe.
7. Make lead linking non-blocking so existing checkout/forms do not regress during rolling migrations.
8. Mark the lead converted only after a verified payment succeeds.
9. Add focused tests for validation, allowlisting, dedupe, missing-table compatibility, and conversion.
10. Apply migrations to a fresh local D1 database, exercise the real form/API, query `ap_leads`, then run the full repository verification gate.

## Local verification

Install dependencies and apply migrations:

```sh
pnpm install
pnpm run d1:migrate:local
pnpm run d1:verify:local
```

Inspect the latest records:

```sh
pnpm wrangler d1 execute aspt-verdigris-vera-solaro-site --local --command \
"SELECT id, kind, source, full_name, email, phone, details_json, created_at
 FROM ap_leads
 ORDER BY created_at DESC
 LIMIT 5;"
```

Run the focused and full gates:

```sh
node --test tests/generated-site/lead-records.test.mjs
pnpm run verify
git diff --check
```

For isolated testing, pass `--persist-to <temporary-directory>` to both the migration and query commands so existing local D1 data is not modified.
