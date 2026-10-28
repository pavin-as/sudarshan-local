// Thin wrapper over the Sudarshan API. Errors carry the server's plain-language message.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status})`, data?.details);
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new CustomEvent("sudarshan:logged-out"));
    if (data?.error === "must_change_password") window.dispatchEvent(new CustomEvent("sudarshan:must-change-password"));
    throw err;
  }
  return data as T;
}

// ---- shared types (match the API) ----
export type Role = "admin" | "doctor" | "manager" | "staff" | "optometrist" | "counsellor";
export type Permission = "users.manage" | "settings.manage" | "appointments.read" | "appointments.write" |
  "patients.read" | "clinical.read" | "followups.write" | "audit.read" |
  "messages.send" | "messages.broadcast" | "payments.write" | "payments.refund" | "retina_ai.use" | "fundus.report" |
  "reconciliation.read" | "cash.deposit" | "adjustments.submit" | "adjustments.approve";

export interface User { id: number; username: string; fullName: string; role: Role; mustChangePassword: boolean; permissions: Permission[] }

export type Status = "waitlist" | "booked" | "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show";
export type LiveStage = "registered_not_arrived" | "arrived" | "optometry" | "waiting_for_doctor" | "with_doctor" | "done" | "cancelled_in_yarago" | null;

export interface Appointment {
  id: number; date: string; slotTime: string | null; durationMin: number; doctorId: number | null; doctorName: string | null;
  patientId: number | null; mrd: string | null; patientName: string; phone: string | null; ageYears: number | null; ageText?: string | null; gender: string | null;
  patientType: string | null; appointmentType: string | null; planOfAction: string | null; urgency: string | null;
  familyGroup: string | null; fixedSlot: boolean; consultStart: string | null; tags: string[]; remarks: string | null;
  status: Status; source: string; sourceRef: string | null; confirmed4dayAt: string | null; confirmed1dayAt: string | null;
  cancelledAt: string | null; cancelReason: string | null; bookedBy: string | null; bookedAt: string; legacyId: string | null;
  yaragoVisitId: number | null; yaragoStatus: string | null; checkInAt: string | null; checkOutAt: string | null; liveStage: LiveStage;
}

// scheduling rules (warnings, never blocks)
export type RuleLevel = "error" | "warning" | "info";
export interface RuleFinding { rule: number; code: string; level: RuleLevel; id: number | null; ids: number[]; message: string; suggestion: string }
export interface RuleDay { findings: RuleFinding[]; specialCases: { id: number; types: string[] }[] }

export interface EarlyStatus {
  days: number; limit: number; band: number; booked: number; max: number; percentageUsed: number; restricted: boolean; allowedNow: number;
  unlocks: { days: number; from: string | null; percentage: number; slotsAllowed: number; newSlots: number }[];
}
export interface DayInfo { date: string; weekday: number; holiday: string | null; maxSlots: number; booked: number; remaining: number; waitlist: number; open: boolean; closedReason: string | null; early: EarlyStatus | null; waitlistLimit: number }
export interface DoctorDay { doctorId: number; name: string; sessions: { start: string; end: string }[]; onLeave: boolean; note: string | null }
export interface Meta {
  doctors: { id: number; name: string; isActive: boolean }[];
  plansOfAction: { name: string; eye: string | null; prepMin: number | null; consultMin: number | null; priority: number | null }[];
  lists: Record<string, any>;
  codeLabels: { kind: string; code: number; label: string }[];
  today: string;
}

// WhatsApp and payment links (D-034)
export type OutreachMode = "off" | "test" | "live";
export type MessageStatus = "queued" | "sent" | "failed" | "skipped";
export interface Message {
  id: number; template: string; templateLabel: string; to: string; status: MessageStatus; error: string | null; mode: "test" | "live" | null;
  createdAt: string; sentAt: string | null; appointmentId: number | null; broadcastId: number | null; paymentId: number | null;
  patientName: string | null; mrd: string | null; createdBy: string | null; forDate: string | null; slotTime: string | null;
}
export type PaymentStatus = "created" | "sent" | "paid" | "expired" | "cancelled" | "refunded" | "partially_refunded" | "failed";
export interface Refund { id: number; amount: number; reason: string; status: "requested" | "pending" | "processed" | "failed"; error: string | null; requestedAt: string; processedAt: string | null; by: string | null }
export interface Payment {
  id: number; appointmentId: number | null; patientId: number | null; amount: number; purpose: string | null; status: PaymentStatus;
  mode: "test" | "live" | null; phone: string | null; reference: string | null; linkUrl: string | null; expiresAt: string | null;
  paidAmount: number | null; paidAt: string | null; razorpayPaymentId: string | null; refundedAmount: number; needsReview: string | null;
  error: string | null; sentAt: string | null; sentVia: string | null; cancelledAt: string | null; cancelReason: string | null;
  createdAt: string; createdBy: string | null; patientName: string | null; mrd: string | null; date: string | null; slotTime: string | null;
  refunds: Refund[];
}
export interface PaymentStatusInfo { mode: OutreachMode; modeWords: string; defaultAmount: number; minAmount: number; maxAmount: number; linkMinutes: number;
  keyMode: "test" | "live" | "unknown" | null; problem: string | null; lastCheck: { at: string; checked: number; changed: number; error: string | null } | null }
