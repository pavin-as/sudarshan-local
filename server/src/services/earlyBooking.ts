// Early booking limit (D-030), as the Google app applied it (Code.js checkSlotAvailability, selectThreshold,
// calculateTAAPercentage, customRound; bookAppointment.html unlock table). The further away a day is, the smaller the
// share of its maximum slots that may be booked, so places stay for patients who need to book close to the date.
// Over the limit = refused; a manager may book anyway with a written reason (Pavin, 19 Oct: option b).
import { q, type Db } from "../db.js";
import { addDays, isoWeekday } from "../lib/time.js";

export interface Threshold { days: number; percentage: number }
export const DEFAULT_THRESHOLDS: Threshold[] = [
  { days: 10, percentage: 51 }, { days: 5, percentage: 79 }, { days: 4, percentage: 85 }, { days: 1, percentage: 95 }, { days: 0, percentage: 100 },
];
export const SETTING_KEY = "booking.early_thresholds";

/** The Google app's rounding for "% used": above .5 rounds up, .5 or below rounds down. */
export const customRound = (v: number) => (v - Math.floor(v) > 0.5 ? Math.ceil(v) : Math.floor(v));

export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** The band that applies: the first, from the furthest, whose days the appointment is at least that far away. */
export function selectThreshold(days: number, all: Threshold[]): Threshold {
  const sorted = [...all].sort((a, b) => b.days - a.days);
  return sorted.find((t) => days >= t.days) ?? sorted[sorted.length - 1];
}

/** Settings rules (as the Google app's Settings page): 10-100%, rising as the day gets closer, a same-day band. */
export function validateThresholds(t: Threshold[]): string | null {
  if (!t.length) return "Give at least one band";
  if (t.some((x) => !Number.isInteger(x.days) || x.days < 0 || x.days > 60)) return "Days must be whole numbers from 0 to 60";
  if (t.some((x) => !Number.isInteger(x.percentage) || x.percentage < 10 || x.percentage > 100)) return "Each percentage must be between 10 and 100";
  if (new Set(t.map((x) => x.days)).size !== t.length) return "Each number of days may appear only once";
  const s = [...t].sort((a, b) => b.days - a.days);
  for (let i = 0; i < s.length - 1; i++) if (s[i].percentage > s[i + 1].percentage) return "Percentages must rise as the day gets closer (e.g. 51% ≤ 79% ≤ 95% ≤ 100%)";
  if (!t.some((x) => x.days === 0)) return "Add a same-day band (0 days)";
  return null;
}

export interface Unlock { days: number; from: string | null; percentage: number; slotsAllowed: number; newSlots: number }
export interface EarlyStatus {
  days: number; limit: number; band: number; booked: number; max: number; percentageUsed: number; restricted: boolean;
  allowedNow: number; unlocks: Unlock[];
}

/** Where a day stands. booked = places with a time (waitlist and cancelled bookings do not count). */
export function earlyStatus(date: string, today: string, booked: number, max: number, all: Threshold[]): EarlyStatus {
  const days = daysUntil(date, today);
  const t = selectThreshold(days, all);
  const percentageUsed = max > 0 ? customRound((100 * booked) / max) : 0;
  const upcoming = all.filter((x) => x.days < t.days).sort((a, b) => b.days - a.days);
  const unlocks = upcoming.map((x, i) => {
    let from: string | null = x.days === 0 ? date : addDays(date, -x.days);
    if (from && x.days > 0 && isoWeekday(from) === 7) from = addDays(from, -1);       // a Sunday unlock moves to Saturday
    const prev = i === 0 ? t.percentage : upcoming[i - 1].percentage;
    return { days: x.days, from, percentage: x.percentage, slotsAllowed: Math.floor((max * x.percentage) / 100),
             newSlots: Math.floor((max * x.percentage) / 100) - Math.floor((max * prev) / 100) };
  });
  return { days, limit: t.percentage, band: t.days, booked, max, percentageUsed, restricted: max > 0 && percentageUsed >= t.percentage,
           allowedNow: Math.floor((max * t.percentage) / 100), unlocks };
}

export async function loadThresholds(db?: Db): Promise<Threshold[]> {
  const r = await q<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = $1`, [SETTING_KEY], db);
  const v = r[0]?.value;
  return Array.isArray(v) && !validateThresholds(v as Threshold[]) ? (v as Threshold[]) : DEFAULT_THRESHOLDS;
}

// ---------- waiting list size (D-031), as the Google app's checkWaitingListLimit: at most ceil(max slots x 15%) ----------
export const WAITLIST_KEY = "booking.waitlist_percent";
export const DEFAULT_WAITLIST_PERCENT = 15;
export const waitlistLimit = (maxSlots: number, percent: number) => Math.ceil((maxSlots * percent) / 100);
export async function loadWaitlistPercent(db?: Db): Promise<number> {
  const r = await q<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = $1`, [WAITLIST_KEY], db);
  const v = Number(r[0]?.value);
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : DEFAULT_WAITLIST_PERCENT;
}
