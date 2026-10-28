// Who may do what. One table of role defaults, so it is easy to read and change; the admin can then give or take away
// single permissions for one login (app.user_permissions, D-053). An admin's access is fixed: everything but writing
// fundus reports (D-042: doctors only).
export type Role = "admin" | "doctor" | "manager" | "staff" | "optometrist" | "counsellor";

export type Permission =
  | "users.manage"          // create users, reset passwords, change roles and access
  | "settings.manage"       // clinic calendar, capacity, plan-of-action list, rules
  | "appointments.read"
  | "appointments.write"    // book, reschedule, cancel, confirm
  | "patients.read"         // find patients, demographics, visit list, dues, follow-ups
  | "clinical.read"         // exam findings, vision/IOP trends, diagnosis, AI summaries
  | "followups.write"       // log follow-up calls
  | "audit.read"            // the activity log
  | "messages.send"         // send one WhatsApp message to a booked patient (reminder, payment link)
  | "messages.broadcast"    // send the day's reminders to every booked patient (Google app: levels 1 and 3)
  | "payments.write"        // make, send, check and cancel Razorpay payment links
  | "payments.refund"       // refund a payment (Google app decision: director / admin only)
  | "retina_ai.use"         // grade fundus photographs with the research DR model, see and grade results (D-040)
  | "fundus.report"         // write and correct the doctor's fundus report (D-042); reading it needs clinical.read
  | "reconciliation.read"   // finance, full view: reconciliation, cash book with deposit checks, bank fees, assistant (D-052)
  | "cash.deposit"          // cash desk: record a cash deposit without seeing Yarago's figures (blind, D-053)
  | "adjustments.submit"    // ask for a correction or adjustment to the reconciliation; withdraw or ask to reverse one
  | "adjustments.approve"   // approve or reject adjustment requests; bank rules, fee rates, cash book settings (admin)
  | "books.audit";          // how well Zoho Books is kept; print the bookkeeper's weekly sheet (D-054)

/** Every permission, the page it belongs to and what it lets a person do: the Users page shows this list. */
export const PERMISSION_INFO: { key: Permission; page: string; label: string }[] = [
  { key: "appointments.read", page: "Day board, Month, Today", label: "See appointments" },
  { key: "appointments.write", page: "Day board, Confirmation calls, Cancel list, Direct calls, Triage", label: "Book, move, cancel and confirm appointments" },
  { key: "patients.read", page: "Patients", label: "Find patients; see details, visits, dues and follow-ups" },
  { key: "followups.write", page: "Follow-up calls", label: "Log follow-up calls" },
  { key: "clinical.read", page: "Patients, EMR completeness, EMR daily report, Fundus reports", label: "See exam findings, diagnoses and AI summaries" },
  { key: "fundus.report", page: "Fundus reports", label: "Write and correct fundus reports" },
  { key: "retina_ai.use", page: "Retina AI", label: "Grade fundus photographs with the research model" },
  { key: "messages.send", page: "WhatsApp", label: "Send one WhatsApp message to a patient" },
  { key: "messages.broadcast", page: "WhatsApp", label: "Send the day's reminders to every booked patient" },
  { key: "payments.write", page: "Payments", label: "Make, send, check and cancel payment links" },
  { key: "payments.refund", page: "Payments", label: "Refund a payment" },
  { key: "cash.deposit", page: "Cash deposits", label: "Record cash deposits (blind: Yarago's figures are not shown)" },
  { key: "reconciliation.read", page: "Reconciliation, Cash deposits", label: "Finance, full view: revenue, bank, cash checks, bank fees" },
  { key: "adjustments.submit", page: "Adjustments", label: "Ask for an adjustment; withdraw or ask to reverse one" },
  { key: "adjustments.approve", page: "Adjustments, Reconciliation", label: "Approve or reject adjustments; bank rules, fee rates, cash settings" },
  { key: "books.audit", page: "Books audit", label: "See how well Zoho Books is kept; print the bookkeeper's weekly sheet" },
  { key: "audit.read", page: "Activity log", label: "See the activity log" },
  { key: "settings.manage", page: "Settings, Clinic calendar", label: "Change clinic settings, calendar and booking rules" },
  { key: "users.manage", page: "Users", label: "Add users, reset passwords, change roles and access" },
];
export const PERMISSIONS = PERMISSION_INFO.map((p) => p.key);

const ALL: Permission[] = ["users.manage", "settings.manage", "appointments.read", "appointments.write",
  "patients.read", "clinical.read", "followups.write", "audit.read",
  "messages.send", "messages.broadcast", "payments.write", "payments.refund"];

// retina_ai.use is given by name, not through ALL, so managers do not get it (D-040: admin and doctors only);
// fundus.report only to doctors (D-042: only doctors write reports). Finance is not part of any role but admin's
// (D-053: only some doctors and managers see it): the admin gives it to a login on the Users page.
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: PERMISSIONS.filter((p) => p !== "fundus.report"),
  manager: ALL.filter((p) => p !== "users.manage" && p !== "payments.refund"),
  staff: ["appointments.read", "appointments.write", "patients.read", "followups.write", "messages.send", "payments.write"],
  counsellor: ["appointments.read", "appointments.write", "patients.read", "clinical.read", "followups.write", "messages.send", "payments.write"],
  doctor: ["appointments.read", "patients.read", "clinical.read", "retina_ai.use", "fundus.report"],
  optometrist: ["appointments.read", "patients.read", "clinical.read"],
};

/** A login's own changes to its role's defaults: true = given, false = taken away. */
export type Overrides = Partial<Record<Permission, boolean>>;

/** What a login may do: its role's defaults with its own changes. An admin's access is fixed (its role's full set). */
export function effectivePermissions(role: Role, overrides: Overrides = {}): Permission[] {
  if (role === "admin") return [...ROLE_PERMISSIONS.admin];
  const base = new Set(ROLE_PERMISSIONS[role] ?? []);
  for (const [p, on] of Object.entries(overrides) as [Permission, boolean][]) {
    if (!PERMISSIONS.includes(p)) continue;
    if (on) base.add(p); else base.delete(p);
  }
  return PERMISSIONS.filter((p) => base.has(p));
}

export function can(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(p) ?? false;
}

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
