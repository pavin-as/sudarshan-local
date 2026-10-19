// WhatsApp (D-034): the day's reminders (preview, then a person sends), one message from the appointment panel,
// what was sent, and the settings (mode, test numbers, templates). Sending itself is the outbox worker's job.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { q, withTx } from "../db.js";
import { badRequest, forbidden } from "../lib/errors.js";
import { dateStr } from "../lib/time.js";
import { cleanPhone, guardLive, MODE_WORDS, MODES, phoneText, type Mode } from "../services/outreach.js";
import { aisensyConfigured, deliverQueued, loadMessaging, loadTemplates, PARAM_WORDS, PARAMS, previewDay, queueAppointmentMessage,
         queueBroadcast, validateTemplates, type Template } from "../services/whatsapp.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

// the outbox runs every 5 s once index.ts started it; a send also wakes it at once (never in tests, which drive it themselves)
let outboxLive = false;
export function outboxStarted() { outboxLive = true; }
export function kickOutbox(log: any) { if (outboxLive) void deliverQueued(log).catch((e) => log.error({ err: e }, "whatsapp outbox")); }

const MSG_COLS = `m.id, m.template, m.recipient, m.status, m.error, m.mode, m.created_at AS "createdAt", m.sent_at AS "sentAt",
  m.appointment_id AS "appointmentId", m.broadcast_id AS "broadcastId", m.payment_id AS "paymentId",
  coalesce(a.patient_name, m.payload->>'patient_name') AS "patientName", a.mrd, u.full_name AS "createdBy",
  m.payload->>'appointment_date' AS "forDate", m.payload->>'slot' AS "slotTime"`;
const MSG_FROM = `FROM app.messages m LEFT JOIN app.appointments a ON a.id = m.appointment_id LEFT JOIN app.users u ON u.id = m.created_by`;

async function messageRows(where: string, params: unknown[], limit = 200) {
  const templates = new Map((await loadTemplates()).map((t) => [t.key, t.label]));
  const rows = await q<any>(`SELECT ${MSG_COLS} ${MSG_FROM} WHERE m.channel = 'whatsapp' AND m.legacy_ref IS NULL AND ${where}
                             ORDER BY m.id DESC LIMIT ${limit}`, params);
  return rows.map((r) => ({ ...r, templateLabel: templates.get(r.template) ?? r.template, to: phoneText(r.recipient) }));
}

const templateSchema = z.object({
  key: z.string().trim(), label: z.string().trim().max(60), campaign: z.string().trim().max(80),
  params: z.array(z.enum(PARAMS)).max(6), kind: z.enum(["appointment", "payment"]),
});

