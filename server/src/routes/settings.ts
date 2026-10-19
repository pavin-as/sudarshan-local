// Settings (managers and admins): the booking grid, the scheduling rules' switches and numbers, the visit and
// patient type lists, and the plan-of-action list (preparation minutes feed the consultation-time rules).
// Secrets are never settings (.env only); the Google app's API-key page is not carried over.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, setAuditSummary, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { timeStr, toMin } from "../lib/time.js";
import { bookingSettings, slotGrid } from "../services/calendar.js";
import { DEFAULT_RULE_SETTINGS, parseRuleSettings, RULE_FIELDS, RULE_SWITCH_LABELS, RULE_SWITCHES } from "../services/rules.js";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const LISTS: Record<string, { key: string; label: string }> = {
  "appointment-types": { key: "general.Appointment Type List", label: "Visit types" },
  "patient-types": { key: "general.Patient Type", label: "Patient types" },
};
/** A stored list may be ["A, B, C"] (the Google app kept some as one line) or ["A", "B"]: always give separate items. */
export function listItems(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return [...new Set(arr.flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))];
}

async function putSetting(c: any, key: string, value: unknown, description?: string) {
  await c.query(`INSERT INTO app.settings (key, value, description) VALUES ($1, $2::jsonb, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value), description ?? null]);
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async (req) => {
    need(req, "settings.manage");
    const rows = await q<{ key: string; value: unknown }>(`SELECT key, value FROM app.settings`);
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const rules = parseRuleSettings(rows.filter((r) => r.key.startsWith("rule.")));
    const valueOf = (f: (typeof RULE_FIELDS)[number], s: typeof rules) => {
      const v = s[f.setting] as unknown;
      return Array.isArray(v) ? (f.index != null ? v[f.index] : v.join(",")) : String(v);
    };
    return {
      booking: await bookingSettings(),
      rules: {
        switches: Object.keys(RULE_SWITCHES).map((k) => ({ key: k, label: RULE_SWITCH_LABELS[k] ?? k, on: rules.on[k] }))
          .sort((a, b) => parseFloat(a.label) - parseFloat(b.label) || a.label.localeCompare(b.label)),
        fields: RULE_FIELDS.map((f) => ({ key: f.key, label: f.label, kind: f.kind, value: valueOf(f, rules), defaultValue: valueOf(f, DEFAULT_RULE_SETTINGS) })),
      },
      lists: Object.entries(LISTS).map(([id, l]) => ({ id, label: l.label, items: listItems(m.get(l.key)) })),
      plans: await q(`SELECT name, eye, prep_min AS "prepMin", consult_min AS "consultMin", priority, is_active AS "isActive"
                        FROM app.plan_of_action ORDER BY is_active DESC, priority NULLS LAST, name`),
      // the Google app's reserved slot blocks (HFA, injection, laser, ROP, dilation, emergency...), shown for reference
      reservedSlots: rows.filter((r) => /^general\.(DILATATION|Emergency slot|General Block|HFA Slot|Injection Slot|Laser|ROP Slot|Urgent New|Clinic Working Days|Appointment slots \(minutes\))$/.test(r.key))
        .map((r) => ({ name: r.key.replace(/^general\./, ""), entries: listItems(r.value) })),
    };
  });

  app.put("/api/settings/booking", async (req) => {
    need(req, "settings.manage");
    const b = z.object({ slotMinutes: z.number().int().min(5).max(60), dayStart: timeStr, dayEnd: timeStr }).parse(req.body);
    if (toMin(b.dayEnd) <= toMin(b.dayStart)) throw badRequest("The last slot must end after the first one starts");
    if ((toMin(b.dayEnd) - toMin(b.dayStart)) % b.slotMinutes) throw badRequest(`The day (${b.dayStart}-${b.dayEnd}) must divide into ${b.slotMinutes}-minute slots`);
    const grid = new Set(slotGrid(b));
    const off = await q<{ t: string; n: number }>(
      `SELECT to_char(slot_time,'HH24:MI') AS t, count(*)::int AS n FROM app.appointments
        WHERE appointment_date >= current_date AND slot_time IS NOT NULL AND status IN ('booked','confirmed') GROUP BY 1`);
    const notOnGrid = off.filter((x) => !grid.has(x.t)).reduce((n, x) => n + x.n, 0);
    await withTx(auditCtx(req, `Booking grid set to ${b.slotMinutes}-minute slots from ${b.dayStart} to ${b.dayEnd}`), async (c) => {
      await putSetting(c, "booking.slot_minutes", b.slotMinutes, "Minutes per slot");
      await putSetting(c, "booking.day_start", b.dayStart, "First slot");
      await putSetting(c, "booking.day_end", b.dayEnd, "End of the last slot");
    });
    return { booking: await bookingSettings(),
             warning: notOnGrid ? `${notOnGrid} future bookings are at times that are not on the new grid; they stay where they are` : null };
  });

  app.put("/api/settings/rules", async (req) => {
    need(req, "settings.manage");
    const b = z.object({ switches: z.record(z.boolean()).default({}), values: z.record(z.string().trim()).default({}) }).parse(req.body);
    const changes: [string, string, string][] = [];        // key, name, value
    for (const [k, on] of Object.entries(b.switches)) {
      if (!(k in RULE_SWITCHES)) throw badRequest(`Unknown rule switch ${k}`);
      changes.push([k, RULE_SWITCH_LABELS[k] ?? k, on ? "ON" : "OFF"]);
    }
    for (const [k, raw] of Object.entries(b.values)) {
      const f = RULE_FIELDS.find((x) => x.key === k);
      if (!f) throw badRequest(`Unknown rule setting ${k}`);
      let v = raw.toUpperCase();
      if (f.kind === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw badRequest(`${f.label}: give a time as HH:MM`);
      if (f.kind === "time") v = raw;
      if (f.kind === "number" && !(/^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 600)) throw badRequest(`${f.label}: give a whole number`);
      if (f.kind === "day" && !DAYS.includes(v)) throw badRequest(`${f.label}: one of ${DAYS.join(", ")}`);
      if (f.kind === "days") {
        const ds = v.split(",").map((x) => x.trim()).filter(Boolean);
        if (!ds.length || ds.some((d) => !DAYS.includes(d))) throw badRequest(`${f.label}: days such as TUE,FRI`);
        v = ds.join(",");
      }
      changes.push([k, f.label, v]);
    }
    if (!changes.length) throw badRequest("Nothing to change");
    await withTx(auditCtx(req, `Scheduling rules changed: ${changes.map(([, n, v]) => `${n} = ${v}`).join("; ").slice(0, 300)}`), async (c) => {
      for (const [k, name, v] of changes) await putSetting(c, `rule.${k}`, { name, value: v });
    });
    return { ok: true };
  });

  app.put("/api/settings/lists/:id", async (req) => {
    need(req, "settings.manage");
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const l = LISTS[id];
    if (!l) throw notFound("List");
    const { items } = z.object({ items: z.array(z.string().trim().min(1).max(60)).max(100) }).parse(req.body);
    const clean = [...new Set(items.map((x) => x.replace(/,/g, " ").trim()).filter(Boolean))];
    await withTx(auditCtx(req, `${l.label} list set to: ${clean.join(", ").slice(0, 300)}`), (c) => putSetting(c, l.key, clean));
    return { items: clean };
  });

  const planBody = z.object({
    eye: z.enum(["Yes", "No"]).nullable().optional(),
    prepMin: z.number().int().min(0).max(240).nullable().optional(),
    consultMin: z.number().int().min(0).max(240).nullable().optional(),
    priority: z.number().int().min(0).max(9).nullable().optional(),
    isActive: z.boolean().optional(),
  });
  app.post("/api/plans", async (req) => {
    need(req, "settings.manage");
    const b = planBody.extend({ name: z.string().trim().min(2).max(60) }).parse(req.body);
    if (await one(`SELECT 1 FROM app.plan_of_action WHERE upper(name) = upper($1)`, [b.name])) throw conflict(`"${b.name}" is already in the list`);
    await withTx(auditCtx(req, `Added plan of action "${b.name}"`), (c) => c.query(
      `INSERT INTO app.plan_of_action (name, eye, prep_min, consult_min, priority, is_active) VALUES ($1,$2,$3,$4,$5,$6)`,
      [b.name, b.eye ?? null, b.prepMin ?? null, b.consultMin ?? null, b.priority ?? null, b.isActive ?? true]));
    return { ok: true };
  });
  app.patch("/api/plans/:name", async (req) => {
    need(req, "settings.manage");
    const { name } = z.object({ name: z.string().min(1) }).parse(req.params);
    const b = planBody.parse(req.body);
    const cols: Record<string, string> = { eye: "eye", prepMin: "prep_min", consultMin: "consult_min", priority: "priority", isActive: "is_active" };
    const keys = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) throw badRequest("Nothing to change");
    return withTx(auditCtx(req), async (c) => {
      const cur = (await c.query(`SELECT name FROM app.plan_of_action WHERE name = $1 FOR UPDATE`, [name])).rows[0];
      if (!cur) throw notFound("Plan of action");
      await setAuditSummary(c, `Changed plan of action "${name}"`);
      await c.query(`UPDATE app.plan_of_action SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(", ")} WHERE name = $1`,
                    [name, ...keys.map((k) => (b as any)[k])]);
      return { ok: true };
    });
  });
}
