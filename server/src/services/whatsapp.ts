// WhatsApp messages through AiSensy (D-034), as the Google app sent them (broadcast.js): a Meta-approved template
// ("campaign") filled with the patient's name, the date and the time. A person always starts the send: the day's
// reminders from the WhatsApp page (preview first), one message from the appointment panel. The outbox worker only
// delivers what a person queued; nothing is sent by a schedule or by AI.
// The key is AISENSY_API_KEY in .env (never logged, never shown). Phone numbers are not written to the server log.
import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";
import { one, q, setAuditSummary, withTx, type AuditContext, type Db } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { niceDate } from "../lib/time.js";
import { describe } from "./booking.js";
import { cleanPhone, isPracticeBooking, modeOf, scrubNumbers, setting, type Mode } from "./outreach.js";

// ---------- templates ------------------------------------------------------------------
export const PARAMS = ["name", "date", "time", "doctor", "amount", "link"] as const;
export type Param = (typeof PARAMS)[number];
export const PARAM_WORDS: Record<Param, string> = {
  name: "patient's name", date: "appointment date (17-June-2026)", time: "appointment time (4:10 PM)", doctor: "doctor",
  amount: "amount (₹500)", link: "payment link",
};
export interface Template { key: string; label: string; campaign: string; params: Param[]; kind: "appointment" | "payment" }
export const DEFAULT_TEMPLATES: Template[] = [
  { key: "appointment_reminder", label: "Appointment reminder", campaign: "sudarsdhan_appointment", params: ["name", "date", "time"], kind: "appointment" },
  { key: "payment_link", label: "Payment link", campaign: "", params: ["name", "amount", "link"], kind: "payment" },
];

export async function loadTemplates(db?: Db): Promise<Template[]> {
  const v = await setting<Template[]>("messaging.templates", DEFAULT_TEMPLATES, db);
  return Array.isArray(v) && v.length ? v : DEFAULT_TEMPLATES;
}

export async function templateFor(key: string, db?: Db): Promise<Template> {
  const t = (await loadTemplates(db)).find((x) => x.key === key);
  if (!t) throw notFound("WhatsApp template");
  if (!t.campaign) throw badRequest(`"${t.label}" has no AiSensy campaign yet: add the name of its Meta-approved template on Settings`);
  return t;
}

/** Template problems in plain words, or null. */
export function validateTemplates(list: Template[]): string | null {
  const keys = new Set<string>();
  for (const t of list) {
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(t.key)) return `"${t.key}": a template key is lower-case letters, digits and _`;
    if (keys.has(t.key)) return `"${t.key}" appears twice`;
    keys.add(t.key);
    if (!t.label.trim()) return `"${t.key}" needs a name`;
    if (t.campaign && !/^[A-Za-z0-9_\- ]{2,80}$/.test(t.campaign)) return `"${t.label}": the AiSensy campaign name has letters, digits, _ or - only`;
    if (!t.params.length) return `"${t.label}" needs at least one value to fill in`;
    if (t.kind === "appointment" && (t.params.includes("amount") || t.params.includes("link"))) return `"${t.label}" is for appointments: amount and link belong to payment templates`;
    if (t.kind === "payment" && !t.params.includes("link")) return `"${t.label}" is a payment template: it must carry the link`;
  }
  for (const k of ["appointment_reminder", "payment_link"]) if (!keys.has(k)) return `The template "${k}" cannot be removed (rename it instead)`;
  return null;
}