export interface WhatsAppStatus { mode: OutreachMode; modeWords: string; keySet: boolean; testNumbers: number; queued: number;
  templates: { key: string; label: string; kind: "appointment" | "payment"; ready: boolean }[] }

// Money reconciliation (D-052): figures always come from the server's reconcile()
export type ReconMethod = "cash" | "upi" | "card" | "cheque" | "other";
export type ReconStatus = "matched" | "within_tolerance" | "settled_less_fee" | "fee_high" | "awaiting" | "no_bank_data" | "uncertain" | "difference"
  | "cash_in_hand" | "cash_deposited" | "not_tracked" | "nothing_due";
export interface CreditRef { transactionId: string; date: string; amount: number; description: string | null; how: "rule" | "approved"; adjustmentId?: number }
export interface FeeBand { low: number; high: number; ceiling: number; payments: number }
export interface ReconRow {
  date: string; method: ReconMethod; collected: number; refunds: number; adjCollected: number; adjRefunds: number; fees: number; net: number;
  expected: number; deposited: number; bankFee: number; band: FeeBand | null; difference: number; status: ReconStatus; statusWords: string;
  matches: CreditRef[]; candidates: CreditRef[]; windowEnd: string | null; note: string | null;
}
export interface ReconEffect { adjustmentId: number; onDate: string; measure: string; category: string | null; method: ReconMethod | null; amount: number; zohoTxnId: string | null; words: string; selfApproved?: boolean; kind?: string }
export interface ReconResult {
  from: string; to: string;
  zoho: { configured: boolean; fetchedAt: string | null; feedRefreshedOn: string | null; stale: boolean; bankKnownUntil: string | null };
  totals: { billed: number; billedAdjusted: number; collected: number; refunds: number; refundsUnrecorded: number;
    adjustments: { revenue: number; collected: number; refunds: number; fees: number; deposits: number; count: number };
    netCollected: number; expectedInBank: number; depositsMatched: number; notYetDue: number; cashInHand: number; cashDeposited: number;
    bankFees: number; feeHighDays: number;
    differenceToExplain: number; uncertain: number; unclassifiedCredits: number; unmatchedCredits: number };
  byCategory: { category: string; billed: number; adjustments: number; total: number }[];
  bySourceMethod: { source: string; method: ReconMethod; collected: number }[];
  billedVsCollected: { source: string; billed: number; collected: number; gap: number }[];
  byMethod: { method: ReconMethod; collected: number; refunds: number; adjustments: number; fees: number; net: number; deposited: number; bankFees: number; notYetDue: number; difference: number; uncertain: number }[];
  rows: ReconRow[];
  credits: (CreditRef & { method: ReconMethod | null; class: string; ruleId: number | null; matchedTo: string[]; state: string })[];
  unclassified: { transactionId: string; date: string; amount: number; description: string | null; note: string }[];
  refundsUnrecordedList: { refundId: string; source: string; billNo: string | null; onDate: string; amount: number }[];
  effects: ReconEffect[];
  trackedMethods: ReconMethod[];
}
export interface ZohoStatus { configured: boolean; fetchedAt: string | null; feedRefreshedOn: string | null; stale: boolean; staleHours: number; running: boolean;
  lastRun: { status: string; startedAt: string; message: string | null } | null }
export interface ReconResponse { result: ReconResult; fees: FeeReport; cash: CashSummary; yaragoSyncedAt: string | null; zohoStatus: ZohoStatus; pendingAdjustments: number;
  words: { methods: Record<string, string>; categories: Record<string, string>; statuses: Record<string, string>; kinds: Record<string, string> } }

