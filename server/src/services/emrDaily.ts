// EMR daily report (D-051): for each consultation of a day, which EMR completeness items (D-028) are not recorded in
// Yarago, by screen. The check is clinical.emr_visit_items() (migration 0027), the same one the monthly page counts.
// At emr.daily_at (17:30) the server keeps what was missing then, so the page can show what was completed afterwards.
import type { FastifyBaseLogger } from "fastify";
import { one, q, withTx } from "../db.js";
import { niceDate, timeStr, todayIST } from "../lib/time.js";
import { setting } from "./outreach.js";

export interface VisitCheck {
  visitId: number; patientId: number; time: string; statusId: number; isNew: boolean; missing: string[];
}
export interface ItemDef { screen: "optometry" | "doctor"; item: string; label: string; position: number }

/** Every visit of the day (checked in, in examination or completed; injections and lasers left out) and its missing items. */
export async function checkDay(date: string): Promise<{ visits: VisitCheck[]; items: ItemDef[] }> {
  const rows = await q<any>(
    `SELECT visit_id, patient_id, to_char(visit_at, 'HH24:MI') AS time, status_id, is_new, screen, item, label, item_position, ok
       FROM clinical.emr_visit_items($1::date, $1::date)
      ORDER BY visit_at, visit_id, item_position`, [date]);
  const visits = new Map<number, VisitCheck>();
  const items = new Map<string, ItemDef>();
  for (const r of rows) {
    items.set(r.item, { screen: r.screen, item: r.item, label: r.label, position: r.item_position });
    const v: VisitCheck = visits.get(r.visit_id) ?? { visitId: r.visit_id, patientId: r.patient_id, time: r.time, statusId: r.status_id, isNew: r.is_new, missing: [] };
    if (!r.ok) v.missing.push(r.item);
    visits.set(r.visit_id, v);
  }
  return { visits: [...visits.values()], items: [...items.values()] };
}

/** Keep what is missing now as the day's report. Once per day; false when it was already taken or there were no visits. */
export async function takeReport(date: string): Promise<boolean> {
  if (await one(`SELECT 1 FROM app.emr_daily_reports WHERE report_date = $1`, [date])) return false;
  const { visits } = await checkDay(date);
  if (!visits.length) return false;
  const kept = visits.map((v) => ({ visitId: v.visitId, statusId: v.statusId, missing: v.missing }));
  return withTx({ userId: null, source: "job", summary: `EMR daily report taken for ${niceDate(date)} (${visits.length} visits)` }, async (c) => {
    const r = await c.query(`INSERT INTO app.emr_daily_reports (report_date, visits) VALUES ($1, $2::jsonb) ON CONFLICT (report_date) DO NOTHING`,
      [date, JSON.stringify(kept)]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** The report time (setting emr.daily_at), "17:30" when unset or not a time. */
export async function reportTime(): Promise<string> {
  const at = await setting<string>("emr.daily_at", "17:30");
  return timeStr.safeParse(at).success ? at : "17:30";
}

/** Each minute: from emr.daily_at on, take today's report once (a restart later in the evening still takes it). */
export function startEmrDailyJob(logger: FastifyBaseLogger) {
  let done = "";
  const tick = async () => {
    try {
      const today = todayIST();
      if (done === today) return;
      const now = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }).slice(0, 5);
      if (now < await reportTime()) return;
      if (await takeReport(today)) logger.info(`EMR daily report taken for ${today}`);
      done = today;
    } catch (e: any) { logger.error({ err: e }, "EMR daily report"); }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, 60_000);
}