// ---------- filling in -----------------------------------------------------------------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** '2026-06-17' -> '17-June-2026' (the Google app's wording in the approved template) */
export const waDate = (d: string) => `${Number(d.slice(8, 10))}-${MONTHS[Number(d.slice(5, 7)) - 1]}-${d.slice(0, 4)}`;
/** '16:10' -> '4:10 PM' */
export function waTime(t: string): string {
  const h = Number(t.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${t.slice(3, 5)} ${h >= 12 ? "PM" : "AM"}`;
}
export interface FillValues { name: string; date?: string | null; time?: string | null; doctor?: string | null; amount?: number | null; link?: string | null }
export function fillParams(t: Template, v: FillValues): string[] {
  return t.params.map((p) => {
    switch (p) {
      case "name": return v.name;
      case "date": return v.date ? waDate(v.date) : "";
      case "time": return v.time ? waTime(v.time) : "";
      case "doctor": return v.doctor ?? "the doctor";
      case "amount": return v.amount != null ? `₹${v.amount}` : "";
      case "link": return v.link ?? "";
    }
  });
}

// ---------- who may get a message ------------------------------------------------------
export interface MessagingSettings { mode: Mode; testNumbers: string[] }
export async function loadMessaging(db?: Db): Promise<MessagingSettings> {
  const nums = await setting<string[]>("messaging.test_numbers", [], db);
  return { mode: await modeOf("messaging.mode", db), testNumbers: (Array.isArray(nums) ? nums : []).map((n) => cleanPhone(n)).filter(Boolean) as string[] };
}

export interface Candidate { patientName: string; phone: string | null; status: string; slotTime: string | null }
/** The number to send to and null, or null and why not (plain words, shown in the preview). */
export function recipientFor(c: Candidate, s: MessagingSettings, opts: { kind: Template["kind"]; alreadySent: boolean }): { to: string | null; reason: string | null } {
  const no = (reason: string) => ({ to: null, reason });
  if (s.mode === "off") return no("WhatsApp is switched off (Settings)");
  if (opts.kind === "appointment") {
    if (!["booked", "confirmed"].includes(c.status)) return no(c.status === "waitlist" ? "On the waiting list (no time)" : `Appointment is ${c.status.replace("_", " ")}`);
    if (!c.slotTime) return no("On the waiting list (no time)");
  }
  if (!c.phone) return no("No phone number");
  const to = cleanPhone(c.phone);
  if (!to) return no(`Not a mobile number (${c.phone})`);
  if (opts.alreadySent) return no("Already sent");
  if (s.mode === "test") {
    if (!isPracticeBooking(c.patientName)) return no("Test mode: only TEST bookings get messages");
    if (!s.testNumbers.includes(to)) return no("Test mode: not one of the test numbers");
  }
  return { to, reason: null };
}

// ---------- AiSensy --------------------------------------------------------------------
export interface WaRequest { campaignName: string; destination: string; userName: string; templateParams: string[] }
export type WaResult = { ok: true; ref: string | null } | { ok: false; error: string };
export type WaTransport = (r: WaRequest) => Promise<WaResult>;

export const aisensyConfigured = () => !!process.env.AISENSY_API_KEY;

const aisensy: WaTransport = async (r) => {
  const key = process.env.AISENSY_API_KEY;
  if (!key) return { ok: false, error: "AiSensy key is not set (AISENSY_API_KEY in .env)" };
  const url = process.env.AISENSY_API_URL || "https://backend.aisensy.com/campaign/t1/api/v2";
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
                                   body: JSON.stringify({ apiKey: key, ...r }) });
    const text = (await res.text()).split(key).join("***");             // never keep the key, even if echoed back
    let body: any = {}; try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (res.ok) return { ok: true, ref: String(body.messageId ?? body.id ?? body.submitted_message_id ?? "") || null };
    return { ok: false, error: `AiSensy refused it (HTTP ${res.status}): ${String(body.message ?? body.error ?? text).slice(0, 300)}` };
  } catch (e: any) {
    return { ok: false, error: e?.name === "TimeoutError" ? "AiSensy did not answer within 20 seconds" : `Could not reach AiSensy: ${String(e?.message ?? e).slice(0, 200)}` };
  }
};
let transport: WaTransport = aisensy;
/** Tests replace the AiSensy call; nothing else should. */
export function setWhatsAppTransport(t: WaTransport | null) { transport = t ?? aisensy; }

// ---------- previews and queueing ------------------------------------------------------
export interface PreviewRow { appointmentId: number; patientName: string; mrd: string | null; slotTime: string | null; doctor: string | null;
                              phone: string | null; to: string | null; send: boolean; reason: string | null }

/** Everyone booked with a time on a day, and whether this template would go to them. Changes nothing. */
export async function previewDay(date: string, templateKey: string, db?: Db): Promise<{ template: Template; mode: Mode; rows: PreviewRow[] }> {
  const t = await templateFor(templateKey, db);
  if (t.kind !== "appointment") throw badRequest(`"${t.label}" is not a template for the day's patients`);
  const s = await loadMessaging(db);
  const list = await q<any>(
    `SELECT a.id, a.patient_name, a.mrd, a.phone, a.status, to_char(a.slot_time,'HH24:MI') AS slot_time, d.name AS doctor,
            EXISTS (SELECT 1 FROM app.messages m WHERE m.appointment_id = a.id AND m.template = $2 AND m.status IN ('queued','sent')
                     AND m.payload->>'appointment_date' = to_char(a.appointment_date,'YYYY-MM-DD')) AS already
       FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id
      WHERE a.appointment_date = $1 AND a.status IN ('booked','confirmed')
      ORDER BY a.slot_time NULLS LAST, a.id`, [date, t.key], db);
  const rows = list.map((a) => {
    const r = recipientFor({ patientName: a.patient_name, phone: a.phone, status: a.status, slotTime: a.slot_time }, s, { kind: "appointment", alreadySent: a.already });
    return { appointmentId: a.id, patientName: a.patient_name, mrd: a.mrd, slotTime: a.slot_time, doctor: a.doctor, phone: a.phone,
             to: r.to, send: !!r.to, reason: r.reason };
  });
  return { template: t, mode: s.mode, rows };
}

/** Queue the day's messages a person chose from the preview. Only those still allowed are queued. */
export async function queueBroadcast(ctx: AuditContext, userId: number, date: string, templateKey: string, appointmentIds: number[]) {
  return withTx(ctx, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('broadcast:' || $1 || ':' || $2))", [date, templateKey]);   // two people pressing Send at once
    const p = await previewDay(date, templateKey, c);
    if (p.mode === "off") throw conflict("WhatsApp is switched off (Settings)");
    const chosen = new Set(appointmentIds);
    const go = p.rows.filter((r) => r.send && chosen.has(r.appointmentId));
    if (!go.length) throw conflict("Nobody on this list can be sent the message now: preview the day again");
    const mode = p.mode as "test" | "live";
    await setAuditSummary(c, `WhatsApp ${p.template.label.toLowerCase()} for ${niceDate(date)}: ${go.length} queued${mode === "test" ? " (test mode)" : ""}`);
    const b = await one<{ id: number }>(
      `INSERT INTO app.broadcasts (template, campaign, for_date, mode, queued, skipped, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [p.template.key, p.template.campaign, date, mode, go.length, p.rows.length - go.length, userId], c);
    for (const r of go) await insertMessage(c, { template: p.template, to: r.to!, appointmentId: r.appointmentId, broadcastId: b!.id, paymentId: null, mode, userId,
      values: { name: r.patientName, date, time: r.slotTime, doctor: r.doctor }, extra: { appointment_date: date, slot: r.slotTime, patient_name: r.patientName } });
    return { broadcastId: b!.id, queued: go.length, notSent: p.rows.length - go.length };
  });
}

async function insertMessage(c: PoolClient, m: { template: Template; to: string; appointmentId: number | null; broadcastId: number | null; paymentId: number | null;
                                                 mode: "test" | "live"; userId: number; values: FillValues; extra: Record<string, unknown> }) {
  const params = fillParams(m.template, m.values);
  const r = await one<{ id: number }>(
    `INSERT INTO app.messages (channel, template, recipient, patient_id, appointment_id, broadcast_id, payment_id, payload, status, mode, created_by)
     VALUES ('whatsapp', $1, $2, (SELECT patient_id FROM app.appointments WHERE id = $3::bigint), $3, $4, $5, $6::jsonb, 'queued', $7, $8)
     RETURNING id`,
    [m.template.key, m.to, m.appointmentId, m.broadcastId, m.paymentId,
     JSON.stringify({ campaign: m.template.campaign, params, ...m.extra }), m.mode, m.userId], c);
  return r!.id;
}

/** One message about one appointment (reminder from the appointment panel). `again` sends a reminder already sent. */
export async function queueAppointmentMessage(ctx: AuditContext, userId: number, appointmentId: number, templateKey: string, again: boolean) {
  const t = await templateFor(templateKey);
  if (t.kind !== "appointment") throw badRequest(`"${t.label}" is sent from the payment, not from here`);
  return withTx(ctx, async (c) => {
    const a = await one<any>(
      `SELECT a.id, a.patient_name, a.mrd, a.phone, a.status, to_char(a.appointment_date,'YYYY-MM-DD') AS date,
              to_char(a.slot_time,'HH24:MI') AS slot_time, d.name AS doctor
         FROM app.appointments a LEFT JOIN app.doctors d ON d.id = a.doctor_id WHERE a.id = $1 FOR UPDATE OF a`, [appointmentId], c);
    if (!a) throw notFound("Appointment");
    const already = !!(await one(`SELECT 1 FROM app.messages WHERE appointment_id = $1 AND template = $2 AND status IN ('queued','sent')
                                    AND payload->>'appointment_date' = $3`, [a.id, t.key, a.date], c));
    const s = await loadMessaging(c);
    const r = recipientFor({ patientName: a.patient_name, phone: a.phone, status: a.status, slotTime: a.slot_time }, s, { kind: "appointment", alreadySent: already && !again });
    if (!r.to) throw conflict(r.reason === "Already sent" ? `The ${t.label.toLowerCase()} for this day was already sent: choose "Send again" to send it once more` : r.reason!);
    await setAuditSummary(c, `WhatsApp ${t.label.toLowerCase()} to ${describe(a)} for ${niceDate(a.date)} ${a.slot_time}${again && already ? " (again)" : ""}${s.mode === "test" ? " (test mode)" : ""}`);
    const id = await insertMessage(c, { template: t, to: r.to, appointmentId: a.id, broadcastId: null, paymentId: null, mode: s.mode as "test" | "live", userId,
      values: { name: a.patient_name, date: a.date, time: a.slot_time, doctor: a.doctor }, extra: { appointment_date: a.date, slot: a.slot_time, patient_name: a.patient_name } });
    return { messageId: id };
  });
}

/** The payment-link message (template payment_link); called by services/payments.ts inside its transaction. */
export async function queuePaymentMessage(c: PoolClient, userId: number, p: { paymentId: number; appointmentId: number | null; patientName: string; phone: string;
                                                                              amount: number; link: string }) {
  const t = await templateFor("payment_link", c);
  const s = await loadMessaging(c);
  const already = !!(await one(`SELECT 1 FROM app.messages WHERE payment_id = $1 AND status IN ('queued','sent')`, [p.paymentId], c));
  const r = recipientFor({ patientName: p.patientName, phone: p.phone, status: "booked", slotTime: null }, s, { kind: "payment", alreadySent: already });
  if (!r.to) throw conflict(r.reason === "Already sent" ? "This payment link was already sent on WhatsApp" : r.reason!);
  return insertMessage(c, { template: t, to: r.to, appointmentId: p.appointmentId, broadcastId: null, paymentId: p.paymentId, mode: s.mode as "test" | "live", userId,
    values: { name: p.patientName, amount: p.amount, link: p.link }, extra: { patient_name: p.patientName } });
}

// ---------- the outbox worker ------------------------------------------------------------
let delivering = false;
/** Send every queued message, one at a time. Returns how many were handled. Runs every few seconds (index.ts). */
export async function deliverQueued(log?: Pick<FastifyBaseLogger, "error" | "info">): Promise<number> {
  if (delivering) return 0;
  delivering = true;
  let n = 0;
  try {
    for (;;) {
      // claim one message: attempts = 1 before the call, so a restart in the middle never sends it twice
      const m = await withTx({ userId: null, source: "job" }, async (c) => {
        const row = await one<any>(
          `SELECT m.id, m.template, m.recipient, m.payload, m.attempts, m.mode, m.broadcast_id, m.payment_id, m.appointment_id, a.mrd
             FROM app.messages m LEFT JOIN app.appointments a ON a.id = m.appointment_id
            WHERE m.status = 'queued' AND m.channel = 'whatsapp' ORDER BY m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`, [], c);
        if (!row) return null;
        const who = describe({ patient_name: row.payload?.patient_name ?? "a patient", mrd: row.mrd });
        if (row.attempts > 0) {
          await setAuditSummary(c, `WhatsApp to ${who} not sent: the server stopped while sending it`);
          await c.query(`UPDATE app.messages SET status = 'failed', error = $2 WHERE id = $1`,
                        [row.id, "The server stopped while sending this message: it may or may not have arrived. Check with the patient before sending again."]);
          return { skip: true, row };
        }
        const s = await loadMessaging(c);
        const stop = s.mode === "off" ? "WhatsApp was switched off before this message was sent"
          : s.mode === "test" && !s.testNumbers.includes(row.recipient) ? "Test mode: not one of the test numbers" : null;
        if (stop) {
          await setAuditSummary(c, `WhatsApp to ${who} not sent: ${stop}`);
          await c.query(`UPDATE app.messages SET status = 'skipped', error = $2 WHERE id = $1`, [row.id, stop]);
          return { skip: true, row };
        }
        await setAuditSummary(c, `Sending WhatsApp to ${who}`);
        await c.query(`UPDATE app.messages SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        return { skip: false, row, who };
      });
      if (!m) break;
      n++;
      if (!m.skip) {
        const r = await transport({ campaignName: m.row.payload.campaign, destination: m.row.recipient,
                                    userName: m.row.payload.patient_name ?? "Patient", templateParams: m.row.payload.params ?? [] });
        await withTx({ userId: null, source: "job", summary: r.ok ? `WhatsApp sent to ${m.who}` : `WhatsApp to ${m.who} failed: ${r.error}` }, async (c) => {
          if (r.ok) await c.query(`UPDATE app.messages SET status = 'sent', sent_at = now(), provider_ref = $2, error = NULL WHERE id = $1`, [m.row.id, r.ref]);
          else await c.query(`UPDATE app.messages SET status = 'failed', error = $2 WHERE id = $1`, [m.row.id, r.error]);
          if (r.ok && m.row.payment_id)
            await c.query(`UPDATE app.payments SET status = CASE WHEN status = 'created' THEN 'sent' ELSE status END,
                                                  sent_at = coalesce(sent_at, now()), sent_via = coalesce(sent_via, 'whatsapp') WHERE id = $1`, [m.row.payment_id]);
        });
        if (!r.ok) log?.error({ messageId: m.row.id }, `whatsapp message failed: ${scrubNumbers(r.error)}`);
      }
      if (m.row.broadcast_id)
        await withTx({ userId: null, source: "job", summary: "WhatsApp broadcast finished" }, (c) => c.query(
          `UPDATE app.broadcasts SET finished_at = now() WHERE id = $1 AND finished_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM app.messages WHERE broadcast_id = $1 AND status = 'queued')`, [m.row.broadcast_id]));
    }
  } finally { delivering = false; }
  return n;
}
