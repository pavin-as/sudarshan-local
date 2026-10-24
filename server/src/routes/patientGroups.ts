// Patients by group (ROP, injection, laser, ...): the lists behind the cards on the Patients page. Read from
// app.patient_group, which the sync worker rebuilds every night (migration 0017, D-039), so nothing heavy runs in clinic hours.
// Diagnosis lists are clinical data: clinical.read only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { todayIST } from "../lib/time.js";
import { ordinal, titleWords } from "../lib/text.js";
import { drugName } from "../services/summary.js";

export const PATIENT_GROUPS = [
  { key: "rop", label: "ROP", rule: "Seen at an ROP clinic or screening visit. Active = last ROP visit in the last 12 months and no mature retina; Completed = the doctor recorded a mature retina" },
  { key: "injection", label: "Injection", rule: "At least one injection given" },
  { key: "laser", label: "Laser", rule: "At least one laser done" },
  { key: "dr", label: "Diabetic retinopathy", rule: "Latest examination shows diabetic retinopathy or DME" },
  { key: "glaucoma", label: "Glaucoma", rule: "Latest examination shows glaucoma, a glaucoma suspect, cupping or a shallow chamber" },
  { key: "squint", label: "Squint", rule: "Latest examination shows squint or amblyopia, or booked for the squint / amblyopia clinic" },
  { key: "myopia", label: "Myopia", rule: "Latest examination shows a myopic fundus, or booked for the myopia clinic" },
  { key: "lowvision", label: "Low vision", rule: "Best-corrected vision in the better eye worse than 6/18 at the latest visit with a value (both eyes recorded), or booked for low vision" },
  { key: "retina", label: "Other retina", rule: "Latest examination shows vein occlusion, AMD, detachment, vitreous bleed, macular hole / ERM, uveitis, CSCR, hypertensive or myopic retina" },
] as const;
const KEYS = PATIENT_GROUPS.map((g) => g.key) as [string, ...string[]];

export async function patientGroupRoutes(app: FastifyInstance) {
  app.get("/api/patient-groups", async (req) => {
    need(req, "clinical.read");
    const rows = await q<{ group_key: string; n: number }>(`SELECT group_key, count(*)::int AS n FROM app.patient_group GROUP BY group_key`);
    const built = await one<{ at: string | null }>(`SELECT max(built_at) AS at FROM app.patient_group`);
    return { groups: PATIENT_GROUPS.map((g) => ({ ...g, count: rows.find((r) => r.group_key === g.key)?.n ?? 0 })), builtAt: built?.at ?? null };
  });

  app.get("/api/patient-groups/:key", async (req) => {
    const me = need(req, "clinical.read");
    const { key } = z.object({ key: z.enum(KEYS) }).parse(req.params);
    const f = z.object({
      q: z.string().trim().max(60).default(""),
      sort: z.enum(["recent", "name"]).default("recent"),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(5000).default(50),
      print: z.enum(["1"]).optional(),                 // the whole list for printing: logged like the day prints
    }).parse(req.query);
    const where = `g.group_key = $1 AND ($2 = '' OR p.name ILIKE '%' || $2 || '%' OR upper(p.mrd) LIKE '%' || upper($2) || '%')`;
    const total = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM app.patient_group g JOIN clinical.patient p USING (patient_id) WHERE ${where}`, [key, f.q]))?.n ?? 0;
    const rows = await q<any>(
      `SELECT p.patient_id AS "patientId", p.mrd, p.name, p.age_years AS "ageYears", p.age_text AS "ageText", p.sex, p.mobile,
              to_char(g.last_visit,'YYYY-MM-DD') AS "lastVisit", to_char(g.last_event,'YYYY-MM-DD') AS "lastEvent", g.status, g.detail,
              g.bcva_re AS "bcvaRe", g.bcva_le AS "bcvaLe", to_char(g.bcva_date,'YYYY-MM-DD') AS "bcvaDate",
              g.iop_re::float8 AS "iopRe", g.iop_le::float8 AS "iopLe", to_char(g.iop_date,'YYYY-MM-DD') AS "iopDate"
         FROM app.patient_group g JOIN clinical.patient p USING (patient_id)
        WHERE ${where}
        ORDER BY ${f.sort === "name" ? "p.name" : "g.last_event DESC NULLS LAST, p.name"}
        LIMIT $3 OFFSET $4`, [key, f.q, f.limit, f.offset]);
    const patients = rows.map(({ detail, ...r }: any) => {
      const d = detail ?? {};
      let what: string | null = null;
      if (key === "injection") what = [drugName(d.procedure ?? null, d.drug ?? null) ?? "Injection", d.eye, d.n ? ordinal(d.n) : null].filter(Boolean).join(" ");
      if (key === "laser") what = [titleWords(d.what ?? null) ?? "Laser", d.eye].filter(Boolean).join(" ");
      if (key === "retina") what = (d.conditions ?? []).join(", ");
      return { ...r, what, total: d.total ?? null };
    });
    if (f.print) await withTx(auditCtx(req), (c) => c.query(
      `INSERT INTO app.print_log (user_id, kind, for_date, rows, options) VALUES ($1,'patient_list',$2,$3,$4::jsonb)`,
      [me.id, todayIST(), patients.length, JSON.stringify({ group: key, search: f.q || null })]));
    return { patients, total, printedBy: me.fullName };
  });
}
