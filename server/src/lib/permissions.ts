// Who may do what. One table, so it is easy to read and change.
export type Role = "admin" | "doctor" | "manager" | "staff" | "optometrist" | "counsellor";

export type Permission =
  | "users.manage"          // create users, reset passwords, change roles
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
  | "fundus.report";        // write and correct the doctor's fundus report (D-042); reading it needs clinical.read

const ALL: Permission[] = ["users.manage", "settings.manage", "appointments.read", "appointments.write",
  "patients.read", "clinical.read", "followups.write", "audit.read",
  "messages.send", "messages.broadcast", "payments.write", "payments.refund"];

// retina_ai.use is given by name, not through ALL, so managers do not get it (D-040: admin and doctors only);
// fundus.report only to doctors (D-042: only doctors write reports)
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [...ALL, "retina_ai.use"],
  manager: ALL.filter((p) => p !== "users.manage" && p !== "payments.refund"),
  staff: ["appointments.read", "appointments.write", "patients.read", "followups.write", "messages.send", "payments.write"],
  counsellor: ["appointments.read", "appointments.write", "patients.read", "clinical.read", "followups.write", "messages.send", "payments.write"],
  doctor: ["appointments.read", "patients.read", "clinical.read", "retina_ai.use", "fundus.report"],
  optometrist: ["appointments.read", "patients.read", "clinical.read"],
};

export function can(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(p) ?? false;
}

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
