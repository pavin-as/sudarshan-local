// Doctor summary screen (D-026). The facts are always built fresh from the Yarago mirror; the overview is the latest one
// the local model wrote for that day. A shown overview is logged in app.ai_summary_views (COMPLIANCE: every AI summary
// shown is logged). When the facts changed since the overview was written, it is marked and a new one is queued.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, withTx } from "../db.js";
import { notFound } from "../lib/errors.js";
import { dateStr, todayIST } from "../lib/time.js";
import { enqueue } from "../services/overview.js";
import { buildFacts, factsHash } from "../services/summary.js";

export async function summaryRoutes(app: FastifyInstance) {
  app.get("/api/patients/:id/summary", async (req) => {
    const me = need(req, "clinical.read");
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
    const day = date ?? todayIST();
    const facts = await buildFacts(id, day);
    if (!facts) throw notFound("Patient");
    const hash = factsHash(facts);
    const row = await one<any>(
      `SELECT id, overview, status, error, model, generated_at AS "generatedAt", facts_hash AS "factsHash"
         FROM app.ai_summaries WHERE patient_id = $1 AND for_date = $2 AND kind = 'doctor_summary' AND status <> 'pending'
        ORDER BY generated_at DESC LIMIT 1`, [id, day]);
    const stale = !row || row.factsHash !== hash;
    // a new overview for today's facts; never for past days (they are a record)
    if (stale && day >= todayIST()) enqueue(id, day, row ? "Yarago data changed" : "opened before it was prepared");
    let overview = null;
    if (row?.status === "ready" && row.overview) {
      overview = { id: row.id, text: row.overview, model: row.model, generatedAt: row.generatedAt, stale };
      await withTx(auditCtx(req, `Viewed the doctor summary of ${facts.patient.mrd ?? `patient ${id}`}`), (c) =>
        c.query(`INSERT INTO app.ai_summary_views (summary_id, user_id) VALUES ($1, $2)`, [row.id, me.id]));
    }
    return { facts, overview,
             overviewState: overview ? (stale ? "updating" : "ready") : row?.status === "failed" ? "not_shown" : "preparing",
             note: row?.status === "failed" ? "The overview did not pass the check against the facts, so it is not shown." : null };
  });
}
