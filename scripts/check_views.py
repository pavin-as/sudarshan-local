"""Row counts and health numbers for the clinical views (no patient details printed)."""
from pathlib import Path
import psycopg
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
c = dotenv_values(ROOT / ".env")
checks = [
    ("patients", "SELECT count(*) FROM clinical.patient"),
    ("visits", "SELECT count(*) FROM clinical.visit"),
    ("visits with BCVA", "SELECT count(*) FROM clinical.visit WHERE bcva_re IS NOT NULL OR bcva_le IS NOT NULL"),
    ("visits with IOP", "SELECT count(*) FROM clinical.visit WHERE iop_re IS NOT NULL OR iop_le IS NOT NULL"),
    ("visits with diagnosis", "SELECT count(*) FROM clinical.visit WHERE diagnosis IS NOT NULL"),
    ("exam findings decoded", "SELECT count(*) FROM clinical.visit_exam_finding WHERE finding IS NOT NULL"),
    ("injections given", "SELECT count(*) FROM clinical.injection WHERE given"),
    ("laser eye-rows", "SELECT count(*) FROM clinical.laser"),
    ("visits with a timeline", "SELECT count(*) FROM clinical.visit_timeline"),
]
def q(conn, sql):
    return conn.execute(sql).fetchall()

with psycopg.connect(host=c["PG_HOST"], port=int(c["PG_PORT"]), dbname=c["PG_DB"],
                     user=c["PG_APP_USER"], password=c["PG_APP_PASSWORD"]) as conn:
    for label, sql in checks:
        try:
            print(f"  {label:40} {conn.execute(sql).fetchone()[0]:>10,}")
        except Exception as e:
            conn.rollback(); print(f"  {label:40} ERROR {e}")

    print("\n  Patient time in clinic, last 90 days (median / 90th percentile, minutes):")
    for col, label in [("wait_for_optometry_min", "check-in -> optometry"), ("optometry_min", "optometry"),
                       ("wait_for_doctor_min", "optometry -> doctor"), ("with_doctor_min", "with doctor"),
                       ("total_min", "check-in -> check-out")]:
        r = conn.execute(f"SELECT count({col}), percentile_cont(0.5) WITHIN GROUP (ORDER BY {col}), "
                         f"percentile_cont(0.9) WITHIN GROUP (ORDER BY {col}) FROM clinical.visit_timeline "
                         f"WHERE visit_date >= current_date - 90").fetchone()
        print(f"    {label:26} n={r[0]:>6,}   median {r[1] or 0:6.1f}   p90 {r[2] or 0:6.1f}")

    print("\n  Each patient's latest follow-up, by state:")
    for r in q(conn, "SELECT followup_state, count(*) FROM clinical.followup_current GROUP BY 1 ORDER BY 2 DESC"):
        print(f"    {r[0]:28} {r[1]:>8,}")

    print("\n  Dues - summary table (tbl_patient_payment_mainduedetails), rows with a non-zero value:")
    print("   ", q(conn, """SELECT count(*) FILTER (WHERE dueamttowardspatient <> 0) AS patient,
                                count(*) FILTER (WHERE dueamttowardshospital <> 0) AS hospital,
                                count(*) FILTER (WHERE opddueamt <> 0) AS opd,
                                count(*) FILTER (WHERE pharmacydueamt <> 0) AS pharmacy,
                                count(*) FILTER (WHERE opticaldueamt <> 0) AS optical,
                                count(*) FILTER (WHERE isactive = 1) AS active_rows, count(*) AS all_rows
                         FROM yarago.tbl_patient_payment_mainduedetails"""))
    print("  Dues - per-bill table (tbl_patient_payment_duedetails):")
    print("   ", q(conn, """SELECT count(*) FILTER (WHERE dueamount <> 0) AS nonzero, round(sum(dueamount)::numeric) AS total,
                                count(*) FILTER (WHERE dueamount <> 0 AND isactive = 1) AS nonzero_active,
                                count(DISTINCT npatientid) FILTER (WHERE dueamount > 0) AS patients
                         FROM yarago.tbl_patient_payment_duedetails"""))
    print("  Dues - billing table currentDueAmount (latest bill per patient > 0):")
    print("   ", q(conn, """SELECT count(*) FROM (SELECT DISTINCT ON (npatient_id) currentdueamount
                         FROM yarago.tblpatientsappointmentbillingdetails ORDER BY npatient_id, abilling_id DESC) x
                         WHERE currentdueamount > 0"""))

    print("\n  Appointment status codes vs. what happened (to label them):")
    for r in q(conn, """SELECT v.status_id, count(*),
                               count(*) FILTER (WHERE t.check_in_at IS NOT NULL) AS checked_in,
                               count(*) FILTER (WHERE t.check_out_at IS NOT NULL) AS checked_out,
                               count(*) FILTER (WHERE v.bcva_re IS NOT NULL OR v.diagnosis IS NOT NULL) AS examined,
                               count(*) FILTER (WHERE v.visit_date > current_date) AS future
                        FROM clinical.visit v LEFT JOIN clinical.visit_timeline t ON t.visit_id = v.visit_id
                        GROUP BY 1 ORDER BY 1"""):
        print(f"    status {r[0]}: {r[1]:>7,} visits | checked in {r[2]:>7,} | checked out {r[3]:>7,} | examined {r[4]:>7,} | future {r[5]:>5,}")
