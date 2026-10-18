// Small date/time helpers. Dates are 'YYYY-MM-DD' strings, times 'HH:MM', all in clinic time (IST).
import { z } from "zod";

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")), "Not a real date");
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Today's date in the clinic, whatever the server's own timezone is. */
export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 1 = Monday ... 7 = Sunday (ISO), matching app.doctor_schedule.weekday */
export function isoWeekday(d: string): number {
  const w = new Date(d + "T00:00:00Z").getUTCDay();
  return w === 0 ? 7 : w;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** '2026-10-21' -> '21 Oct 2026' (for audit sentences) */
export function niceDate(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