export async function whatsappRoutes(app: FastifyInstance) {
  app.get("/api/whatsapp/status", async (req) => {
    need(req, "messages.send");
    const s = await loadMessaging();
    const templates = await loadTemplates();
    const queued = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM app.messages WHERE status = 'queued' AND channel = 'whatsapp'`))[0].n;
    return { mode: s.mode, modeWords: MODE_WORDS[s.mode], keySet: aisensyConfigured(), testNumbers: s.testNumbers.length, queued,
             templates: templates.map((t) => ({ key: t.key, label: t.label, kind: t.kind, ready: !!t.campaign })) };
  });

  // who would get the day's message; saves nothing
  app.get("/api/whatsapp/preview", async (req) => {
    need(req, "messages.broadcast");
    const { date, template } = z.object({ date: dateStr, template: z.string().default("appointment_reminder") }).parse(req.query);
    const p = await previewDay(date, template);
    return { template: { key: p.template.key, label: p.template.label, campaign: p.template.campaign, params: p.template.params },
             mode: p.mode, keySet: aisensyConfigured(),
             rows: p.rows.map((r) => ({ ...r, to: r.to ? phoneText(r.to) : null })) };
  });

  app.post("/api/whatsapp/broadcasts", async (req) => {
    const me = need(req, "messages.broadcast");
    const b = z.object({ date: dateStr, template: z.string(), appointmentIds: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
    if (!aisensyConfigured()) throw badRequest("AiSensy is not set up yet (AISENSY_API_KEY in .env on shichika)");
    const r = await queueBroadcast(auditCtx(req), me.id, b.date, b.template, b.appointmentIds);
    kickOutbox(req.log);
    return r;
  });

  // the day's sends, newest first; the Google app's broadcasts (imported) are listed beside them for comparison
  app.get("/api/whatsapp/broadcasts", async (req) => {
    need(req, "messages.send");
    const templates = new Map((await loadTemplates()).map((t) => [t.key, t.label]));
    const mine = await q<any>(
      `SELECT b.id, b.template, b.campaign, to_char(b.for_date,'YYYY-MM-DD') AS "forDate", b.mode, b.skipped AS "notSent",
              b.created_at AS "createdAt", b.finished_at AS "finishedAt", u.full_name AS "createdBy",
              count(m.id) FILTER (WHERE m.status = 'sent')::int AS sent, count(m.id) FILTER (WHERE m.status = 'failed')::int AS failed,
              count(m.id) FILTER (WHERE m.status = 'queued')::int AS queued, count(m.id) FILTER (WHERE m.status = 'skipped')::int AS skipped
         FROM app.broadcasts b LEFT JOIN app.users u ON u.id = b.created_by LEFT JOIN app.messages m ON m.broadcast_id = b.id
        GROUP BY b.id, u.full_name ORDER BY b.id DESC LIMIT 30`);
    const google = await q<any>(
      `SELECT id, template AS campaign, payload->>'appointment_date' AS "forDate", (payload->>'sent')::int AS sent,
              (payload->>'failed')::int AS failed, (payload->>'skipped')::int AS "notSent", payload->>'sent_by' AS "createdBy", created_at AS "createdAt"
         FROM app.messages WHERE channel = 'whatsapp' AND legacy_ref LIKE 'Broadcast:%' ORDER BY created_at DESC LIMIT 15`);
    return { broadcasts: mine.map((b) => ({ ...b, templateLabel: templates.get(b.template) ?? b.template })), googleApp: google };
  });

  app.get("/api/whatsapp/broadcasts/:id", async (req) => {
    need(req, "messages.send");
    const { id } = idParam.parse(req.params);
    const messages = await messageRows("m.broadcast_id = $1", [id], 500);
    return { messages };
  });

  app.get("/api/whatsapp/messages", async (req) => {
    need(req, "messages.send");
    const { status } = z.object({ status: z.enum(["queued", "sent", "failed", "skipped"]).optional() }).parse(req.query);
    return { messages: status ? await messageRows("m.status = $1", [status]) : await messageRows("true", []) };
  });

  // ---- one appointment ----
  app.get("/api/appointments/:id/messages", async (req) => {
    need(req, "appointments.read");
    const { id } = idParam.parse(req.params);
    return { messages: await messageRows("m.appointment_id = $1", [id], 50) };
  });

  app.post("/api/appointments/:id/messages", async (req) => {
    const me = need(req, "messages.send");
    const { id } = idParam.parse(req.params);
    const b = z.object({ template: z.string().default("appointment_reminder"), again: z.boolean().default(false) }).parse(req.body ?? {});
    if (!aisensyConfigured()) throw badRequest("AiSensy is not set up yet (AISENSY_API_KEY in .env on shichika)");
    const r = await queueAppointmentMessage(auditCtx(req), me.id, id, b.template, b.again);
    kickOutbox(req.log);
    return r;
  });

  // ---- settings ----
  app.get("/api/settings/whatsapp", async (req) => {
    need(req, "settings.manage");
    const s = await loadMessaging();
    const nums = await q<{ value: string[] }>(`SELECT value FROM app.settings WHERE key = 'messaging.test_numbers'`);
    return { mode: s.mode, modes: MODES.map((m) => ({ key: m, label: MODE_WORDS[m] })), keySet: aisensyConfigured(),
             testNumbers: nums[0]?.value ?? [], templates: await loadTemplates(),
             params: PARAMS.map((p) => ({ key: p, label: PARAM_WORDS[p] })) };
  });

  app.put("/api/settings/whatsapp", async (req) => {
    const me = need(req, "settings.manage");
    const b = z.object({
      mode: z.enum(MODES as [Mode, ...Mode[]]).optional(),
      testNumbers: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
      templates: z.array(templateSchema).min(2).max(20).optional(),
    }).parse(req.body);
    const changes: string[] = [];
    if (b.mode) {
      const cur = (await loadMessaging()).mode;
      if (b.mode === "live" && cur !== "live") {
        if (me.role !== "admin") throw forbidden("Only an admin can switch WhatsApp to live");
        await guardLive("WhatsApp");
        if (!aisensyConfigured()) throw badRequest("Set the AiSensy key in .env before going live");
      }
      changes.push(`mode ${MODE_WORDS[b.mode].toLowerCase()}`);
    }
    let nums: string[] | undefined;
    if (b.testNumbers) {
      const bad = b.testNumbers.filter((n) => !cleanPhone(n));
      if (bad.length) throw badRequest(`Not a mobile number: ${bad.join(", ")}`);
      nums = [...new Set(b.testNumbers.map((n) => cleanPhone(n)!))];
      changes.push(`${nums.length} test number${nums.length === 1 ? "" : "s"}`);
    }
    if (b.templates) {
      const problem = validateTemplates(b.templates as Template[]);
      if (problem) throw badRequest(problem);
      changes.push(`templates ${b.templates.map((t) => `${t.label}${t.campaign ? ` = ${t.campaign}` : " (no campaign)"}`).join(", ")}`);
    }
    if (!changes.length) throw badRequest("Nothing to change");
    await withTx(auditCtx(req, `WhatsApp settings: ${changes.join("; ").slice(0, 300)}`), async (c) => {
      const put = (k: string, v: unknown) => c.query(`INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
      if (b.mode) await put("messaging.mode", b.mode);
      if (nums) await put("messaging.test_numbers", nums);
      if (b.templates) await put("messaging.templates", b.templates);
    });
    return { ok: true };
  });
}
