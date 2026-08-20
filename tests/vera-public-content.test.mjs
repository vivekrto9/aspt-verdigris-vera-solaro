import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Vera source anchors remain the Verdigris public content defaults", async () => {
  const {
    homeDefaults,
    homeSectionsDefaults,
    articleDefaults,
    lettersDefaults,
    legalDefaults,
  } = await import("../src/data/vera/content.ts");

  assert.equal(homeDefaults.hero_title, "The sky kept a note for you.");
  assert.match(homeDefaults.hero_body, /No apps, no algorithms/);
  assert.equal(homeSectionsDefaults.reading_2_title, "The Year Ahead");
  assert.equal(homeSectionsDefaults.reading_2_price, "$385");
  assert.equal(articleDefaults.back_label, "← All writing");
  assert.equal(articleDefaults.read_next_title, "Read next");
  assert.equal(lettersDefaults.sample_meta, "Letter no. 337 · New moon, 14 July 2026");
  assert.match(lettersDefaults.section_3_p3, /Revise the thing twice, not nine times/);
  assert.match(legalDefaults.section_2_p2, /Optional PostHog analytics runs only after you allow it/);
  assert.doesNotMatch(legalDefaults.section_2_p2, /no tracking pixel/i);
  assert.doesNotMatch(legalDefaults.section_5_p1, /no analytics/i);
});

test("every Vera Content Studio collection remains below the 84 editable-field ceiling", async () => {
  const { veraEntries } = await import("../src/data/vera/content.ts");
  const { getBuilderEntryConfig, getBuilderReleaseTargets } = await import("../src/builder/registry.ts");

  const releaseKeys = new Set(
    getBuilderReleaseTargets().map((target) => `${target.collection}/${target.entry}`),
  );
  assert.equal(releaseKeys.size, veraEntries.length);
  assert.equal(veraEntries.length, 22, "the source template stays within the existing 22 Studio entries");

  for (const definition of veraEntries) {
    const key = `${definition.collection}/${definition.entry}`;
    assert.equal(releaseKeys.has(key), true, `${key} must be included in release snapshots`);
    const config = getBuilderEntryConfig(definition.collection, definition.entry);
    assert.ok(config, `${key} must have a Builder entry config`);
    assert.ok(
      config.collectionConfig.fields.length <= 84,
      `${definition.collection} has ${config.collectionConfig.fields.length} editable fields`,
    );
  }
});

