type D1BoundStatementLike = {
  first?: <T = Record<string, unknown>>() => Promise<T | null>;
  all?: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
};

type D1StatementLike = {
  bind: (...values: unknown[]) => D1BoundStatementLike;
  first?: <T = Record<string, unknown>>() => Promise<T | null>;
  all?: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
};

export type AnalyticsQueryDb = {
  prepare: (sql: string) => D1StatementLike;
};

export type AnalyticsDateRangeKey =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "last_3_months"
  | "this_month"
  | "last_month"
  | "this_year"
  | "all_time";

export type AnalyticsApiKey =
  | "booking_funnel"
  | "booking_status_breakdown"
  | "booking_revenue"
  | "booking_service_breakdown"
  | "booking_mode_breakdown"
  | "newsletter_summary"
  | "contact_summary"
  | "waitlist_summary";

type AnalyticsParams = {
  rangeKey: AnalyticsDateRangeKey;
  from: string | null;
  to: string | null;
  queryFrom: string | null;
  queryTo: string | null;
  timezone: string;
  label: string;
};

export type AnalyticsPlan =
  | {
      mode: "known_api";
      apiKey: AnalyticsApiKey;
      confidence: number;
      params: AnalyticsParams;
    }
  | {
      mode: "unsupported";
      confidence: number;
      reason: string;
      params: AnalyticsParams;
    };

export type AnalyticsQueryResponse = {
  answer: string;
  title?: string;
  range?: {
    from?: string;
    to?: string;
    label?: string;
  };
  metrics?: Array<{
    label: string;
    value: number | string;
    unit?: string;
  }>;
  rows?: Array<Record<string, unknown>>;
  plan?: Record<string, unknown>;
};

const supportedTopicsAnswer =
  "I can answer Vera Solaro questions about the booking funnel, booking and payment statuses, revenue, services, consultation modes, newsletter subscriptions, contact requests, and the waitlist.";

const pad = (value: number) => String(value).padStart(2, "0");

const isoDate = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const addCalendarDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const addCalendarMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

const parseNow = (now: string) => {
  const parsed = new Date(now);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const normalizeQuestion = (question: string) =>
  question.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

const includesAny = (value: string, patterns: RegExp[]) =>
  patterns.some((pattern) => pattern.test(value));

const supportedTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "Europe/Rome";
  }
};

const zonedParts = (date: Date, timezone: string) => {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
};

const startOfZonedDay = (calendarDate: Date, timezone: string) => {
  const target = Date.UTC(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth(), calendarDate.getUTCDate());
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = zonedParts(new Date(instant), timezone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    instant += target - represented;
  }
  return new Date(instant).toISOString();
};

const paramsFor = (
  rangeKey: AnalyticsDateRangeKey,
  from: Date | null,
  to: Date | null,
  label: string,
  timezone: string,
): AnalyticsParams => ({
  rangeKey,
  from: from ? isoDate(from) : null,
  to: to ? isoDate(to) : null,
  queryFrom: from ? startOfZonedDay(from, timezone) : null,
  queryTo: to ? startOfZonedDay(to, timezone) : null,
  timezone,
  label,
});

