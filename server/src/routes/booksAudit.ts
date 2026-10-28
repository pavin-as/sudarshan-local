// The Books audit (D-054): how well Zoho Books is kept, and Basith's printed Friday sheet. Read only towards Zoho; the
// only writes are the admin's settings (audited) and the read-only Zoho copy.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { withTx } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { dateStr, niceDate, todayIST } from "../lib/time.js";
import { auditSettings, auditTrend, loadAudit, saveAuditSnapshot } from "../services/booksAuditData.js";
import { rupees } from "../services/reconcile.js";
import { ZohoError } from "../services/zohoBooks.js";
import { fetchZoho, zohoStatus } from "../services/zohoSync.js";

export async function booksAuditRoutes(app: FastifyInstance) {
  app.get("/api/books-audit", async (req) => {
    need(req, "books.audit");
    const [audit, trend, zs] = await Promise.all([loadAudit(), auditTrend(), zohoStatus()]);
    return { audit, trend, zohoStatus: zs };
  });

  /** Read Zoho again from the audit's start (bank lines, invoices, expenses), then save today's score. */
  app.post("/api/books-audit/fetch", async (req) => {
    const me = need(req, "books.audit");
    const { from } = await auditSettings();
    try {
      const r = await fetchZoho(from, todayIST(), me.id);
      if (r.status === "ok") await saveAuditSnapshot();
      return r;
    } catch (e) {
      if (e instanceof ZohoError) throw badRequest(e.message);
      throw e;
    }
  });

  app.put("/api/books-audit/settings", async (req) => {
    need(req, "adjustments.approve");
    const money = z.number().min(0).max(1_000_000);
    const b = z.object({
      from: dateStr, qualityFrom: dateStr, dueDays: z.number().int().min(1).max(31), bankBehindDays: z.number().int().min(0).max(31),
      invoiceTolerance: money, receiptAbove: money, vendorAbove: money,
      patientsCustomer: z.string().trim().min(1, "Name the Zoho customer of the daily invoice").max(100),
      vagueAccounts: z.array(z.string().trim().min(1).max(100)).max(30),
    }).parse(req.body);
    if (b.from > todayIST() || b.qualityFrom > todayIST()) throw badRequest("The audit cannot start in the future");
    await withTx(auditCtx(req, `Books audit settings: checked from ${niceDate(b.from)} (expense rules from ${niceDate(b.qualityFrom)}), due after ${b.dueDays} days, bank at most ${b.bankBehindDays} days behind, invoice within ${rupees(b.invoiceTolerance)}, receipt from ${rupees(b.receiptAbove)}, vendor from ${rupees(b.vendorAbove)}, daily invoice customer "${b.patientsCustomer}"`), (c) =>
      c.query(`INSERT INTO app.settings (key, value) VALUES ('books.audit', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(b)]));
    return { settings: await auditSettings() };
  });
}
