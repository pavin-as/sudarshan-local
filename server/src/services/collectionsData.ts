// Database side of the Day collection (D-057): one day's records from the Yarago money views (db/views/40_money.sql),
// with patient MRD and name, for daySummary(); and everything on one bill or pharmacy order. Reads only.
import { one, q } from "../db.js";
import { addDays } from "../lib/time.js";
import { daySummary, type DayBill, type DayLine, type DayPayment, type DayRefund } from "./collections.js";
import { reconSettings } from "./reconData.js";

const PAT = `LEFT JOIN clinical.patient cp ON cp.patient_id = x.patient_id`;
const WHO = `cp.mrd, cp.name`;
const AT = (col: string) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI')`;

/** The day's summary. For today, last week's figure is up to the same time of day, so the two compare. */
export async function loadDay(date: string, today: string, nowHHMM: string) {
  const isToday = date === today;
  const weekAgo = addDays(date, -7);
  const [lines, payments, refunds, bills, settings, last] = await Promise.all([
    q<DayLine>(`SELECT x.line_id AS "lineId", x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.on_date AS "onDate", x.patient_id AS "patientId",
                       x.service_group AS "serviceGroup", x.item, x.amount::float AS amount, ${WHO}
                  FROM clinical.money_revenue_line x ${PAT} WHERE x.on_date = $1`, [date]),
    q<DayPayment>(`SELECT x.payment_id AS "paymentId", x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.on_date AS "onDate", x.patient_id AS "patientId",
                          x.method, x.amount::float AS amount, x.ref, ${AT("x.at")} AS at, x.bill_key AS "billKey", ${WHO}
                     FROM clinical.money_payment x ${PAT} WHERE x.on_date = $1`, [date]),
    q<DayRefund>(`SELECT x.refund_id AS "refundId", x.source, x.source_id AS "sourceId", x.bill_no AS "billNo", x.on_date AS "onDate", x.patient_id AS "patientId",
                         x.method, x.amount::float AS amount, x.date_uncertain AS "dateUncertain", x.reason, ${AT("x.at")} AS at, ${WHO}
                    FROM clinical.money_refund x ${PAT} WHERE x.on_date = $1`, [date]),
    q<DayBill>(`SELECT x.bill_id::text AS "billKey", x.bill_no AS "billNo", x.patient_id AS "patientId", ${AT("x.billed_at")} AS at,
                       x.total::float AS total, x.discount::float AS discount, x.due_after::float AS due, ${WHO}
                  FROM clinical.money_bill x ${PAT} WHERE x.on_date = $1`, [date]),
    reconSettings(),
    one<{ collected: number }>(`SELECT coalesce(sum(amount), 0)::float AS collected FROM clinical.money_payment
                                 WHERE on_date = $1 AND ($2::text IS NULL OR to_char(at, 'HH24:MI') <= $2)`, [weekAgo, isToday ? nowHHMM : null]),
  ]);
  return daySummary({ date, lines, payments, refunds, bills, categoryMap: settings.categoryMap,
                      lastWeek: { date: weekAgo, collected: Number(last?.collected ?? 0), byThisTime: isToday } });
}

/** Everything on one clinic bill (key = bill id) or pharmacy order (key = order id): its lines, every payment and refund. */
export async function loadBill(source: "clinic" | "pharmacy", key: string) {
  if (source === "clinic") {
    const [bill, lines, payments, refunds] = await Promise.all([
      one(`SELECT x.bill_id::text AS key, x.bill_no AS "billNo", x.on_date AS "onDate", ${AT("x.billed_at")} AS at, x.patient_id AS "patientId", ${WHO},
                  x.total::float AS total, x.discount::float AS discount, x.due_after::float AS due
             FROM clinical.money_bill x ${PAT} WHERE x.bill_id::text = $1`, [key]),
      q(`SELECT service_group AS "group", item, amount::float AS amount, NULL::int AS qty FROM clinical.money_revenue_line
          WHERE source = 'clinic_bill' AND source_id = $1 ORDER BY service_group, item`, [key]),
      q(`SELECT payment_id AS id, on_date AS "onDate", ${AT("at")} AS at, method, amount::float AS amount, ref FROM clinical.money_payment
          WHERE source = 'clinic_bill' AND bill_key = $1 ORDER BY at, method`, [key]),
      q(`SELECT refund_id AS id, on_date AS "onDate", ${AT("at")} AS at, method, amount::float AS amount, reason FROM clinical.money_refund
          WHERE source = 'opd_refund' AND bill_id = $1 ORDER BY at`, [key]),
    ]);
    return bill ? { source, ...bill, lines, payments, refunds } : null;
  }
  // pharmacy and optical: the order's lines with the product's name (Yarago's product list), after cancellations
  const [order, lines, payments] = await Promise.all([
    one(`SELECT o.orderid::text AS key, o.billno::text AS "billNo", o.inserteddate::date AS "onDate", ${AT("o.inserteddate")} AS at,
                o.npatid AS "patientId", cp.mrd, cp.name
           FROM yarago.tblopticalpatientorders o LEFT JOIN clinical.patient cp ON cp.patient_id = o.npatid WHERE o.orderid::text = $1`, [key]),
    q(`SELECT CASE WHEN d.ncategoryid IN (3, 5, 6, 7, 8) THEN 'Pharmacy' ELSE 'Optical' END AS "group",
              coalesce(nullif(btrim(pr.aproductname), ''), c.acategoryname, 'Not named') AS item, c.acategoryname AS kind,
              (coalesce(d.totamount, 0) - coalesce(d.cancelledamt, 0))::float AS amount, (coalesce(d.nqty, 0) - coalesce(d.cancelledqty, 0)) AS qty
         FROM yarago.tblopticalpatientorderdetails d
         LEFT JOIN yarago.tbl_mst_category c ON c.acatid = d.ncategoryid
         LEFT JOIN yarago.tbl_mst_product pr ON pr.aprodid = d.nproductid
        WHERE d.orderid::text = $1 AND coalesce(d.isactive, 1) = 1 ORDER BY 1, 3, 2`, [key]),
    q(`SELECT payment_id AS id, source_id AS "payId", on_date AS "onDate", ${AT("at")} AS at, method, amount::float AS amount, ref FROM clinical.money_payment
        WHERE source = 'pharmacy_payment' AND bill_key = $1 ORDER BY at, method`, [key]),
  ]);
  if (!order) return null;
  const payIds = [...new Set(payments.map((p: any) => p.payId))];
  const refunds = payIds.length ? await q(`SELECT refund_id AS id, on_date AS "onDate", ${AT("at")} AS at, method, amount::float AS amount, reason
                                             FROM clinical.money_refund WHERE source = 'pharmacy_refund' AND source_id = ANY($1)`, [payIds]) : [];
  const total = lines.reduce((s: number, l: any) => s + Number(l.amount), 0);
  return { source, ...order, total: Math.round(total * 100) / 100, discount: 0, due: null, lines, payments, refunds };
}
