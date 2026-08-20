import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("email-template control-plane contract is declared and service authenticated", async () => {
  const manifest = JSON.parse(read("astropages/email-templates.manifest.json"));
  assert.equal(manifest.contractVersion, "transactional-email.v1");
  assert.equal(manifest.eventsTable, "ap_email_events");
  assert.equal(
    manifest.variableMappingsTable,
    "ap_email_variable_mappings",
  );
  assert.equal(
    manifest.templates.every(
      (entry) =>
        entry.key &&
        entry.eventType &&
        entry.audience &&
        entry.variables.length,
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify({
      variables: manifest.templates.flatMap((entry) => entry.variables),
      safeVariableSources: manifest.safeVariableSources,
    }),
    /password|secret|token|credential/i,
  );
  for (const file of ["index.ts", "render.ts", "test-send.ts", "publish.ts"]) {
    const path = `src/pages/api/astropages/generated-site/email-templates/${file}`;
    assert.equal(existsSync(new URL(path, root)), true);
    assert.match(read(path), /requireContentReleaseServiceAuth/);
  }

  const { projectEmailMcpTools } = await import(
    "../../src/server/generated-site/email-templates-mcp.ts"
  );
  assert.deepEqual(
    projectEmailMcpTools.map((tool) => tool.name),
    [
      "email_template_list",
      "email_template_get",
      "email_event_list",
      "email_event_save",
      "email_variable_catalog",
      "email_variable_add_mapping",
      "email_template_save_preview",
      "email_template_save_draft",
      "email_template_render_sample",
    ],
  );
  assert.equal(
    projectEmailMcpTools.some((tool) => tool.name.includes("publish")),
    false,
  );
});

test("email events are definitions, not SES delivery history", async () => {
  const migrationName = readdirSync(new URL("migrations/", root))
    .find((name) => name.endsWith("_email_template_management.sql"));
  assert.ok(migrationName);
  const migration = read(`migrations/${migrationName}`);
  const eventDefinition =
    migration.match(
      /CREATE TABLE IF NOT EXISTS ap_email_events \([\s\S]*?\n\);/,
    )?.[0] ?? "";
  assert.match(eventDefinition, /event_type TEXT PRIMARY KEY/);
  assert.doesNotMatch(
    eventDefinition,
    /recipient|provider_message_id|status TEXT/,
  );

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...next) {
          values = next;
          return this;
        },
        async first() {
          return statement.get(...values) ?? null;
        },
        async all() {
          return { results: statement.all(...values) };
        },
        async run() {
          return statement.run(...values);
        },
      };
    },
  };
  const { saveEmailEvent, saveManagedEmailTemplate } = await import(
    "../../src/server/aggregator/notifications/email-template-store.ts"
  );
  await saveEmailEvent(
    { DB },
    {
      eventType: "system.test",
      audience: "customer",
      emailType: "transactional",
    },
  );
  const saved = await saveManagedEmailTemplate({
    env: { DB },
    actor: "contract-test",
    input: {
      key: "system_test_customer_en",
      displayName: "System test",
      eventType: "system.test",
      audience: "customer",
      locale: "en",
      subject: "Hello {{customerName}}",
      htmlBody: "<p>Hello {{customerName}}</p>",
      textBody: "Hello {{customerName}}",
      requiredVariables: ["customerName"],
      samplePayload: { customerName: "Asha" },
    },
  });
  assert.equal(saved.ok, true);
  const columns = sqlite.prepare("PRAGMA table_info(ap_email_events)")
    .all()
    .map((row) => row.name);
  assert.equal(columns.includes("event_type"), true);
  assert.equal(columns.includes("recipient"), false);
});

test("managed HTML templates escape event values before rendering", async () => {
  const { renderEmailTemplate } = await import(
    "../../src/server/aggregator/notifications/templates.ts"
  );
  const rendered = renderEmailTemplate({
    template: {
      subject: "Hello {{customerName}}",
      htmlBody: '<p title="{{customerName}}">Hello {{customerName}}</p>',
      textBody: "Hello {{customerName}}",
      requiredVariables: ["customerName"],
    },
    payload: { customerName: '<img src=x onerror="alert(1)">' },
  });

  assert.equal(rendered.ok, true);
  assert.equal(
    rendered.htmlBody,
    '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;">Hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
  );
  assert.equal(rendered.subject, 'Hello <img src=x onerror="alert(1)">');
  assert.equal(rendered.textBody, 'Hello <img src=x onerror="alert(1)">');
});

