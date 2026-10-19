// Booking, rescheduling, cancelling. All checks run inside the transaction under a per-day lock,
// so two staff booking the last slot at the same moment cannot both succeed.
import type { PoolClient } from "pg";
import { one, q, setAuditSummary } from "../db.js";
import { HttpError } from "../lib/errors.js";
import { addDays, niceDate, todayIST, toMin } from "../lib/time.js";
import { bookingSettings, doctorsOnDate, maxSlotsFor, slotGrid } from "./calendar.js";
import { blocksAt, HFA_OPEN_DAYS_BEFORE, loadBlocks } from "./reserved.js";
import { isKind } from "./rules.js";
import { earlyStatus, loadThresholds } from "./earlyBooking.js";

const ACTIVE_SQL = `('booked','confirmed','checked_in','completed','no_show')`;
const HOLDING_SQL = `('booked','confirmed','checked_in','completed','no_show','waitlist')`;   // includes waitlist

export interface Placement {
  date: string;
  slotTime: string | null;        // null = waitlist
  doctorId: number | null;
  // what is being booked: decides whether a held HFA slot may be used
  planOfAction?: string | null;
  appointmentType?: string | null;
  urgency?: string | null;
}

export interface PatientKey { patientId: number | null; mrd: string | null; phone: string | null; name: string }

export interface Override { reason: string }

export class BookingRefused extends HttpError {
  constructor(message: string, public problems: string[], public freeSlots: string[] = []) {
    super(409, "booking_refused", message, { problems, freeSlots });
  }
}

async function lockDay(c: PoolClient, date: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('appointment-day:' || $1))", [date]);
}

/**
 * Checks a placement. Returns warnings (shown, booking goes ahead).
 * Throws BookingRefused with every blocking problem listed. An override (managers/admins) turns
 * "day full" and "slot taken" into warnings; holidays, leave and duplicates still refuse.
 */