test("all canonical public routes mount the Vera frame and editable page content", () => {
  const routes = [
    "src/pages/index.astro",
    "src/pages/readings.astro",
    "src/pages/readings/[service].astro",
    "src/pages/booking.astro",
    "src/pages/booking/[id]/confirmation.astro",
    "src/pages/writing.astro",
    "src/pages/writing/[slug].astro",
    "src/pages/about.astro",
    "src/pages/questions.astro",
    "src/pages/contact.astro",
    "src/pages/legal.astro",
    "src/pages/letters.astro",
    "src/pages/account.astro",
    "src/pages/account/profile.astro",
    "src/pages/account/billing.astro",
    "src/pages/closed.astro",
    "src/pages/404.astro",
    "src/pages/login.astro",
    "src/pages/signup.astro",
    "src/pages/forgot-password.astro",
    "src/pages/reset-password.astro",
  ];

  for (const route of routes) {
    const source = read(route);
    assert.match(source, /loadPublicPageContent\(Astro,/);
    assert.match(source, /<VeraFrame/);
    assert.match(source, /builderEdit/);
  }

  assert.match(read("src/pages/booking/details.astro"), /Astro\.redirect\("\/booking", 302\)/);
  assert.match(read("src/pages/booking/[id]/payment.astro"), /\/confirmation/);
});

test("account access routes use one bounded Studio collection and never expose backend copy", async () => {
  const { authDefaults, veraPageTargets } = await import("../src/data/vera/content.ts");
  const manifest = JSON.parse(read("template.manifest.json"));
  const publicPage = read("src/builder/public-page.ts");
  const routes = [
    ["login", "src/pages/login.astro"],
    ["signup", "src/pages/signup.astro"],
    ["forgot_password", "src/pages/forgot-password.astro"],
    ["reset_password", "src/pages/reset-password.astro"],
  ];

  assert.ok(Object.keys(authDefaults).length <= 84);
  assert.equal(authDefaults.auth_eyebrow, "Your sittings");
  assert.match(authDefaults.login_intro, /reading room are kept here permanently/);
  assert.equal(manifest.localization.publicEditableEntries.includes("vera_auth/main"), true);
  assert.match(publicPage, /getSafePublicNextPath/);
  assert.match(publicPage, /destination\.origin !== url\.origin/);

  for (const [pageKey, route] of routes) {
    assert.deepEqual(veraPageTargets[pageKey], [{ collection: "vera_auth", entry: "main" }]);
    const source = read(route);
    assert.match(source, /loadPublicPageContent\(Astro,/);
    assert.match(source, /<VeraFrame/);
    assert.match(source, /builderEdit/);
    assert.doesNotMatch(source, /payload\.message|error\.message|\.textContent\s*=\s*["'`][A-Za-z]/);
    assert.doesNotMatch(source, /<BaseLayout|auth-body|auth-page|auth-panel/);
  }

  assert.match(read("src/pages/login.astro"), /data-next-path=\{safeNext\}/);
  assert.match(read("src/pages/signup.astro"), /data-login-path=\{loginHref\}/);
  // The reset link travels by email only and is never painted into the page.
  assert.doesNotMatch(read("src/pages/forgot-password.astro"), /resetUrl|forgot_reset_url_prefix/);
});

test("account access forms validate fields locally and name every failure in Studio copy", async () => {
  const { authDefaults } = await import("../src/data/vera/content.ts");
  const shared = read("src/scripts/vera/auth/forms.ts");
  const validated = [
    ["src/pages/login.astro", ["email", "password"], "login_rate_limited_status"],
    ["src/pages/forgot-password.astro", ["email"], "forgot_rate_limited_status"],
    ["src/pages/reset-password.astro", ["password", "confirmPassword"], "reset_rate_limited_status"],
  ];

  assert.equal(authDefaults.auth_email_invalid_error, "That does not look like an email address.");
  assert.equal(authDefaults.auth_password_short_error, "Eight characters or more, please.");

  // The shared spine decides which pre-rendered note is on screen; it must never
  // author a sentence, which is what keeps backend wording out of the Verdigris pages.
  assert.match(shared, /looksLikeEmail/);
  assert.match(shared, /aria-invalid/);
  assert.doesNotMatch(shared, /payload\.message|error\.message|\.textContent\s*=/);

  for (const [route, fields, rateLimitedKey] of validated) {
    const source = read(route);
    assert.match(source, /scripts\/vera\/auth\/forms\.ts/);
    assert.match(source, /submitIsAllowed/);
    assert.match(source, /failureState\(response\.status/);
    assert.match(source, new RegExp(`data-auth-status="rate-limited"`));
    assert.match(source, new RegExp(`content\\.${rateLimitedKey}`));
    assert.ok(authDefaults[rateLimitedKey].length > 0);
    for (const field of fields) {
      assert.match(source, new RegExp(`data-field-error="${field}"`));
    }
  }

  // A spent reset link is the one failure the reader can act on, so it keeps its own
  // note and its own way out rather than folding into the generic error.
  assert.match(read("src/pages/reset-password.astro"), /invalidOnBadRequest: true/);
  assert.match(read("src/styles/vera.css"), /\.vera-input\[aria-invalid="true"\]/);
});

test("source media stays in the home slots and the shared article stand-in", () => {
  // Article artwork is the drawn `blog-*` plates until the owner supplies per-article media;
  // `src/data/blog-posts.ts` is their single owner, so routes and components still may not
  // reach for any seeded alias directly. The three photographs remain in the seed library for
  // the owner to place, which is why nothing here requires them to be referenced in code.
  const home = read("src/pages/index.astro");
  const blogData = read("src/data/blog-posts.ts");
  const authorized = `${home}\n${blogData}`;
  const otherVeraSources = [
    ...fs.readdirSync(path.join(root, "src/pages"), { recursive: true }),
    ...fs.readdirSync(path.join(root, "src/components/vera"), { recursive: true }),
  ]
    .filter((entry) => typeof entry === "string" && entry.endsWith(".astro"))
    .map((entry) => {
      const pagePath = path.join(root, "src/pages", entry);
      const componentPath = path.join(root, "src/components/vera", entry);
      if (fs.existsSync(pagePath) && path.relative(root, pagePath) !== "src/pages/index.astro") {
        return fs.readFileSync(pagePath, "utf8");
      }
      return fs.existsSync(componentPath) ? fs.readFileSync(componentPath, "utf8") : "";
    })
    .join("\n");

  for (const alias of ["vera-portrait", "ephemeris-pages", "brass-protractor", "night-sky"]) {
    assert.doesNotMatch(otherVeraSources, new RegExp(`aliases/${alias}/`));
  }
  for (const alias of [
    "blog-saturn-transit",
    "blog-drawn-by-hand",
    "blog-ephemeris-desk",
    "blog-zodiac-wheel",
    "blog-night-sky",
    "blog-retrograde-loop",
  ]) {
    assert.match(blogData, new RegExp(`aliases/${alias}/`));
    assert.doesNotMatch(otherVeraSources, new RegExp(`aliases/${alias}/`));
  }
  assert.match(home, /aliases\/vera-portrait\//);
  assert.match(authorized, /aliases\/vera-portrait\//);
});

test("the owner-approved About portrait stays in its registered hero slot", () => {
  const about = read("src/pages/about.astro");
  const manifest = JSON.parse(read("astropages/assets.manifest.json"));
  const portrait = manifest.assets.find((asset) => asset.alias === "about-vera-portrait");

  assert.match(about, /aliases\/about-vera-portrait\/about-vera-portrait\.jpg/);
  assert.match(about, /alt=\{content\.portrait_alt\}/);
  assert.equal(portrait?.source, "about-vera-portrait.jpg");
  assert.equal(portrait?.mimeType, "image/jpeg");
});

test("article artwork loads without a lazy-image deadlock and stays aligned", () => {
  const article = read("src/pages/writing/[slug].astro");
  const styles = read("src/styles/vera.css");

  assert.match(article, /class="vera-article-figure" eager/);
  assert.match(styles, /\.vera-image--pending > img\s*{\s*opacity: 0;/);
  assert.doesNotMatch(styles, /\.vera-image--pending > img,\s*\.vera-image--missing > img/);
  assert.match(styles, /\.vera-journal-card\s*{[\s\S]*grid-template-rows: 210px minmax\(0, 1fr\)/);
  assert.match(styles, /\.vera-article-figure\s*{[\s\S]*aspect-ratio: 5 \/ 3/);
});

test("Vera uses the existing manifests without JSON sidecars", () => {
  const manifestNames = fs.readdirSync(path.join(root, "astropages"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(manifestNames, [
    "assets.manifest.json",
    "email-templates.manifest.json",
    "leads.manifest.json",
    "sales.manifest.json",
    "secrets.manifest.json",
    "users-data.manifest.json",
  ]);
  for (const name of [
    `asset${"-usage"}.manifest.json`,
    `source${"-provenance"}.json`,
    `content${"-state"}.json`,
  ]) {
    assert.equal(fs.existsSync(path.join(root, "astropages", name)), false);
  }
});

test("booking wizard preserves live slots and delegates hosted payment without fake success", async () => {
  const times = read("src/pages/booking.astro");
  const details = read("src/pages/booking/details.astro");
  const payment = read("src/pages/booking/[id]/payment.astro");
  const confirmation = read("src/pages/booking/[id]/confirmation.astro");
  const shared = read("src/scripts/vera/booking/shared.ts");
  const booking = [times, details, payment, confirmation, shared].join("\n");
  const styles = read("src/styles/vera.css");
  const { bookingDefaults } = await import("../src/data/vera/content.ts");

  // Step one still owns the live calendar.
  assert.match(times, /data-calendly-slot-mount/);
  assert.match(times, /data-calendly-live-slots/);
  assert.match(times, /data-calendly-month-grid/);
  assert.match(times, /data-calendly-prev-month/);
  assert.match(times, /data-calendly-next-month/);
  assert.match(times, /class="vera-calendar-grid-shell"/);
  assert.match(times, /data-calendly-month-loading[\s\S]*role="status"/);
  assert.match(times, /let calendarLoading = true/);
  assert.match(times, /renderCalendarGrid\(\);\s*void initializeBooking\(\)/);
  assert.match(times, /vera-actions vera-booking-primary-actions/);
  assert.match(times, /renderCalendarGrid/);
  assert.match(times, /data-booking-open-waitlist/);
  assert.match(styles, /\.vera-calendar-loading\s*{[\s\S]*position: absolute/);
  assert.match(styles, /\.vera-booking-primary-actions\s*{\s*justify-content: flex-end/);

  // Details and payment are local panels in the same wizard. No PII is persisted.
  assert.match(times, /data-booking-place-suggestions/);
  assert.match(times, /data-booking-place-error/);
  assert.match(times, /data-booking-intake-error="name"/);
  assert.match(times, /data-booking-intake-error="birth-time"/);
  assert.match(times, /data-booking-intake-error="consent"/);
  assert.doesNotMatch(times, /name="birth-time-unknown"/);
  assert.doesNotMatch(times, /name="birth-time-approximation"/);
  assert.match(times, /name="gender"/);
  assert.match(times, /gender: genderField\?\.value/);
  assert.match(times, /data-booking-review-service/);
  assert.match(times, /data-booking-review-total/);
  assert.match(times, /checkout-session/);
  assert.match(times, /kind: "full"/);
  assert.doesNotMatch(times, /data-stripe-elements-mount|loadStripe|confirmCardPayment/);
  assert.match(details, /Astro\.redirect\("\/booking", 302\)/);
  assert.match(payment, /\/confirmation/);

  // Step four is server-rendered from the booking and waits on the webhook.
  assert.match(confirmation, /data-booking-confirmed-reference/);
  assert.match(confirmation, /data-booking-confirmed-email-ledger/);
  assert.match(confirmation, /data-account-panel-link="reschedule"/);
  assert.match(confirmation, /data-account-panel-link="receipt"/);
  assert.match(confirmation, /data-booking-add-calendar/);
  assert.match(confirmation, /loadVeraBookingForPage/);
  assert.match(confirmation, /booking\.confirmationState/);
  assert.match(confirmation, /data-booking-state-panel/);
  assert.match(confirmation, /35 \* 60_000/);
  assert.match(confirmation, /elapsed < 60_000 \? 2_000 : 10_000/);
  assert.match(confirmation, /data-booking-retry-payment/);
  assert.match(confirmation, /data-booking-payment-status/);
  assert.match(confirmation, /data-booking-scheduling-status/);
  assert.match(confirmation, /data-booking-state-when/);
  assert.match(confirmation, /data-booking-check-feedback/);
  assert.match(confirmation, /aria-busy/);
  assert.match(confirmation, /data-booking-payment-dialog/);
  assert.match(confirmation, /role="dialog"/);
  assert.match(confirmation, /data-booking-confirm-payment/);
  assert.match(confirmation, /paymentDialogFocusables/);
  assert.match(confirmation, /loadVeraBookingForPage\(\{ env: env as never, request: Astro\.request, bookingId \}\)/);
  assert.match(confirmation, /if \(!status\.ok\) return Astro\.redirect\("\/booking", 302\)/);
  assert.match(times, /data-booking-state="waitlist"/);

  assert.match(shared, /const apiBase = "\/api\/astropages\/generated-site\/vera"/);
  assert.match(shared, /envelope\.status !== "ready"/);
  assert.match(confirmation, /tel:\+390405550112/);
  assert.doesNotMatch(booking, /reportValidity\(/);
  assert.equal(bookingDefaults.summary_kicker, "Your sitting");
  assert.equal(bookingDefaults.summary_balance_template, "Then {{ balance }} after the sitting");
  assert.equal(bookingDefaults.confirmed_sitting_label, "The sitting");
  assert.equal(bookingDefaults.confirmed_calendar_cta, "Add to calendar");
  assert.equal(bookingDefaults.confirmed_move_cta, "Move the date");
  assert.equal(bookingDefaults.confirmed_receipt_cta, "Download receipt");
  assert.match(bookingDefaults.payment_policy_1, /Moving the date\./);
  assert.match(bookingDefaults.payment_policy_2, /If Vera cancels/);
  assert.equal(
    bookingDefaults.birth_time_approx_options,
    "Small hours\nMorning\nAround midday\nAfternoon\nEvening\nNo idea at all",
  );
  assert.match(bookingDefaults.validation_errors, /Vera needs a name for the chart/);
  assert.match(bookingDefaults.confirmed_email_headers, /Subject: Your sitting is held/);
  assert.match(booking, /window\.astroPagesTrack|track\(/);
  assert.doesNotMatch(booking, /astropages:booking-confirmed/);
  assert.doesNotMatch(booking, /window\.posthog/);
  assert.doesNotMatch(booking, /name="card-number"|autocomplete="cc-number"/);
  assert.doesNotMatch(booking, /name="slot"[^>]*checked/);
});

test("account, letters, and forms expose source-faithful integration states", async () => {
  const { accountDefaults, bookingDefaults, contactDefaults, lettersDefaults } = await import(
    "../src/data/vera/content.ts"
  );
  const account = read("src/pages/account.astro");
  const billing = read("src/pages/account/billing.astro");
  const portalNav = read("src/components/vera/VeraPortalNav.astro");
  const contact = read("src/pages/contact.astro");
  const letters = read("src/pages/letters.astro");
  const frame = read("src/components/vera/VeraFrame.astro");

  assert.equal(
    bookingDefaults.gift_error,
    "That code isn't in the book — check the card it came on",
  );
  assert.equal(
    bookingDefaults.birth_place_error,
    "The place sets the whole frame — town and country, please",
  );
  assert.equal(contactDefaults.email_error, "An email address, so Vera can write back");
  assert.equal(lettersDefaults.confirmed_kicker, "You're in the book");

  assert.match(account, /data-account-loading/);
  assert.match(account, /<VeraPortalNav/);
  for (const panel of ["overview", "reschedule", "cancel", "receipt", "room"]) {
    assert.match(account, new RegExp(`data-account-panel="${panel}"`));
  }
  assert.match(account, /\/api\/astropages\/generated-site\/vera\/account/);
  assert.match(account, /\/login\?next=%2Faccount/);
  assert.match(account, /"x-csrf-token": portal\.csrfToken/);
  assert.match(account, /availabilityEndpoint/);
  assert.match(account, /searchParams\.set\("serviceSlug"/);
  assert.match(account, /\/reschedule/);
  assert.match(account, /\/cancel/);
  assert.match(account, /\/account\/messages/);
  assert.match(account, /\/account\/files\//);
  assert.doesNotMatch(account, /<nav class="vera-account-nav"/);
  assert.doesNotMatch(account, /<button[^>]+data-account-nav-button/);
  assert.match(account, /window\.location\.hash\.replace/);
  assert.match(account, /prepareAccountPanel\(initialPanel\)/);
  assert.match(account, /data-account-report-download/);
  assert.match(account, /data-account-chart-download/);
  assert.match(account, /data-account-files-ledger/);
  assert.match(account, /data-account-five-year/);
  assert.match(account, /room_destroy_note/);
  assert.match(account, /birthTimeApproximation/);
  assert.equal(accountDefaults.room_intro.startsWith("Everything from that sitting lives here permanently"), true);
  assert.equal(accountDefaults.room_files_title, "Everything from this sitting");
  assert.equal(accountDefaults.room_five_year_title, "Five years on");
  assert.equal(accountDefaults.room_chart_download_cta, "Download scan");
  assert.match(billing, /getVeraAccountPortal/);
  assert.match(billing, /portal\.invoices/);
  assert.match(billing, /data-account|VeraPortalNav/);
  assert.match(portalNav, /\/account\/billing/);
  assert.doesNotMatch(portalNav, /\/account\/profile/);
  assert.doesNotMatch(portalNav, /\/account\/recordings|\/account\/messages/);
  assert.match(portalNav, /AccountActions/);
  assert.match(account, /body\?\.status === "ready"/);
  assert.doesNotMatch(account, /\.innerHTML\s*=/);
  assert.match(contact, /data-contact-error/);
  assert.match(contact, /\/api\/astropages\/generated-site\/vera\/contact/);
  assert.match(contact, /consentContact: true/);
  assert.match(contact, /result\?\.status !== "ready"/);
  assert.doesNotMatch(contact, /note_placeholder/);
  assert.doesNotMatch(contact, /astropages:contact-submitted/);
  assert.match(frame, /\/api\/astropages\/generated-site\/vera\/newsletter/);
  assert.match(frame, /consentMarketing: true/);
  assert.match(frame, /result\?\.status !== "ready"/);
  assert.match(frame, /astropages:newsletter-pending/);
  assert.match(letters, /searchParams\.get\("confirmed"\)/);
  assert.match(letters, /data-letter-confirmed/);
});

test("source reading, letter, writing, and closed screens stay reachable", async () => {
  const {
    aboutDefaults,
    chromeDefaults,
    contactDefaults,
    lettersDefaults,
    notFoundDefaults,
    readingsDefaults,
  } = await import("../src/data/vera/content.ts");
  const readings = read("src/components/vera/ReadingsCatalog.astro");
  const readingRoute = read("src/pages/readings/[service].astro");
  const letters = read("src/pages/letters.astro");
  const writing = read("src/pages/writing.astro");
  const article = read("src/pages/writing/[slug].astro");
  const questions = read("src/pages/questions.astro");
  const closed = read("src/pages/closed.astro");
  const header = read("src/components/vera/VeraHeader.astro");
  const footer = read("src/components/vera/VeraFooter.astro");
  const contact = read("src/pages/contact.astro");

  assert.equal(readingsDefaults.detail_questions_heading, "Questions people ask first");
  assert.match(readings, /vera-reading-detail__grid/);
  assert.match(readings, /detailFaqs = \[1, 2, 3, 4, 5\]/);
  assert.match(readings, /data-reading-books-open/);
  assert.match(readings, /data-reading-books-closed/);
  assert.match(readings, /data-reading-availability-error/);
  assert.match(readings, /readWindow\("call"/);
  assert.match(readings, /readWindow\("in_person"/);
  assert.match(readings, /Promise\.allSettled/);
  assert.match(readings, /reading-availability:\$\{serviceSlug\}/);
  assert.match(readings, /expiresAt: Date\.now\(\) \+ 5 \* 60_000/);
  assert.match(readings, /href=\{`\/booking\?service=\$\{selectedService\.slug\}`\}/);
  assert.doesNotMatch(readingRoute, /searchParams\.get\("books"\)/);
  assert.match(readingRoute, /service_\$\{selected\}_seo/);
  assert.match(readingRoute, /seo_canonical_path: serviceSeoCanonical/);
  assert.match(readingRoute, /"@type": "Service"/);
  assert.match(readingRoute, /buildBreadcrumbJsonLd/);
  assert.match(readingRoute, /buildFaqJsonLd/);

  for (const state of ["signup", "pending", "confirmed", "sample"]) {
    assert.match(letters, new RegExp(`data-letter-screen="${state}"`));
  }
  assert.match(letters, /pending_preview_subject/);
  assert.match(letters, /sample_author_alt/);
  assert.match(letters, /data-letter-resent/);
  assert.equal(lettersDefaults.pending_kicker, "One step left");
  assert.equal(lettersDefaults.confirmed_kicker, "You're in the book");

  assert.match(writing, /listBlogPosts\(locale\)/);
  assert.match(writing, /listBlogCategories\(posts\)/);
  assert.doesNotMatch(writing, /article_\d_title/);
  assert.doesNotMatch(writing, /href="\/writing\/[a-z-]+"/);
  assert.match(writing, /writing_meta_count/);
  assert.match(writing, /writing_meta_note/);
  assert.match(writing, /writing_empty_title/);
  // The listed pieces sit in their own section; a filter that matches only the featured
  // piece has to collapse that section rather than leave an empty band of padding.
  assert.match(writing, /data-writing-list/);
  assert.match(writing, /writingList\.hidden =/);
  assert.match(article, /getBlogPost\(slug, locale\)/);
  assert.match(article, /PortableText/);
  // An article shows only what the piece actually carries. Neither author avatar had an image
  // behind it, so the page renders the byline and the bio as text rather than empty frames.
  assert.doesNotMatch(article, /author_alt/);
  assert.match(article, /article_byline/);
  assert.match(article, /author_bio/);
  assert.match(article, /buildArticleJsonLd/);
  assert.match(article, /buildBreadcrumbJsonLd/);
  assert.equal(aboutDefaults.about_eyebrow, "About");
  assert.match(questions, /buildFaqJsonLd/);
  assert.match(questions, /role="tablist"/);

  assert.equal(notFoundDefaults.not_found_symbol, "404");
  assert.equal(notFoundDefaults.not_found_home_cta, "The writing");
  assert.match(closed, /vera-closed-works/);
  assert.match(header, /vera-holiday-bar/);
  assert.match(header, /class="vera-nav__book"/);
  assert.equal(chromeDefaults.closed_notice.includes("ferragosto"), true);

  assert.equal(contactDefaults.success_kicker, "Note sent");
  assert.match(footer, /\/contact\?topic=gift-certificate/);
  assert.match(contact, /searchParams\.get\("topic"\) === "gift-certificate"/);
  assert.match(contact, /success_kicker/);
});

test("account signup copy opens the room immediately", async () => {
  const { authDefaults } = await import("../src/data/vera/content.ts");
  assert.equal(
    authDefaults.signup_success_status,
    "Your reading room is open. Taking you in.",
  );
  assert.equal(authDefaults.verification_success_status, "You're in the book");
  assert.equal(authDefaults.verification_invalid_status, "Wrong address? Start over");
});

test("Vera typography has no remote font stylesheet", () => {
  const styles = `${read("src/styles/vera.css")}\n${read("src/styles/verdigris.css")}`;
  const frame = read("src/components/vera/VeraFrame.astro");
  assert.doesNotMatch(styles, /fonts\.googleapis\.com|@import\s+url/);
  assert.match(frame, /@fontsource\/ultra\/400\.css/);
  assert.match(frame, /@fontsource\/rye\/400\.css/);
  assert.match(frame, /@fontsource\/newsreader\/300-italic\.css/);
  assert.match(frame, /@fontsource\/familjen-grotesk\/600\.css/);
});
