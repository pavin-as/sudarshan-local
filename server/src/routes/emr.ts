// EMR completeness per month (Phase B, D-028): the share of consultations with each item recorded in Yarago, from
// analytics.emr_completeness (rebuilt nightly). Counts only; for the clinical team's SOP review.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { one, q } from "../db.js";

export async function emrRoutes(app: FastifyInstance) {
  app.get("/api/emr-completeness", async (req) => {
    need(req, "clinical.read");
    const f = z.object({ group: z.enum(["all", "new", "review"]).default("all"),
                         months: z.coerce.number().int().min(3).max(13).default(6) }).parse(req.query);
    const months = (await q<{ m: string }>(
      `SELECT to_char(m, 'YYYY-MM-DD') AS m FROM generate_series(date_trunc('month', current_date) - make_interval(months => $1 - 1),
                                                                  date_trunc('month', current_date), interval '1 month') m`, [f.months])).map((r) => r.m);
    const rows = await q<any>(
      `SELECT to_char(month,'YYYY-MM-DD') AS month, screen, item, label, position, recorded, total
         FROM analytics.emr_completeness
        WHERE visit_group = CASE WHEN screen = 'injection' THEN 'injection' ELSE $1 END
          AND month >= date_trunc('month', current_date) - interval '12 months'
        ORDER BY position, month`, [f.group]);
    const targets = (await one<{ value: Record<string, number> }>(`SELECT value FROM app.settings WHERE key = 'emr.targets'`))?.value ?? {};
    const byItem = new Map<string, any>();
    for (const r of rows) {
      const it = byItem.get(r.item) ?? { item: r.item, label: r.label, screen: r.screen, position: r.position, target: targets[r.item] ?? null,
                                         cells: {} as Record<string, unknown>, recorded12: 0, total12: 0 };
      it.cells[r.month] = { pct: r.total ? Math.round((100 * r.recorded) / r.total) : null, recorded: r.recorded, total: r.total };
      it.recorded12 += r.recorded; it.total12 += r.total;
      byItem.set(r.item, it);
    }
    const items = [...byItem.values()].sort((a, b) => a.position - b.position).map(({ recorded12, total12, cells, ...it }) => ({
      ...it, cells: months.map((m) => ({ month: m, ...(cells[m] ?? { pct: null, recorded: 0, total: 0 }) })),
      pct12: total12 ? Math.round((100 * recorded12) / total12) : null }));
    const updated = await one<{ at: string }>(`SELECT max(finished_at) AS at FROM analytics.refresh_log WHERE status = 'ok'`);
    return { months, items, group: f.group, updatedAt: updated?.at ?? null };
  });
}