test("email manifest enumerates every editable template seeded by migrations", () => {
  const manifest = JSON.parse(read("astropages/email-templates.manifest.json"));
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    // D1 applies each migration file inside a single transaction.
    sqlite.exec("BEGIN");
    sqlite.exec(read(`migrations/${migration}`));
    sqlite.exec("COMMIT");
  }
  const rows = sqlite.prepare(
    "SELECT key, display_name, event_type, audience, locale, required_variables_json FROM ap_email_templates ORDER BY key",
  ).all();
  const declared = [...manifest.templates]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((entry) => ({
      key: entry.key,
      display_name: entry.displayName,
      event_type: entry.eventType,
      audience: entry.audience,
      locale: entry.locale,
      variables: entry.variables,
    }));
  const seeded = rows.map((row) => ({
    key: row.key,
    display_name: row.display_name,
    event_type: row.event_type,
    audience: row.audience,
    locale: row.locale,
    variables: JSON.parse(row.required_variables_json),
  }));
  assert.deepEqual(declared, seeded);
});

test("Vera template seeds use the exact warm-source email and account wording", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    // D1 applies each migration file inside a single transaction.
    sqlite.exec("BEGIN");
    sqlite.exec(read(`migrations/${migration}`));
    sqlite.exec("COMMIT");
  }

  const expected = {
    vera_booking_action_required_en: {
      subject: "Payment confirmed — scheduling assistance required",
      preheader: "Your payment is safe and your selected time remains protected.",
      html_body: `<p>Dear {{customerName}},</p><p>Your payment for <strong>{{serviceName}}</strong> is confirmed.</p><p>Calendly could not create the appointment automatically for <strong>{{selectedSlot}}</strong>, but that selected time remains protected in Vera's booking system.</p><p>Do not pay or book again.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{confirmationUrl}}">View your booking status</a></p><p>Vera will help finalize the appointment once the scheduling connection is corrected.</p>`,
      text_body: "Dear {{customerName}}, Your payment for {{serviceName}} is confirmed. Calendly could not create the appointment automatically for {{selectedSlot}}, but that selected time remains protected in Vera's booking system. Do not pay or book again. Reference {{bookingNumber}} View your booking status {{confirmationUrl}} Vera will help finalize the appointment once the scheduling connection is corrected.",
    },
    vera_booking_confirmed_en: {
      subject: "Your {{serviceName}} sitting is confirmed",
      preheader: "Your payment is verified and your Calendly appointment is confirmed.",
      html_body: `<p>Dear {{customerName}},</p><p>Your payment is verified and your <strong>{{serviceName}}</strong> sitting is confirmed for <strong>{{scheduledDateTime}}</strong>.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{confirmationUrl}}">Open appointment details</a></p><p>You can review, reschedule or cancel the appointment from its secure details page.</p>`,
      text_body: `Dear {{customerName}}, Your payment is verified and your {{serviceName}} sitting is confirmed for {{scheduledDateTime}}. Reference {{bookingNumber}} Open appointment details {{confirmationUrl}} You can review, reschedule or cancel the appointment from its secure details page.`,
    },
    vera_booking_rescheduled_en: {
      subject: "Your sitting now stands at {{scheduledDateTime}}.",
      preheader: "Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you.",
      html_body: `<p>Dear {{customerName}},</p><p>Your sitting now stands at <strong>{{scheduledDateTime}}</strong>. Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you.</p><p>The sitting<br>{{serviceName}}</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>`,
      text_body: "Dear {{customerName}}, Your sitting now stands at {{scheduledDateTime}}. Vera has been told, the calendar is updated, and a fresh confirmation is on its way to you. The sitting {{serviceName}} Reference {{bookingNumber}} Back to your sittings {{accountUrl}}",
    },
    vera_booking_cancelled_en: {
      subject: "Cancelled",
      preheader: "Vera has your chart in the drawer if you'd like to come back to it.",
      html_body: `<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}</p><p>Reference<br>{{bookingNumber}}</p><p>Vera has your chart in the drawer if you'd like to come back to it.</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>`,
      text_body: "Dear {{customerName}}, The sitting {{serviceName}} Reference {{bookingNumber}} Vera has your chart in the drawer if you'd like to come back to it. Back to your sittings {{accountUrl}}",
    },
    vera_gift_issued_en: {
      subject: "Gift certificate",
      preheader: "The recipient books their own hour and gives their own birth details.",
      html_body: `<p>Dear {{customerName}},</p><p>The recipient books their own hour and gives their own birth details. The code goes in at payment.</p><p>{{giftAmount}}</p><p>Gift certificate<br><strong>{{giftCode}}</strong></p><p><a href="{{siteUrl}}">See the readings</a></p>`,
      text_body: "Dear {{customerName}}, The recipient books their own hour and gives their own birth details. The code goes in at payment. {{giftAmount}} Gift certificate {{giftCode}} See the readings {{siteUrl}}",
    },
    vera_newsletter_confirm_en: {
      subject: "Is this you?",
      preheader: "Vera will send one note to confirm it's really you. Nothing until you click it.",
      html_body: `<p>Dear {{customerName}},</p><p>Somebody put this address down for my monthly letter.</p><p><a href="{{confirmationUrl}}">Yes, it's me — add me to the list</a></p><p>If it wasn't you, do nothing whatsoever.</p><p>Vera</p><p>Via delle Stelle 12, Trieste · You are receiving this once, to confirm an address. No list has been joined yet.</p>`,
      text_body: "Dear {{customerName}}, Somebody put this address down for my monthly letter. Yes, it's me — add me to the list {{confirmationUrl}} If it wasn't you, do nothing whatsoever. Vera Via delle Stelle 12, Trieste · You are receiving this once, to confirm an address. No list has been joined yet.",
    },
    vera_newsletter_dispatch_en: {
      subject: "{{campaignSubject}}",
      preheader: "One letter a month. No horoscopes.",
      html_body: `<p>Dear {{customerName}},</p>{{campaignBody}}<p>Vera</p><p>Leaving the list is one click at the foot of any letter.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe whenever the mood strikes.</a></p>`,
      text_body: "Dear {{customerName}}, {{campaignBody}} Vera Leaving the list is one click at the foot of any letter. Unsubscribe whenever the mood strikes. {{unsubscribeUrl}}",
    },
    vera_balance_reminder_en: {
      subject: "Balance outstanding",
      preheader: "Due within three days of the sitting",
      html_body: `<p>Dear {{customerName}},</p><p>Balance of {{balanceAmount}} due within three days of the sitting.</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>`,
      text_body: "Dear {{customerName}}, Balance of {{balanceAmount}} due within three days of the sitting. Reference {{bookingNumber}} Back to your sittings {{accountUrl}}",
    },
    vera_intake_reminder_en: {
      subject: "Confirm your birth details",
      preheader: "Birth details stay private to Vera",
      html_body: `<p>Dear {{customerName}},</p><p>To draw a chart she needs your name, your date, time and place of birth, and an email address. That is the whole of it.</p><p>The sitting<br>{{scheduledDateTime}}</p><p>Reference<br>{{bookingNumber}}</p><p><a href="{{accountUrl}}">Manage this sitting →</a></p>`,
      text_body: "Dear {{customerName}}, To draw a chart she needs your name, your date, time and place of birth, and an email address. That is the whole of it. The sitting {{scheduledDateTime}} Reference {{bookingNumber}} Manage this sitting → {{accountUrl}}",
    },
    vera_session_reminder_en: {
      subject: "Before we sit",
      preheader: "Nothing else to prepare",
      html_body: `<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}<br>{{scheduledDateTime}}</p><p>{{meetingDetails}}</p><p>Bring three dated events</p><p>A move, a loss, and something that changed your work. Years are enough.</p><p>Nothing else to prepare</p><p>No reading list, no questions to draft. Come as you are, with an hour to spare afterwards.</p><p><a href="{{accountUrl}}">Manage this sitting →</a></p>`,
      text_body: "Dear {{customerName}}, The sitting {{serviceName}} {{scheduledDateTime}} {{meetingDetails}} Bring three dated events A move, a loss, and something that changed your work. Years are enough. Nothing else to prepare No reading list, no questions to draft. Come as you are, with an hour to spare afterwards. Manage this sitting → {{accountUrl}}",
    },
    vera_post_session_en: {
      subject: "After the sitting",
      preheader: "What arrives, when, and what to do with it six months later.",
      html_body: `<p>Dear {{customerName}},</p><p>The sitting<br>{{serviceName}}</p><p>The hand-drawn wheel (in your hands, or in the post), an audio recording the same evening, and a written summary posted within the week. Every reading also includes one follow-up question by email, answered properly.</p><p>Every sitting includes one question, answered properly and in writing. It doesn't expire — people have used theirs four years later, which Vera considers entirely reasonable.</p><p><a href="{{accountUrl}}">Open the reading room</a></p>`,
      text_body: "Dear {{customerName}}, The sitting {{serviceName}} The hand-drawn wheel (in your hands, or in the post), an audio recording the same evening, and a written summary posted within the week. Every reading also includes one follow-up question by email, answered properly. Every sitting includes one question, answered properly and in writing. It doesn't expire — people have used theirs four years later, which Vera considers entirely reasonable. Open the reading room {{accountUrl}}",
    },
    vera_report_ready_en: {
      subject: "The written summary",
      preheader: "Everything from that sitting lives here permanently.",
      html_body: `<p>Dear {{customerName}},</p><p>Everything from this sitting</p><p>{{reportTitle}}</p><p>Everything from that sitting lives here permanently.</p><p><a href="{{accountUrl}}">Open the reading room</a></p>`,
      text_body: "Dear {{customerName}}, Everything from this sitting {{reportTitle}} Everything from that sitting lives here permanently. Open the reading room {{accountUrl}}",
    },
    vera_receipt_en: {
      subject: "Receipt · {{bookingNumber}}",
      preheader: "Consulting astrologer · Via delle Stelle 12, 34121 Trieste, Italy",
      html_body: `<p>Vera Solaro</p><p>Consulting astrologer<br>Via delle Stelle 12, 34121 Trieste, Italy<br>P.IVA 00745620321</p><p>Receipt<br>{{bookingNumber}}</p><p>Billed to<br>{{customerName}}</p><p>Sitting<br>{{serviceName}}<br>{{scheduledDateTime}}</p><p>Total for the sitting<br>{{priceAmount}}</p><p>Paid to date<br>{{paidAmount}}</p><p>Balance due<br>{{balanceAmount}}</p><p>Payable within three days of the sitting</p><p><a href="{{accountUrl}}">Back to your sittings</a></p>`,
      text_body: "Vera Solaro Consulting astrologer Via delle Stelle 12, 34121 Trieste, Italy P.IVA 00745620321 Receipt {{bookingNumber}} Billed to {{customerName}} Sitting {{serviceName}} {{scheduledDateTime}} Total for the sitting {{priceAmount}} Paid to date {{paidAmount}} Balance due {{balanceAmount}} Payable within three days of the sitting Back to your sittings {{accountUrl}}",
    },
  };

  const rows = sqlite.prepare(
    "SELECT key, subject, preheader, html_body, text_body, required_variables_json FROM ap_email_templates WHERE key LIKE 'vera_%' ORDER BY key",
  ).all();
  assert.deepEqual(rows.map((row) => row.key), Object.keys(expected).sort());
  for (const row of rows) {
    assert.deepEqual(
      {
        subject: row.subject,
        preheader: row.preheader,
        html_body: row.html_body,
        text_body: row.text_body,
      },
      expected[row.key],
      `${row.key} must stay source-exact`,
    );
    const renderedFields = `${row.subject}\n${row.preheader}\n${row.html_body}\n${row.text_body}`;
    for (const variable of JSON.parse(row.required_variables_json)) {
      assert.match(renderedFields, new RegExp(`{{${variable}}}`), `${row.key} must render ${variable}`);
    }
  }

  const serialized = JSON.stringify(rows);
  assert.doesNotMatch(serialized, /Hello \{\{|Confirm your subscription|Your booking record has been updated|A private gift code is ready|private intake|is ready in your private account/i);
});

