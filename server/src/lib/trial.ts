// Trial (D-025): until cut-over the Google app is the master of everything imported from it - bookings, the cancel list,
// direct calls, triage - and of the clinic calendar. scripts/refresh-from-google.ps1 copies them every 15 minutes, so a
// change made here would be overwritten; Sudarshan refuses it with a plain explanation. Setting 'trial.google_master'.
import { one } from "../db.js";
import { HttpError } from "./errors.js";

let cache: { at: number; on: boolean } | null = null;

export async function googleIsMaster(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 30_000) return cache.on;
  const r = await one<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = 'trial.google_master'`);
  const on = r ? r.value === true || r.value === "true" : false;
  cache = { at: Date.now(), on };
  return on;
}

export class FromGoogle extends HttpError {
  constructor(what: string) {
    super(409, "from_google_app", `${what} comes from the Google app during the trial: change it there. Sudarshan copies it every 15 minutes.`);
  }
}

/** Refuse a change to a record imported from the Google app (legacy_id set) while the Google app is the master. */
export async function guardImported(row: { legacy_id?: string | null }, what = "This booking") {
  if (row.legacy_id && (await googleIsMaster())) throw new FromGoogle(what);
}

/** Refuse a change to the clinic calendar while the Google app is the master. */
export async function guardCalendar() {
  if (await googleIsMaster()) throw new FromGoogle("The clinic calendar (maximum slots, holidays, doctors' hours and leave)");
}
