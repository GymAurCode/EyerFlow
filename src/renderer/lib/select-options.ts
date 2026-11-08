/**
 * Option lists that more than one screen offers.
 *
 * These are the lists that used to be written out as `<option>` children at
 * each call site, which meant the same twelve months were typed out twice and
 * the same three currencies three times. They are plain data now, so a select
 * renders the same choices wherever it appears.
 *
 * The shape matches the `Select` component's option, so passing one of these
 * straight through is the whole usage.
 */

import type { SelectOption } from "../components/ui/Input";

/** January = 1, matching what the settings column stores. */
export const MONTH_OPTIONS: readonly SelectOption[] = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

/** How money was actually received or paid. Drives the cash/bank posting. */
export const PAYMENT_METHOD_OPTIONS: readonly SelectOption[] = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "card", label: "Card" },
  { value: "cheque", label: "Cheque" },
];

/** Document status, with the wording the user sees on a list. */
export const DOCUMENT_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "partPaid", label: "Part paid" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

/** The fixed roles the app ships with. */
export const ROLE_OPTIONS: readonly SelectOption[] = [
  { value: "Administrator", label: "Administrator — everything" },
  { value: "Staff", label: "Staff — no profit reports, split, or settings" },
];