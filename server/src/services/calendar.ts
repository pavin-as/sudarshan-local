// The clinic calendar: which days are open, how many slots, which doctors sit, which slots are free.
// Mirrors the Google app: a day is bookable only when its maximum slots (planningB) is above 0,
// slots run on a fixed grid (default 09:00-17:50 every 10 minutes), one patient per slot,
// and bookings without a time are the waitlist.
import type { Db } from "../db.js";
import { loadThresholds, earlyStatus, loadWaitlistPercent, waitlistLimit, type EarlyStatus } from "./earlyBooking.js";
import { q, one } from "../db.js";
import { fromMin, isoWeekday, todayIST, toMin } from "../lib/time.js";

/** Statuses that hold a place in the day. Waitlist and cancelled do not. */
export const ACTIVE_STATUSES = ["booked", "confirmed", "checked_in", "completed", "no_show"] as const;
const ACTIVE_SQL = `('booked','confirmed','checked_in','completed','no_show')`;

export interface BookingSettings { slotMinutes: number; dayStart: string; dayEnd: string }

function firstNumber(v: unknown): number | null {
  const items = Array.isArray(v) ? v : [v];
  for (const x of items) { const n = parseInt(String(x), 10); if (Number.isFinite(n) && n > 0) return n; }
  return null;
}

export async function bookingSettings(db?: Db): Promise<BookingSettings> {
  const rows = await q<{ key: string; value: any }>(
    `SELECT key, value FROM app.settings
      WHERE key IN ('booking.slot_minutes','booking.day_start','booking.day_end','general.Appointment slots (minutes)')`, [], db);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const slotMinutes = firstNumber(s["booking.slot_minutes"]) ?? firstNumber(s["general.Appointment slots (minutes)"]) ?? 10;
  const okTime = (v: unknown, d: string) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : d);
  return { slotMinutes, dayStart: okTime(s["booking.day_start"], "09:00"), dayEnd: okTime(s["booking.day_end"], "18:00") };
}

export function slotGrid(s: BookingSettings): string[] {
  const out: string[] = [];
  for (let m = toMin(s.dayStart); m < toMin(s.dayEnd); m += s.slotMinutes) out.push(fromMin(m));
  return out;
}

export interface DoctorDay { doctorId: number; name: string; sessions: { start: string; end: string }[]; onLeave: boolean; note: string | null }

/** Each active doctor's sessions on a date: weekly schedule, minus leave, with partial days and extra sessions applied. */
export async function doctorsOnDate(date: string, db?: Db): Promise<DoctorDay[]> {
  const weekday = isoWeekday(date);
  const rows = await q<any>(
    `SELECT d.id, d.name,
            coalesce((SELECT json_agg(json_build_object('start', to_char(s.start_time,'HH24:MI'), 'end', to_char(s.end_time,'HH24:MI')) ORDER BY s.start_time)
                        FROM app.doctor_schedule s
                       WHERE s.doctor_id = d.id AND s.weekday = $2
                         AND (s.valid_from IS NULL OR s.valid_from <= $1) AND (s.valid_to IS NULL OR s.valid_to >= $1)), '[]') AS weekly,
            coalesce((SELECT json_agg(json_build_object('kind', e.kind, 'start', to_char(e.start_time,'HH24:MI'),
                                                        'end', to_char(e.end_time,'HH24:MI'), 'reason', e.reason) ORDER BY e.start_time NULLS FIRST)
                        FROM app.doctor_exceptions e WHERE e.doctor_id = d.id AND e.on_date = $1), '[]') AS exceptions
       FROM app.doctors d WHERE d.is_active ORDER BY d.name`, [date, weekday], db);
  return rows.map((r) => {
    const ex: any[] = r.exceptions;
    const leave = ex.find((e) => e.kind === "leave");
    const partial = ex.filter((e) => e.kind === "partial" && e.start && e.end);
    const extra = ex.filter((e) => e.kind === "extra" && e.start && e.end);
    let sessions: { start: string; end: string }[] = leave ? [] : partial.length ? partial.map((e) => ({ start: e.start, end: e.end })) : r.weekly;
    sessions = [...sessions, ...extra.map((e) => ({ start: e.start, end: e.end }))].sort((a, b) => a.start.localeCompare(b.start));
    const note = [leave?.reason, ...partial.map((e) => e.reason), ...extra.map((e) => e.reason)].filter(Boolean).join("; ") || null;
    return { doctorId: r.id, name: r.name, sessions, onLeave: !!leave, note };
  });
}

