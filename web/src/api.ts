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
  "messages.send" | "messages.broadcast" | "payments.write" | "payments.refund";

export interface User { id: number; username: string; fullName: string; role: Role; mustChangePassword: boolean; permissions: Permission[] }

export type Status = "waitlist" | "booked" | "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show";
export type LiveStage = "registered_not_arrived" | "arrived" | "optometry" | "waiting_for_doctor" | "with_doctor" | "done" | "cancelled_in_yarago" | null;

export interface Appointment {
  id: number; date: string; slotTime: string | null; durationMin: number; doctorId: number | null; doctorName: string | null;
  patientId: number | null; mrd: string | null; patientName: string; phone: string | null; ageYears: number | null; gender: string | null;
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
export interface PaymentStatusInfo { mode: OutreachMode; modeWords: string; defaultAmount: number; minAmount: number; maxAmount: number; linkHours: number;
  keyMode: "test" | "live" | "unknown" | null; problem: string | null; lastCheck: { at: string; checked: number; changed: number; error: string | null } | null }
export interface WhatsAppStatus { mode: OutreachMode; modeWords: string; keySet: boolean; testNumbers: number; queued: number;
  templates: { key: string; label: string; kind: "appointment" | "payment"; ready: boolean }[] }
