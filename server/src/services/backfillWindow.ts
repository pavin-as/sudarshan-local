// When IMAGEnet's past exams may be converted and their photographs graded (D-049): only outside clinic hours, so the
// ImageNet PC and shichika stay quick for the clinic. Setting retina.topcon_backfill_window = { from: "20:00", to: "07:00",
// sundays: true } in clinic time; "past" = saved before today (clinic time). Today's exams are never held back.
import { config } from "../config.js";
import { setting } from "./outreach.js";

export interface BackfillWindow { from: string; to: string; sundays: boolean }
export const DEFAULT_WINDOW: BackfillWindow = { from: "20:00", to: "07:00", sundays: true };

function clinicParts(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), sunday: p.weekday === "Sun" };
}
const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };

/** Midnight at the start of today in clinic time. */
export function startOfToday(now = new Date()): Date {
  return new Date(`${clinicParts(now).date}T00:00:00+05:30`);
}

/** Is the window open at this moment? A window that crosses midnight (20:00 to 07:00) is open on both sides of it. */
export function windowOpen(w: BackfillWindow, now = new Date()): boolean {
  const c = clinicParts(now);
  if (w.sundays && c.sunday) return true;
  const from = toMinutes(w.from), to = toMinutes(w.to);
  return from <= to ? c.minutes >= from && c.minutes < to : c.minutes >= from || c.minutes < to;
}

export async function backfillWindow(): Promise<BackfillWindow> {
  const v = await setting<Partial<BackfillWindow> | null>("retina.topcon_backfill_window", null);
  return { ...DEFAULT_WINDOW, ...(v ?? {}) };
}
export async function backfillOpen(now = new Date()): Promise<boolean> {
  return windowOpen(await backfillWindow(), now);
}
