// The activity log, in plain language (view app.audit_feed). Newest first, paged by id.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { q } from "../db.js";
import { dateStr } from "../lib/time.js";

export async function auditRoutes(app: FastifyInstance) {
  app.get("/api/audit", async (req) => {
    need(req, "audit.read");
    const f = z.object({
      patientId: z.coerce.number().int().optional(),
      entity: z.string().regex(/^[a-z_]+$/).optional(),
      entityId: z.string().max(40).optional(),
      userId: z.coerce.number().int().optional(),
      from: dateStr.optional(), to: dateStr.optional(),
      text: z.string().trim().max(80).optional(),
      before: z.coerce.number().int().optional(),          // id of the last row already shown
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const where: string[] = [], p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replaceAll("?", `$${p.length}`)); };
    if (f.patientId) add("patient_id = ?", f.patientId);
    if (f.entity) add("entity_type = ?", f.entity);
    if (f.entityId) add("entity_id = ?", f.entityId);
    if (f.userId) add("actor_id = ?", f.userId);
    if (f.from) add("at >= ?::date", f.from);
    if (f.to) add("at < ?::date + 1", f.to);
    if (f.text) add("(summary ILIKE '%' || ? || '%' OR details ILIKE '%' || ? || '%' OR patient_name ILIKE '%' || ? || '%' OR mrd ILIKE ? || '%')", f.text);
    if (f.before) add("id < ?", f.before);
    p.push(f.limit);
    const rows = await q(
      `SELECT id, at, when_text AS "when", who, what, summary, details, patient_id AS "patientId", mrd, patient_name AS "patientName",
              entity_type AS "entityType", entity_id AS "entityId", source
         FROM app.audit_feed ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY id DESC LIMIT $${p.length}`, p);
    return { entries: rows, nextBefore: rows.length === f.limit ? (rows[rows.length - 1] as any).id : null };
  });
}