export async function checkPlacement(c: PoolClient, p: Placement, who: PatientKey, excludeId: number | null,
                                     override: Override | null): Promise<string[]> {
  await lockDay(c, p.date);
  const problems: string[] = [], soft: string[] = [], warnings: string[] = [];
  const today = todayIST();

  if (p.date < today) problems.push("That date is in the past");
  const holiday = await one<{ reason: string }>("SELECT reason FROM app.holidays WHERE on_date = $1", [p.date], c);
  if (holiday) problems.push(`${niceDate(p.date)} is a holiday (${holiday.reason})`);

  // same patient already has a place that day
  const dup = await one<any>(
    `SELECT id, to_char(slot_time,'HH24:MI') AS t, status FROM app.appointments
      WHERE appointment_date = $1 AND status IN ${HOLDING_SQL}
        AND ($2::bigint IS NULL OR id <> $2)
        AND ( ($3::int IS NOT NULL AND patient_id = $3)
           OR ($4::text IS NOT NULL AND upper(mrd) = upper($4))
           OR ($3::int IS NULL AND $4::text IS NULL AND $5::text IS NOT NULL AND phone = $5 AND lower(patient_name) = lower($6)) )
      LIMIT 1`, [p.date, excludeId, who.patientId, who.mrd, who.phone, who.name], c);
  if (dup) problems.push(`This patient already has an appointment that day (${dup.t ?? "waitlist"}, ${dup.status})`);

  if (p.doctorId) {
    const docs = await doctorsOnDate(p.date, c);
    const d = docs.find((x) => x.doctorId === p.doctorId);
    if (!d) problems.push("That doctor is not active");
    else if (d.onLeave) problems.push(`${d.name} is on leave on ${niceDate(p.date)}${d.note ? ` (${d.note})` : ""}`);
    else if (p.slotTime && d.sessions.length &&
             !d.sessions.some((s) => toMin(p.slotTime!) >= toMin(s.start) && toMin(p.slotTime!) < toMin(s.end)))
      warnings.push(`${p.slotTime} is outside ${d.name}'s hours (${d.sessions.map((s) => `${s.start}-${s.end}`).join(", ")})`);
    else if (p.slotTime && !d.sessions.length) warnings.push(`${d.name} has no session on this weekday`);
  }

  let freeSlots: string[] = [];
  if (p.slotTime) {
    const settings = await bookingSettings(c);
    const grid = slotGrid(settings);
    if (!grid.includes(p.slotTime)) problems.push(`${p.slotTime} is not a booking slot (slots run ${settings.dayStart}-${settings.dayEnd} every ${settings.slotMinutes} minutes)`);

    const max = await maxSlotsFor(p.date, c);
    const taken = await q<{ t: string; patient_name: string; id: number }>(
      `SELECT to_char(slot_time,'HH24:MI') AS t, patient_name, id FROM app.appointments
        WHERE appointment_date = $1 AND slot_time IS NOT NULL AND status IN ${ACTIVE_SQL} AND ($2::bigint IS NULL OR id <> $2)`,
      [p.date, excludeId], c);
    const takenSet = new Set(taken.map((t) => t.t));
    const nowMin = p.date === today ? toMin(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())) : -1;
    freeSlots = grid.filter((t) => !takenSet.has(t) && toMin(t) > nowMin);

    if (max <= 0 && !holiday) problems.push(`${niceDate(p.date)} is not open for booking yet (set the maximum slots for the day first)`);
    else if (taken.length >= max && max > 0) soft.push(`The day is full (${taken.length} of ${max} slots booked)`);
    // early booking limit (D-030): only when this adds a place on the day (a new booking, a waitlist patient given a
    // slot, or a move from another day); a change of time on the same day adds nothing
    const prev = excludeId ? await one<{ d: string; t: string | null }>(
      `SELECT to_char(appointment_date,'YYYY-MM-DD') AS d, to_char(slot_time,'HH24:MI') AS t FROM app.appointments WHERE id = $1`, [excludeId], c) : null;
    if (max > 0 && taken.length < max && !(prev && prev.d === p.date && prev.t)) {
      const e = earlyStatus(p.date, today, taken.length, max, await loadThresholds(c));
      if (e.restricted) {
        const next = e.unlocks.find((u) => u.newSlots > 0) ?? e.unlocks[0];
        soft.push(`${niceDate(p.date)} is limited to ${e.limit}% of its slots this far ahead (${e.days} days): ${e.booked} of ${e.max} booked (${e.percentageUsed}%)`
          + (next ? `; more open from ${niceDate(next.from!)} (${next.percentage}%)` : ""));
      }
    }
    const clash = taken.find((t) => t.t === p.slotTime);
    if (clash) soft.push(`${p.slotTime} is already booked for ${clash.patient_name}`);
    if (p.date === today && toMin(p.slotTime) <= nowMin) warnings.push(`${p.slotTime} has already passed today`);

    // HFA slots are held for HFA patients until 2 days before the day (Pavin, 19 Oct; D-024); a manager can override
    const opensOn = addDays(p.date, -HFA_OPEN_DAYS_BEFORE);
    const isHfa = isKind("HFA", { planOfAction: p.planOfAction ?? null, appointmentType: p.appointmentType ?? null, urgency: p.urgency ?? null,
                                  mrd: who.mrd, patientType: null });
    if (today < opensOn && !isHfa) {
      const hfaBlocks = (await loadBlocks(c)).filter((b) => b.kind === "HFA");
      if (blocksAt(hfaBlocks, p.date, p.slotTime).length)
        soft.push(`${p.slotTime} is kept for HFA patients; other plans can book it from ${niceDate(opensOn)} (${HFA_OPEN_DAYS_BEFORE} days before)`);
      freeSlots = freeSlots.filter((t) => !blocksAt(hfaBlocks, p.date, t).length);      // do not suggest held slots
    }
  }

  if (soft.length && override?.reason?.trim()) warnings.push(...soft.map((s) => `${s} - booked anyway: ${override.reason.trim()}`));
  else problems.push(...soft);

  if (problems.length) {
    const nearest = p.slotTime
      ? [...freeSlots].sort((a, b) => Math.abs(toMin(a) - toMin(p.slotTime!)) - Math.abs(toMin(b) - toMin(p.slotTime!))).slice(0, 6).sort()
      : [];
    throw new BookingRefused(problems[0], problems, nearest);
  }
  return warnings;
}

export async function addEvent(c: PoolClient, appointmentId: number, actorId: number | null, type: string,
                               from: unknown, to: unknown, note: string | null = null) {
  await c.query(`INSERT INTO app.appointment_events (appointment_id, actor_id, event_type, from_value, to_value, note)
                 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
                [appointmentId, actorId, type, from == null ? null : JSON.stringify(from), to == null ? null : JSON.stringify(to), note]);
}

export function describe(a: { patient_name: string; mrd: string | null }) {
  return a.mrd ? `${a.patient_name} (${a.mrd})` : a.patient_name;
}

export function whenText(date: string, slot: string | null) {
  return slot ? `${niceDate(date)} ${slot}` : `the ${niceDate(date)} waitlist`;
}

export { setAuditSummary };
