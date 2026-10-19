// The two-line overview of the doctor summary, written by the LOCAL model (Ollama on shichika; D-006: patient data
// never goes to a cloud model). The model only reads the facts from services/summary.ts; its text is shown only when
// every number in it appears in those facts. Prepared for the day's patients from 07:00 to 09:00 (setting
// ai.overview_at); later in the day only when a summary is opened (booked later, or Yarago data changed).
import type { FastifyBaseLogger } from "fastify";
import { one, q, withTx } from "../db.js";
import { todayIST } from "../lib/time.js";
import { buildFacts, factsHash, numbersCheck, patientsForDay, type SummaryFacts } from "./summary.js";

export const PROMPT_VERSION = "ds-1";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

const SYSTEM = `You write the overview at the top of a retina clinic's doctor summary.
Write exactly two short sentences, at most 45 words in total, in plain clinical English.
Use only the facts given. Every number, date and vision value you write must appear in the facts exactly as written there.
Do not add a diagnosis, cause, advice or prediction that is not in the facts. Write "right eye" and "left eye".
Lead with what matters today: treatment course and what is due, then the vision trend.
Output only the two sentences.`;

/** What the model sees: the facts without name, MRD or ids (it does not need them). */
export function modelFacts(f: SummaryFacts) {
  const { patient, ...rest } = f;
  const strip = (o: any): any => Array.isArray(o) ? o.map(strip)
    : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => !/visitId|appointmentId|patientId/.test(k)).map(([k, v]) => [k, strip(v)]))
    : o;
  return { patient: { ageYears: patient.ageYears, sex: patient.sex, visits: patient.visits, firstVisit: patient.firstVisit }, ...strip(rest) };
}

async function setting(key: string, dflt: string): Promise<string> {
  const r = await one<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = $1`, [key]);
  return typeof r?.value === "string" && r.value ? r.value : dflt;
}

export async function writeOverview(f: SummaryFacts): Promise<{ text: string; model: string }> {
  const model = await setting("ai.overview_model", "qwen3.5:9b");
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, stream: false, think: false, keep_alive: "15m",
      options: { temperature: 0.2, num_ctx: 8192, num_predict: 200 },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Facts:\n${JSON.stringify(modelFacts(f))}` }] }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const body: any = await res.json();
  const text = String(body?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("empty answer from the model");
  return { text, model };
}

/** Prepare (or refresh) one patient's summary for a day. Returns the stored row id, or null when nothing changed. */
export async function prepare(patientId: number, date: string, why: string): Promise<number | null> {
  const facts = await buildFacts(patientId, date);
  if (!facts) return null;
  const hash = factsHash(facts);
  const cur = await one<{ id: number }>(`SELECT id FROM app.ai_summaries WHERE patient_id = $1 AND for_date = $2 AND kind = 'doctor_summary'
                                           AND status IN ('ready','failed') AND facts_hash = $3 ORDER BY generated_at DESC LIMIT 1`, [patientId, date, hash]);
  if (cur) return null;
  let overview: string | null = null, model: string | null = null, status = "ready", error: string | null = null, checked: unknown = null;
  try {
    const w = await writeOverview(facts);
    model = w.model;
    const c = numbersCheck(w.text, modelFacts(facts));
    checked = c;
    if (c.ok) overview = w.text;
    else { status = "failed"; error = `numbers not in the facts: ${c.unknown.join(", ")}`; overview = w.text; }
  } catch (e: any) {
    status = "failed"; error = String(e?.message ?? e).slice(0, 300);
  }
  const who = facts.patient.mrd ?? `patient ${patientId}`;
  return withTx({ userId: null, source: "job", summary: `Doctor summary prepared for ${who} (${date}, ${why})` }, async (c) => {
    await c.query(`UPDATE app.ai_summaries SET status = 'superseded' WHERE patient_id = $1 AND for_date = $2 AND kind = 'doctor_summary'
                     AND status IN ('ready','failed')`, [patientId, date]);
    const r = await c.query(`INSERT INTO app.ai_summaries (patient_id, for_date, kind, facts, overview, model, prompt_version, status, error, facts_hash, checked)
                             VALUES ($1,$2,'doctor_summary',$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,
      [patientId, date, JSON.stringify(facts), overview, model, PROMPT_VERSION, status, error, hash, JSON.stringify(checked)]);
    return r.rows[0].id as number;
  });
}

// ---------- one at a time (the GPU is shared with Yarago's server) ----------
const queue: { patientId: number; date: string; why: string }[] = [];
const queued = new Set<string>();
let running = false;

export function enqueue(patientId: number, date: string, why: string) {
  const k = `${patientId}:${date}`;
  if (queued.has(k)) return;
  queued.add(k); queue.push({ patientId, date, why });
  void drain();
}

let log: Pick<FastifyBaseLogger, "error"> = { error: (o: unknown, m?: string) => console.error(m, o) } as any;
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const j = queue.shift()!;
      try { await prepare(j.patientId, j.date, j.why); }
      catch (e: any) { log.error({ err: e }, "doctor summary failed"); }
      finally { queued.delete(`${j.patientId}:${j.date}`); }
    }
  } finally { running = false; }
}

/** 07:00 (ai.overview_at): the day's patients; then every 30 minutes until 09:00, patients booked since. */
export function startSummaryJob(logger: FastifyBaseLogger) {
  log = logger;
  let lastFull = "", lastTop = 0;
  const tick = async () => {
    try {
      const at = await setting("ai.overview_at", "07:00");
      const now = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }).slice(0, 5);
      const today = todayIST();
      // the automatic run stays inside 07:00-09:00 (GPU work before clinic hours); after that a summary is prepared
      // only when someone opens it, so a restart in the day never starts a batch
      if (now < at || now >= "09:00") return;
      const full = lastFull !== today;
      if (!full && Date.now() - lastTop < 30 * 60_000) return;
      lastFull = today; lastTop = Date.now();
      const ids = await patientsForDay(today);
      const have = new Set((await q<{ patient_id: number }>(
        `SELECT DISTINCT patient_id FROM app.ai_summaries WHERE for_date = $1 AND kind = 'doctor_summary'`, [today])).map((r) => r.patient_id));
      const todo = full ? ids : ids.filter((id) => !have.has(id));
      if (todo.length) logger.info(`doctor summaries: ${todo.length} to prepare for ${today}`);
      for (const id of todo) enqueue(id, today, full ? "morning" : "booked later");
    } catch (e: any) { logger.error({ err: e }, "doctor summary job"); }
  };
  setTimeout(tick, 10_000);
  return setInterval(tick, 60_000);
}
