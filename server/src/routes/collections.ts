// Day collection (D-057): a day's money as Yarago recorded it, for finance only (it shows the day's cash, which the cash
// desk must not see: its deposits are blind, D-053). No bank and no matching; every figure from services/collections.ts.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { need } from "../auth.js";
import { q } from "../db.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { dateStr, nowHHMMIST, todayIST } from "../lib/time.js";
import { loadBill, loadDay } from "../services/collectionsData.js";
import { CATEGORY_WORDS, METHOD_WORDS } from "../services/reconcile.js";

export async function collectionRoutes(app: FastifyInstance) {
  app.get("/api/collections/day", async (req) => {
    need(req, "reconciliation.read");
    const today = todayIST();
    const { date } = z.object({ date: dateStr.optional() }).parse(req.query);
    const d = date ?? today;
    if (d > today) throw badRequest("That day has not come yet");
    const [summary, last] = await Promise.all([loadDay(d, today, nowHHMMIST()),
                                               q<{ at: string | null }>(`SELECT max(finished_at)::text AS at FROM app.sync_runs WHERE status = 'ok'`)]);
    return { summary, today, yaragoSyncedAt: last[0]?.at ?? null, words: { methods: METHOD_WORDS, categories: CATEGORY_WORDS } };
  });

  app.get("/api/collections/bill", async (req) => {
    need(req, "reconciliation.read");
    const { source, key } = z.object({ source: z.enum(["clinic", "pharmacy"]), key: z.string().regex(/^\d{1,12}$/, "Not a bill") }).parse(req.query);
    const bill = await loadBill(source, key);
    if (!bill) throw new HttpError(404, "not_found", "That bill is not in Sudarshan's copy of Yarago");
    return { bill };
  });
}