const resolveDateRange = (question: string, now: string, requestedTimezone: string): AnalyticsParams => {
  const timezone = supportedTimezone(requestedTimezone);
  const local = zonedParts(parseNow(now), timezone);
  const current = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const tomorrow = addCalendarDays(current, 1);
  const yesterday = addCalendarDays(current, -1);
  const monthStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  const lastMonthStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
  const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));

  if (/\byesterday\b/.test(question)) {
    return paramsFor("yesterday", yesterday, current, "yesterday", timezone);
  }
  if (/\btoday\b/.test(question)) {
    return paramsFor("today", current, tomorrow, "today", timezone);
  }
  if (/\blast\s*7\s*days?\b|\b7d\b/.test(question)) {
    return paramsFor("last_7_days", addCalendarDays(current, -6), tomorrow, "last 7 days", timezone);
  }
  if (/\blast\s*30\s*days?\b|\b30d\b/.test(question)) {
    return paramsFor("last_30_days", addCalendarDays(current, -29), tomorrow, "last 30 days", timezone);
  }
  if (/\blast\s*3\s*months?\b|\bpast\s*3\s*months?\b|\bthree\s*months?\b/.test(question)) {
    return paramsFor("last_3_months", addCalendarMonths(current, -3), tomorrow, "last 3 months", timezone);
  }
  if (/\blast\s*month\b|previous\s*month\b/.test(question)) {
    return paramsFor("last_month", lastMonthStart, monthStart, "last month", timezone);
  }
  if (/\bthis\s*month\b|current\s*month\b/.test(question)) {
    return paramsFor("this_month", monthStart, nextMonthStart, "this month", timezone);
  }
  if (/\bthis\s*year\b|current\s*year\b|year\s*to\s*date\b|\bytd\b/.test(question)) {
    return paramsFor("this_year", yearStart, tomorrow, "this year", timezone);
  }

  return paramsFor("all_time", null, null, "all time", timezone);
};

export const findAnalyticsApi = (
  question: string,
  now = new Date().toISOString(),
  timezone = "Europe/Rome",
): AnalyticsPlan => {
  const normalized = normalizeQuestion(question);
  const params = resolveDateRange(normalized, now, timezone);

  if (includesAny(normalized, [/\bnewsletters?\b|\bsubscriptions?\b|\bsubscribers?\b|\bopt[ -]?ins?\b/])) {
    return { mode: "known_api", apiKey: "newsletter_summary", confidence: 0.92, params };
  }
  if (includesAny(normalized, [/\bcontacts?\b|\benquir(?:y|ies)\b|\binquir(?:y|ies)\b/])) {
    return { mode: "known_api", apiKey: "contact_summary", confidence: 0.9, params };
  }
  if (includesAny(normalized, [/\bwait[ -]?lists?\b|\bshort[ -]?notice\b/])) {
    return { mode: "known_api", apiKey: "waitlist_summary", confidence: 0.92, params };
  }

  if (includesAny(normalized, [/\bbookings?\b|\bconsultations?\b|\bappointments?\b|\breadings?\b|\bpayments?\b|\brevenue\b|\bsales\b|\brefunds?\b/])) {
    if (includesAny(normalized, [/\bservices?\b|\bnatal\b|\byear ahead\b|\btwo charts\b|\b(?:popular|top)\b[\s\S]{0,30}\b(?:readings?|consultations?)\b/])) {
      return { mode: "known_api", apiKey: "booking_service_breakdown", confidence: 0.89, params };
    }
    if (includesAny(normalized, [/\bmodes?\b|\bin person\b|\bcalls?\b|\bremote\b/])) {
      return { mode: "known_api", apiKey: "booking_mode_breakdown", confidence: 0.89, params };
    }
    if (includesAny(normalized, [/\brevenue\b|\bsales\b|\bincome\b|\bgross\b|\bnet\b|\brefunds?\b/])) {
      return { mode: "known_api", apiKey: "booking_revenue", confidence: 0.93, params };
    }
    if (includesAny(normalized, [/\bstatus(?:es)?\b|\bstate\b|\bpending\b|\bconfirmed\b|\bcancelled\b|\bcompleted\b|\bfailed\b/])) {
      return { mode: "known_api", apiKey: "booking_status_breakdown", confidence: 0.89, params };
    }
    return { mode: "known_api", apiKey: "booking_funnel", confidence: 0.91, params };
  }

  return {
    mode: "unsupported",
    confidence: 0.25,
    reason: "Only fixed, privacy-safe Vera Solaro business analytics are configured for this template.",
    params,
  };
};