test("the customer password reset note carries the link, the expiry and a way out", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec("BEGIN");
    sqlite.exec(read(`migrations/${migration}`));
    sqlite.exec("COMMIT");
  }

  const row = sqlite.prepare(
    "SELECT subject, preheader, html_body, text_body, required_variables_json FROM ap_email_templates WHERE key = 'customer_password_reset_en'",
  ).get();

  assert.equal(row.subject, "Find your way back.");
  assert.equal(row.preheader, "One hour, one link, and your current password works until you use it.");
  assert.deepEqual(JSON.parse(row.required_variables_json), ["customerName", "resetUrl"]);

  // The renderer refuses any token that is not declared, so the body may only ever
  // reach for the two the aggregator actually sends.
  for (const body of [row.html_body, row.text_body]) {
    assert.match(body, /\{\{customerName\}\}/);
    assert.match(body, /\{\{resetUrl\}\}/);
    assert.deepEqual(
      [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort(),
      ["customerName", "resetUrl"],
    );
    // Reset mail without an expiry and a "not you" escape hatch is the old bare note.
    assert.match(body, /One hour from the moment this was sent/);
    assert.match(body, /do nothing whatsoever/);
    assert.match(body, /Vera/);
  }

  // The provider sends html_body verbatim, so it has to be a whole document rather
  // than the bare paragraphs it used to be.
  assert.match(row.html_body, /^<!doctype html>/i);
  assert.match(row.html_body, /<meta name="viewport"/);
  assert.match(row.html_body, /role="presentation"/);
  assert.match(row.html_body, /<a href="\{\{resetUrl\}\}"[^>]*>/);
  // A button alone strands anyone whose client blocks it, so the raw link stays too.
  assert.ok(row.html_body.split("{{resetUrl}}").length - 1 >= 2);
  // Verdigris palette, inline: chalk ground, ink border, berry call to action.
  for (const colour of ["#f4e4c5", "#fffdf6", "#2c1810", "#c6491f", "#3b1e36"]) {
    assert.ok(row.html_body.includes(colour), `html_body must carry ${colour}`);
  }
  // Nothing injects the stored preheader, so the document carries it itself.
  assert.ok(row.html_body.includes(row.preheader));
  // The plain-text alternative stays plain.
  assert.doesNotMatch(row.text_body, /<[a-z]/i);
});
