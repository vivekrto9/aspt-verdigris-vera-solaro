export type VeraBookingConfirmationState =
  | "awaiting_payment"
  | "processing"
  | "failed"
  | "paid_scheduling"
  | "action_required"
  | "confirmed";

const paidStates = new Set(["deposit_paid", "paid", "partially_refunded"]);
const failedBookingStates = new Set(["cancelled", "expired", "refunded"]);
const failedAttemptStates = new Set(["failed", "cancelled", "canceled"]);
const processingAttemptStates = new Set(["processing", "succeeded"]);

export const deriveVeraBookingConfirmationState = ({
  bookingStatus,
  paymentState,
  paymentAttemptStatus = "",
}: {
  bookingStatus: string;
  paymentState: string;
  paymentAttemptStatus?: string;
}): VeraBookingConfirmationState => {
  const paid = paidStates.has(paymentState);
  if (paid && bookingStatus === "confirmed") return "confirmed";
  if (paid && bookingStatus === "payment_action_required") return "action_required";
  if (paid) return "paid_scheduling";
  if (failedBookingStates.has(bookingStatus) || failedAttemptStates.has(paymentAttemptStatus)) return "failed";
  if (processingAttemptStates.has(paymentAttemptStatus)) return "processing";
  return "awaiting_payment";
};