export interface DayInfo {
  date: string; weekday: number; holiday: string | null; maxSlots: number;
  booked: number; remaining: number; waitlist: number; open: boolean; closedReason: string | null;
  early: EarlyStatus | null;          // early booking limit (D-030), for open days from today on
  waitlistLimit: number;              // waiting list size (D-031)
}

export async function daysInfo(from: string, to: string, db?: Db): Promise<DayInfo[]> {
  const rows = await q<any>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date, h.reason AS holiday, coalesce(c.max_slots, 0) AS max_slots,
            (SELECT count(*)::int FROM app.appointments a WHERE a.appointment_date = d::date AND a.slot_time IS NOT NULL AND a.status IN ${ACTIVE_SQL}) AS booked,
            (SELECT count(*)::int FROM app.appointments a WHERE a.appointment_date = d::date AND a.status = 'waitlist') AS waitlist
       FROM generate_series($1::date, $2::date, interval '1 day') d
       LEFT JOIN app.holidays h ON h.on_date = d::date
       LEFT JOIN app.day_capacity c ON c.on_date = d::date
      ORDER BY d`, [from, to], db);
  const thresholds = await loadThresholds(db), today = todayIST(), wlPercent = await loadWaitlistPercent(db);
  return rows.map((r) => {
    const closedReason = r.holiday ? `Holiday: ${r.holiday}` : r.max_slots <= 0 ? "Not open for booking (maximum slots not set)" : null;
    return { date: r.date, weekday: isoWeekday(r.date), holiday: r.holiday, maxSlots: r.max_slots, booked: r.booked,
             remaining: Math.max(0, r.max_slots - r.booked), waitlist: r.waitlist, open: !closedReason, closedReason,
             early: !closedReason && r.date >= today ? earlyStatus(r.date, today, r.booked, r.max_slots, thresholds) : null,
             waitlistLimit: r.max_slots > 0 ? waitlistLimit(r.max_slots, wlPercent) : 0 };
  });
}

export interface SlotInfo { time: string; appointments: { id: number; patientName: string; mrd: string | null; status: string; familyGroup: string | null }[] }

export async function slotsOnDate(date: string, db?: Db): Promise<{ day: DayInfo; slots: SlotInfo[]; settings: BookingSettings }> {
  const settings = await bookingSettings(db);
  const [day] = await daysInfo(date, date, db);
  const taken = await q<any>(
    `SELECT id, to_char(slot_time, 'HH24:MI') AS time, patient_name, mrd, status, family_group
       FROM app.appointments WHERE appointment_date = $1 AND slot_time IS NOT NULL AND status IN ${ACTIVE_SQL}
      ORDER BY slot_time, id`, [date], db);
  const byTime = new Map<string, SlotInfo["appointments"]>();
  for (const t of taken) {
    const list = byTime.get(t.time) ?? [];
    list.push({ id: t.id, patientName: t.patient_name, mrd: t.mrd, status: t.status, familyGroup: t.family_group });
    byTime.set(t.time, list);
  }
  const grid = slotGrid(settings);
  // bookings at times off the grid (imported, or the grid changed) still show
  const times = [...new Set([...grid, ...byTime.keys()])].sort();
  return { day, settings, slots: times.map((time) => ({ time, appointments: byTime.get(time) ?? [] })) };
}

export async function maxSlotsFor(date: string, db?: Db): Promise<number> {
  return (await one<{ m: number }>("SELECT max_slots AS m FROM app.day_capacity WHERE on_date = $1", [date], db))?.m ?? 0;
}