export const formatAnalyticsAnswer = (plan: AnalyticsPlan): AnalyticsQueryResponse => ({
  answer: supportedTopicsAnswer,
  title: "Vera Solaro analytics help",
  range: {
    ...(plan.params.from ? { from: plan.params.from } : {}),
    ...(plan.params.to ? { to: plan.params.to } : {}),
    label: plan.params.label,
  },
  plan,
});

const dateClause = (column: string, params: AnalyticsParams) => {
  if (!params.queryFrom || !params.queryTo) return { sql: "1 = 1", values: [] as unknown[] };
  return { sql: `${column} >= ? AND ${column} < ?`, values: [params.queryFrom, params.queryTo] };
};

const firstNumber = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) => {
  const row = await db.prepare(sql).bind(...values).first?.<{ value?: unknown }>();
  const value = typeof row?.value === "number" ? row.value : Number(row?.value ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const allRows = async (db: AnalyticsQueryDb, sql: string, values: unknown[] = []) => {
  const rows = await db.prepare(sql).bind(...values).all?.<Record<string, unknown>>();
  return rows?.results ?? [];
};

const rangeOutput = (params: AnalyticsParams) => ({
  ...(params.from ? { from: params.from } : {}),
  ...(params.to ? { to: params.to } : {}),
  label: params.label,
});

const numeric = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const executeKnownAnalyticsApi = async (
  db: AnalyticsQueryDb,
  plan: Extract<AnalyticsPlan, { mode: "known_api" }>,
): Promise<AnalyticsQueryResponse> => {
  const created = dateClause("created_at", plan.params);

  if (plan.apiKey === "booking_funnel") {
    const paymentCreated = dateClause("created_at", plan.params);
    const paymentSucceededRange = dateClause("updated_at", plan.params);
    const confirmed = dateClause("confirmed_at", plan.params);
    const [bookings, paymentStarted, paymentSucceeded, bookingsConfirmed] = await Promise.all([
      firstNumber(db, `SELECT COUNT(*) AS value FROM ap_vera_bookings WHERE ${created.sql}`, created.values),
      firstNumber(db, `SELECT COUNT(DISTINCT booking_id) AS value FROM ap_vera_payment_attempts WHERE ${paymentCreated.sql}`, paymentCreated.values),
      firstNumber(db, `SELECT COUNT(DISTINCT booking_id) AS value FROM ap_vera_payment_attempts WHERE status = 'succeeded' AND ${paymentSucceededRange.sql}`, paymentSucceededRange.values),
      firstNumber(db, `SELECT COUNT(*) AS value FROM ap_vera_bookings WHERE confirmed_at IS NOT NULL AND ${confirmed.sql}`, confirmed.values),
    ]);
    return {
      title: "Booking funnel",
      answer: `Vera Solaro received ${bookings} booking records in ${plan.params.label}; ${paymentStarted} reached payment, ${paymentSucceeded} paid successfully, and ${bookingsConfirmed} were confirmed.`,
      range: rangeOutput(plan.params),
      metrics: [
        { label: "Bookings started", value: bookings, unit: "count" },
        { label: "Reached payment", value: paymentStarted, unit: "count" },
        { label: "Successful payments", value: paymentSucceeded, unit: "count" },
        { label: "Confirmed bookings", value: bookingsConfirmed, unit: "count" },
      ],
      plan,
    };
  }

  if (plan.apiKey === "booking_status_breakdown") {
    const rows = await allRows(
      db,
      `SELECT status, payment_state, COUNT(*) AS bookings
       FROM ap_vera_bookings
       WHERE ${created.sql}
       GROUP BY status, payment_state
       ORDER BY bookings DESC, status ASC, payment_state ASC`,
      created.values,
    );
    return {
      title: "Booking status breakdown",
      answer: rows.length ? `Booking and payment states are available for ${plan.params.label}.` : `No bookings were recorded in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      rows,
      plan,
    };
  }

  if (plan.apiKey === "booking_revenue") {
    const paid = dateClause("updated_at", plan.params);
    const refunded = dateClause("updated_at", plan.params);
    const [paymentRows, refundRows] = await Promise.all([
      allRows(
        db,
        `SELECT currency, COUNT(*) AS successful_payments,
                COALESCE(SUM(amount_cents), 0) / 100.0 AS gross_revenue
         FROM ap_vera_payment_attempts
         WHERE status = 'succeeded' AND ${paid.sql}
         GROUP BY currency
         ORDER BY currency ASC`,
        paid.values,
      ),
      allRows(
        db,
        `SELECT currency, COUNT(*) AS successful_refunds,
                COALESCE(SUM(amount_cents), 0) / 100.0 AS refunded_revenue
         FROM ap_vera_refunds
         WHERE status = 'succeeded' AND ${refunded.sql}
         GROUP BY currency
         ORDER BY currency ASC`,
        refunded.values,
      ),
    ]);
    const currencies = new Map<string, Record<string, unknown>>();
    for (const row of paymentRows) {
      const currency = String(row.currency);
      currencies.set(currency, {
        currency,
        successful_payments: numeric(row.successful_payments),
        gross_revenue: numeric(row.gross_revenue),
        successful_refunds: 0,
        refunded_revenue: 0,
      });
    }
    for (const row of refundRows) {
      const currency = String(row.currency);
      const current = currencies.get(currency) ?? {
        currency,
        successful_payments: 0,
        gross_revenue: 0,
        successful_refunds: 0,
        refunded_revenue: 0,
      };
      current.successful_refunds = numeric(row.successful_refunds);
      current.refunded_revenue = numeric(row.refunded_revenue);
      currencies.set(currency, current);
    }
    const rows = [...currencies.values()]
      .map((row) => ({
        currency: String(row.currency),
        successful_payments: numeric(row.successful_payments),
        gross_revenue: numeric(row.gross_revenue),
        successful_refunds: numeric(row.successful_refunds),
        refunded_revenue: numeric(row.refunded_revenue),
        net_revenue: numeric(row.gross_revenue) - numeric(row.refunded_revenue),
      }))
      .sort((left, right) => String(left.currency).localeCompare(String(right.currency)));
    return {
      title: "Booking revenue",
      answer: rows.length ? `Successful consultation payments and refunds are shown by currency for ${plan.params.label}.` : `No successful consultation payments were recorded in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      rows,
      plan,
    };
  }

  if (plan.apiKey === "booking_service_breakdown") {
    const bookingCreated = dateClause("booking.created_at", plan.params);
    const rows = await allRows(
      db,
      `SELECT booking.service_slug AS service, service.name AS service_name,
              booking.currency, COUNT(*) AS bookings,
              SUM(CASE WHEN booking.status IN ('confirmed', 'completed') THEN 1 ELSE 0 END) AS confirmed_bookings,
              COALESCE(SUM(booking.paid_cents), 0) / 100.0 AS collected_revenue
       FROM ap_vera_bookings booking
       JOIN ap_vera_services service ON service.slug = booking.service_slug
       WHERE ${bookingCreated.sql}
       GROUP BY booking.service_slug, service.name, booking.currency
       ORDER BY bookings DESC, service.sort_order ASC`,
      bookingCreated.values,
    );
    return {
      title: "Consultation services",
      answer: rows[0] ? `${rows[0].service_name} had the most bookings in ${plan.params.label}.` : `No consultation bookings were recorded in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      rows,
      plan,
    };
  }

  if (plan.apiKey === "booking_mode_breakdown") {
    const bookingCreated = dateClause("booking.created_at", plan.params);
    const rows = await allRows(
      db,
      `SELECT booking.mode, booking.currency, COUNT(*) AS bookings,
              SUM(CASE WHEN booking.status IN ('confirmed', 'completed') THEN 1 ELSE 0 END) AS confirmed_bookings,
              COALESCE(SUM(booking.paid_cents), 0) / 100.0 AS collected_revenue
       FROM ap_vera_bookings booking
       WHERE ${bookingCreated.sql}
       GROUP BY booking.mode, booking.currency
       ORDER BY bookings DESC, booking.mode ASC`,
      bookingCreated.values,
    );
    return {
      title: "Consultation modes",
      answer: rows.length ? `Call and in-person booking totals are available for ${plan.params.label}.` : `No consultation bookings were recorded in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      rows,
      plan,
    };
  }

  if (plan.apiKey === "newsletter_summary") {
    const rows = await allRows(
      db,
      `SELECT status, COUNT(*) AS subscriptions
       FROM ap_vera_newsletter_subscriptions
       WHERE ${created.sql}
       GROUP BY status
       ORDER BY subscriptions DESC, status ASC`,
      created.values,
    );
    const total = rows.reduce((sum, row) => sum + numeric(row.subscriptions), 0);
    const subscribed = rows.find((row) => row.status === "subscribed");
    return {
      title: "Newsletter subscriptions",
      answer: `${total} newsletter subscription records were created in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      metrics: [
        { label: "Subscription records", value: total, unit: "count" },
        { label: "Confirmed subscribers", value: numeric(subscribed?.subscriptions), unit: "count" },
      ],
      rows,
      plan,
    };
  }

  if (plan.apiKey === "contact_summary") {
    const rows = await allRows(
      db,
      `SELECT status, topic, COUNT(*) AS requests
       FROM ap_vera_contact_requests
       WHERE ${created.sql}
       GROUP BY status, topic
       ORDER BY requests DESC, status ASC, topic ASC`,
      created.values,
    );
    const total = rows.reduce((sum, row) => sum + numeric(row.requests), 0);
    return {
      title: "Contact requests",
      answer: `${total} contact requests were recorded in ${plan.params.label}.`,
      range: rangeOutput(plan.params),
      metrics: [{ label: "Contact requests", value: total, unit: "count" }],
      rows,
      plan,
    };
  }

  const waitlistCreated = dateClause("waitlist.created_at", plan.params);
  const rows = await allRows(
    db,
    `SELECT waitlist.status, waitlist.service_slug AS service,
            service.name AS service_name, waitlist.mode, COUNT(*) AS entries
     FROM ap_vera_waitlist_entries waitlist
     LEFT JOIN ap_vera_services service ON service.slug = waitlist.service_slug
     WHERE ${waitlistCreated.sql}
     GROUP BY waitlist.status, waitlist.service_slug, service.name, waitlist.mode
     ORDER BY entries DESC, waitlist.status ASC, service.sort_order ASC, waitlist.mode ASC`,
    waitlistCreated.values,
  );
  const total = rows.reduce((sum, row) => sum + numeric(row.entries), 0);
  const active = rows
    .filter((row) => row.status === "active")
    .reduce((sum, row) => sum + numeric(row.entries), 0);
  return {
    title: "Waitlist",
    answer: `${total} waitlist entries were recorded in ${plan.params.label}; ${active} remain active.`,
    range: rangeOutput(plan.params),
    metrics: [
      { label: "Waitlist entries", value: total, unit: "count" },
      { label: "Active entries", value: active, unit: "count" },
    ],
    rows,
    plan,
  };
};

export const answerAnalyticsQuery = async (input: {
  db?: AnalyticsQueryDb;
  question: string;
  projectId?: string;
  timezone?: string;
  now?: string;
}): Promise<AnalyticsQueryResponse> => {
  const plan = findAnalyticsApi(
    input.question,
    input.now ?? new Date().toISOString(),
    input.timezone ?? "Europe/Rome",
  );
  void input.projectId;
  if (plan.mode === "known_api") {
    if (!input.db) {
      return {
        answer: "The Vera Solaro analytics database binding is not available.",
        title: "Vera Solaro analytics unavailable",
        plan,
      };
    }
    return executeKnownAnalyticsApi(input.db, plan);
  }
  return formatAnalyticsAnswer(plan);
};

export const unsupportedAnalyticsAnswer = supportedTopicsAnswer;
