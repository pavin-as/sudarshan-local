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
  | "audit.read";           // the activity log

const ALL: Permission[] = ["users.manage", "settings.manage", "appointments.read", "appointments.write",
  "patients.read", "clinical.read", "followups.write", "audit.read"];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  manager: ALL.filter((p) => p !== "users.manage"),
  staff: ["appointments.read", "appointments.write", "patients.read", "followups.write"],
  counsellor: ["appointments.read", "appointments.write", "patients.read", "clinical.read", "followups.write"],
  doctor: ["appointments.read", "patients.read", "clinical.read"],
  optometrist: ["appointments.read", "patients.read", "clinical.read"],
};

export function can(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(p) ?? false;
}

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
