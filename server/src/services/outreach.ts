// What WhatsApp messages and Razorpay payment links share (D-034): the off / test / live switch, and which bookings
// test mode may touch. Test mode is for practice bookings made in Sudarshan (named TEST, or ZZ Test in the API test),
// so no real patient gets a message or a payment link before cut-over. Live is refused while the Google app is the
// master (D-025): until then the Google app sends the clinic's reminders, and two systems would message patients twice.
import { one, type Db } from "../db.js";
import { HttpError } from "../lib/errors.js";
import { googleIsMaster } from "../lib/trial.js";

export type Mode = "off" | "test" | "live";
export const MODES: Mode[] = ["off", "test", "live"];
export const MODE_WORDS: Record<Mode, string> = { off: "Off", test: "Test mode", live: "Live" };

export async function setting<T>(key: string, dflt: T, db?: Db): Promise<T> {
  const r = await one<{ value: T }>(`SELECT value FROM app.settings WHERE key = $1`, [key], db);
  return r ? r.value : dflt;
}

export async function modeOf(key: "messaging.mode" | "payments.mode", db?: Db): Promise<Mode> {
  const v = await setting<string>(key, "test", db);
  return MODES.includes(v as Mode) ? (v as Mode) : "test";
}

/** A practice booking: the trial banner asks staff to name them TEST; the API test names its bookings ZZ Test. */
export function isPracticeBooking(patientName: string | null | undefined): boolean {
  return /^\s*(test\b|zz test\b)/i.test(patientName ?? "");
}

/** Refuse turning a switch to live before cut-over. */
export async function guardLive(what: string) {
  if (await googleIsMaster())
    throw new HttpError(409, "not_before_cutover", `${what} can go live only after cut-over: the Google app is still the master (trial). Use test mode until then.`);
}

/** Phone number as AiSensy wants it: country code and number, digits only (91XXXXXXXXXX). null = not a mobile number. */
export function cleanPhone(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);                          // 00971... international prefix
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);       // 09xxxxxxxxx
  if (d.length === 10) return /^[6-9]/.test(d) ? `91${d}` : null; // Indian mobiles start 6-9; 0494... is a landline
  if (d.length === 12 && d.startsWith("91")) return /^91[6-9]/.test(d) ? d : null;
  if (d.length >= 11 && d.length <= 15 && !d.startsWith("0") && !d.startsWith("91")) return d;   // abroad (Gulf numbers)
  return null;
}

/** '919876543210' -> '+91 98765 43210' for screens. */
export function phoneText(p: string): string {
  return p.startsWith("91") && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`;
}

/** For the server log: long digit runs (phone numbers) blanked out. */
export const scrubNumbers = (t: string) => t.replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