// Bank fees and the cash book (D-053)
export interface FeeDay { date: string; method: "card" | "upi"; sales: number; settled: number | null; fee: number | null; pct: number | null; low: number; high: number;
  state: "normal" | "high" | "none" | "not_settled" | "waiting"; words: string }
export interface FeeMonth { month: string; method: "card" | "upi"; sales: number; salesSettled: number; feesKept: number; pct: number | null; low: number; high: number; highDays: number }
export interface FeeReport {
  days: FeeDay[]; months: FeeMonth[]; charges: { transactionId: string; date: string; amount: number; description: string | null }[];
  totals: { cardSales: number; upiSales: number; cardFees: number; upiFees: number; charges: number; cardPct: number | null; upiPct: number | null };
  late: { date: string; sales: number; words: string }[]; upiFeesSeen: boolean;
  fixed: { gstPct: number; servicePerMonth: number; perBatch: number; lateSettleDays: number };
}
export type CashLevel = "ok" | "soon" | "over";
export interface CashInHand { amount: number; since: string; firstCashDay: string | null; level: CashLevel; levelWords: string;
  lastDeposit: { id: number; depositedOn: string; coversTo: string } | null; daysSinceLastDeposit: number | null }
export interface CashLimits { warnAt: number; limit: number; carryBand: number }
export interface CashSummary { inHand: CashInHand; limits: CashLimits; coveredUntil: string | null; problems: number; unrecorded: number }
export interface BankRef { transactionId: string; date: string; amount: number; description: string | null }
export interface DepositCheck {
  id: number; depositedOn: string; coversFrom: string; coversTo: string; amount: number; slipNo: string | null; note: string | null;
  recordedByName: string; recordedAt: string; yaragoCash: number; carryIn: number; carryOut: number;
  check: "ok" | "short" | "excess"; checkWords: string; bank: "found" | "waiting" | "not_found" | "uncertain" | "no_bank_data"; bankWords: string;
  credit: BankRef | null; possible: BankRef[];
}
export interface DeskDeposit { id: number; depositedOn: string; coversFrom: string; coversTo: string; amount: number; slipNo: string | null; note: string | null;
  recordedByName: string; recordedAt: string; bank: DepositCheck["bank"]; bankWords: string }
export interface CashDesk {
  coveredUntil: string | null; nextCoversFrom: string; start: string;
  inHand: Omit<CashInHand, "amount" | "since">;
  deposits: DeskDeposit[];
  voided: { id: number; depositedOn: string; coversTo: string; amount: number; voidReason: string | null; voidedByName: string | null }[];
}
export interface CashBookFull {
  start: string; opening: number; coveredUntil: string | null; deposits: DepositCheck[];
  voided: (DeskDeposit & { voidReason: string | null; voidedByName: string | null; voidedAt: string | null })[];
  beforeStart: DeskDeposit[]; inHand: CashInHand; unrecorded: BankRef[]; days: { date: string; net: number; depositId: number | null }[]; limits: CashLimits;
}
export interface CashResponse { full: boolean; desk: CashDesk; book?: CashBookFull;
  settings?: { start: string; opening: number; bankFrom: string; limits: CashLimits }; zohoStatus?: ZohoStatus }
export type AdjKind = "refund_method" | "method_correction" | "amount_correction" | "date_correction" | "missing_entry" | "payment_fee" | "bank_credit" | "reversal";
export type AdjStatus = "pending" | "approved" | "rejected" | "withdrawn" | "reversed";
export interface Adjustment {
  id: number; kind: AdjKind; status: AdjStatus; onDate: string; otherDate: string | null; amount: number; recordedAmount: number | null; category: string | null;
  sourceMethod: ReconMethod | null; recordedMethod: ReconMethod | null; actualMethod: ReconMethod | null; bankClass: "clinic" | "not_clinic" | null;
  yaragoSource: string | null; yaragoId: string | null; billNo: string | null; patientId: number | null; mrd: string | null; patientName: string | null;
  zohoTxnId: string | null; reason: string; refs: string | null; submittedBy: number; submittedByName: string; submittedAt: string;
  reviewedBy: number | null; reviewedByName: string | null; reviewedAt: string | null; reviewNote: string | null; rejectionReason: string | null;
  selfApproved: boolean; withdrawnAt: string | null; reversesId: number | null; replacesId: number | null; pairedWith: number | null; reversedBy: number | null;
  replacementId: number | null;
  effects: { onDate: string; measure: string; category: string | null; method: string | null; amount: number; zohoTxnId: string | null; words: string }[];
}
