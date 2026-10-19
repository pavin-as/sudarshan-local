const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function todayIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
export function addDays(d: string, n: number): string {
  const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
export function weekdayName(d: string, long = false): string {
  const w = new Date(d + "T00:00:00Z").getUTCDay();
  return long ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][w] : DAYS[w];
}
/** '2026-10-21' -> '21 Oct' (adds the year when it is not this year) */
export function niceDate(d: string | null | undefined, withYear = false): string {
  if (!d) return "";
  const y = d.slice(0, 4), m = MONTHS[Number(d.slice(5, 7)) - 1], day = Number(d.slice(8, 10));
  return withYear || y !== todayIST().slice(0, 4) ? `${day} ${m} ${y}` : `${day} ${m}`;
}
/** relative name for nearby days */
export function dayLabel(d: string): string {
  const t = todayIST();
  if (d === t) return "Today";
  if (d === addDays(t, 1)) return "Tomorrow";
  if (d === addDays(t, -1)) return "Yesterday";
  return `${weekdayName(d)} ${niceDate(d)}`;
}
/** ISO timestamp -> '10:42' in clinic time */
export function clock(ts: string | null | undefined): string {
  if (!ts) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
}
/** ISO timestamp -> '21 Oct, 10:42' */
export function stamp(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ts));
  return `${niceDate(d)}, ${clock(ts)}`;
}
export function money(n: number | null | undefined): string {
  if (n == null) return "";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
export const STATUS_WORDS: Record<string, string> = {
  waitlist: "Waitlist", booked: "Booked", confirmed: "Confirmed", checked_in: "Checked in",
  completed: "Completed", cancelled: "Cancelled", no_show: "Did not come",
};

/** A plan of action as saved by the Google app ('["REF","DIL","OCT (LE)"]') or typed ("REF, DIL") -> its items. */
export function planItems(p: string | null | undefined): string[] {
  if (!p) return [];
  const s = p.trim();
  if (s.startsWith("[")) {
    try { const v = JSON.parse(s); if (Array.isArray(v)) return v.map((x) => String(typeof x === "object" && x ? (x as any).name : x).trim()).filter(Boolean); }
    catch { /* not JSON after all */ }
  }
  return s.split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean);
}
const EYES: Record<string, string> = { RE: "right eye", LE: "left eye", BE: "both eyes" };
/** For reading: "REF, DIL, OCT (left eye)". */
export function planText(p: string | null | undefined): string {
  return planItems(p).map((x) => x.replace(/\((RE|LE|BE)\)/i, (_, e: string) => `(${EYES[e.toUpperCase()]})`)).join(", ");
}
/** For editing: "REF, DIL, OCT (LE)" (eye codes kept, no brackets or quotes). */
export const planEditText = (p: string | null | undefined) => planItems(p).join(", ");
