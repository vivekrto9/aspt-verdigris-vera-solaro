import type { RuntimeEnv } from "../aggregator/runtime.ts";

export type VeraRow = Record<string, unknown>;

export type VeraD1Result = {
  success?: boolean;
  meta?: { changes?: number };
};

export type VeraD1Statement = {
  bind: (...values: unknown[]) => VeraD1Statement;
  first?: <T = VeraRow>() => Promise<T | null>;
  all?: <T = VeraRow>() => Promise<{ results?: T[] }>;
  run?: () => Promise<VeraD1Result | unknown>;
};

export type VeraD1Database = {
  prepare: (sql: string) => VeraD1Statement;
  batch?: (statements: VeraD1Statement[]) => Promise<unknown[]>;
};

export type VeraR2Object = {
  body?: BodyInit | null;
  size?: number;
};

export type VeraR2Bucket = {
  get?: (
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) => Promise<VeraR2Object | null>;
  put?: (key: string, body: ArrayBuffer | ReadableStream | Blob, options?: unknown) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
};

export type VeraQueue = {
  send?: (message: unknown) => Promise<unknown>;
};

export type VeraEnv = Omit<RuntimeEnv, "DB"> & {
  DB?: VeraD1Database;
  MEDIA?: VeraR2Bucket;
  EMAIL_QUEUE?: VeraQueue;
  fetch?: typeof fetch;
};

export const VERA_TABLES = {
  services: "ap_vera_services",
  calendlyMappings: "ap_vera_calendly_mappings",
  bookings: "ap_vera_bookings",
  bookingHolds: "ap_vera_booking_slot_holds",
  bookingEvents: "ap_vera_booking_events",
  rescheduleRequests: "ap_vera_reschedule_requests",
  paymentAttempts: "ap_vera_payment_attempts",
  paymentEvents: "ap_vera_payment_events",
  refunds: "ap_vera_refunds",
  invoices: "ap_vera_invoices",
  giftCertificates: "ap_vera_gift_certificates",
  giftRedemptions: "ap_vera_gift_redemptions",
  waitlist: "ap_vera_waitlist_entries",
  contacts: "ap_vera_contact_requests",
  newsletterSubscriptions: "ap_vera_newsletter_subscriptions",
  newsletterCampaigns: "ap_vera_newsletter_campaigns",
  newsletterDeliveries: "ap_vera_newsletter_deliveries",
  emailOutbox: "ap_vera_email_outbox",
  emailSuppressions: "ap_vera_email_suppressions",
  privateFiles: "ap_vera_private_files",
  reports: "ap_vera_reports",
  messageThreads: "ap_vera_message_threads",
  messages: "ap_vera_messages",
  followUps: "ap_vera_follow_ups",
} as const;
