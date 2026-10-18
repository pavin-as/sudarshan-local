"""Row counts and a few health numbers for the clinical views (no patient details printed)."""
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
    ("visits with follow-up date", "SELECT count(*) FROM clinical.visit WHERE followup_date IS NOT NULL"),
    ("exam findings", "SELECT count(*) FROM clinical.visit_exam_finding"),
    ("  ...with a decoded name", "SELECT count(*) FROM clinical.visit_exam_finding WHERE finding IS NOT NULL"),
    ("injections given", "SELECT count(*) FROM clinical.injection WHERE given"),
    ("  ...with eye known", "SELECT count(*) FROM clinical.injection WHERE given AND eye IS NOT NULL"),
    ("laser eye-rows", "SELECT count(*) FROM clinical.laser"),
    ("follow-ups", "SELECT count(*) FROM clinical.followup"),
    ("  ...overdue now (no return visit)", "SELECT count(*) FROM clinical.followup WHERE days_overdue > 0"),
    ("patient-flow rows", "SELECT count(*) FROM clinical.patient_flow"),
    ("patients with dues > 0", "SELECT count(*) FROM clinical.patient_due WHERE due_total > 0"),
]
with psycopg.connect(host=c["PG_HOST"], port=int(c["PG_PORT"]), dbname=c["PG_DB"],
                     user=c["PG_APP_USER"], password=c["PG_APP_PASSWORD"]) as conn:
    for label, q in checks:
        try:
            print(f"  {label:40} {conn.execute(q).fetchone()[0]:>10,}")
        except Exception as e:
            conn.rollback()
            print(f"  {label:40} ERROR {e}")
    print("\n  Station names used in patient flow:")
    for r in conn.execute("SELECT station_id, station, count(*), round(avg(minutes) FILTER (WHERE minutes < 240), 1) "
                          "FROM clinical.patient_flow GROUP BY 1, 2 ORDER BY 1"):
        print(f"    {r[0]:>3} {str(r[1]):30} {r[2]:>9,} rows   avg {r[3]} min")
    print("\n  Visit types:")
    for r in conn.execute("SELECT visit_type_id, visit_type, count(*) FROM clinical.visit GROUP BY 1, 2 ORDER BY 3 DESC"):
        print(f"    {r[0]:>3} {str(r[1]):30} {r[2]:>9,}")
    print("\n  Appointment status codes (labels to be confirmed):")
    for r in conn.execute("SELECT status_id, count(*), min(visit_date), max(visit_date) FROM clinical.visit GROUP BY 1 ORDER BY 1"):
        print(f"    {r[0]:>3} {r[1]:>9,} visits   {r[2]} .. {r[3]}")
