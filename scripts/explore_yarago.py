"""
Explore the Yarago mirror to design the clinical views. Exports NO patient identifiers or free text:
  - lookup/master tables in full (tables named *mst*/*master*, doctors, user types), minus password/phone/email columns
  - for key clinical tables: per-column statistics; text columns only as length + "shape" patterns (letters->a, digits->9)
  - distinct code values of *id columns (only when they have <= 2000 distinct values)
Output: D:\\Sudarshan\\explore\\yarago_explore.json  (outside the git repo)
Run:    python scripts\\explore_yarago.py
"""
import json, re, datetime as dt, decimal
from collections import Counter
from pathlib import Path
import psycopg
from psycopg import sql
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
c = dotenv_values(ROOT / ".env")
OUT = Path(r"D:\Sudarshan\explore"); OUT.mkdir(parents=True, exist_ok=True)

KEY_TABLES = [
    "tbl_patient_appointment_history", "tbl_opto_patient_appointment_history", "tblappointments",
    "tbloptometryexamination", "tbl_opto_optometryexamination", "tblbcva_values", "tbl_opto_bcva_values",
    "tblucva", "tblvisionsubtable", "tbldiagnosis", "tblfinaldiagnosis", "tbldiagnosis_history",
    "tbleyeparts_examination_details_for_patient", "tbladvice", "tblcomplaints", "tblnewprescription",
    "tblsysillness", "tbldrugallergy", "tblophthalmic_history_details_for_examination",
    "tblpatientinjectionopdinvestigationdetials", "tblpatientlaseropdinvestigationdetials", "tblpatientissurgery",
    "tbltimerpatientwaiting", "tbldilatationpatientslist", "tblfollowuppatientdetails",
    "tblpatient_followup_smsdetails", "tblpatientregistration", "tbl_examination_remarks",
    "tbllinkpatientcurrentappointment", "tblpatientsappointmentbillingdetails",
]
SECRET = re.compile(r"pass|pwd|otp|token|secret|phone|mobile|email|aadhar|aadhaar|address|signature", re.I)
IDENTIFYING = re.compile(r"name|mobile|phone|address|aadhar|aadhaar|email|dob|photo|finger|barcode|spouse|record_number|patientcode|ident", re.I)

def shape(v):
    s = re.sub(r"[A-Za-z]+", "a", v)
    s = re.sub(r"\d+", "9", s)
    return s[:40]

def jdefault(o):
    if isinstance(o, (dt.date, dt.datetime, dt.time, dt.timedelta)): return str(o)
    if isinstance(o, decimal.Decimal): return float(o)
    if isinstance(o, (bytes, bytearray, memoryview)): return f"<{len(o)} bytes>"
    return str(o)

out = {"generated": str(dt.datetime.now()), "masters": {}, "tables": {}}
with psycopg.connect(host=c["PG_HOST"], port=int(c["PG_PORT"]), dbname=c["PG_DB"],
                     user=c["PG_APP_USER"], password=c["PG_APP_PASSWORD"]) as conn:
    cur = conn.cursor()
    cur.execute("""SELECT table_name, column_name, data_type FROM information_schema.columns
                   WHERE table_schema='yarago' ORDER BY table_name, ordinal_position""")
    cols = {}
    for t, col, typ in cur.fetchall():
        cols.setdefault(t, []).append((col, typ))
    cur.execute("SELECT table_name, last_row_count FROM yarago.sync_state")

    # 1. master / lookup tables
    masters = [t for t in cols if re.search(r"mst|master", t) or t in ("tbldoctor", "tblusertype", "tbl_doctor_timings")]
    for t in sorted(masters):
        keep = [col for col, _ in cols[t] if not SECRET.search(col)]
        if not keep:
            continue
        cur.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("yarago", t)))
        n = cur.fetchone()[0]
        if n == 0 or n > 5000:
            out["masters"][t] = {"rows": n, "columns": keep, "data": None if n else []}
            continue
        cur.execute(sql.SQL("SELECT {} FROM {}").format(sql.SQL(", ").join(sql.Identifier(k) for k in keep),
                                                        sql.Identifier("yarago", t)))
        out["masters"][t] = {"rows": n, "columns": keep, "data": cur.fetchall()}
    print(f"masters: {len(out['masters'])} tables")

    # 2. key clinical tables: statistics only
    for t in KEY_TABLES:
        if t not in cols:
            continue
        cur.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier("yarago", t)))
        n = cur.fetchone()[0]
        info = {"rows": n, "columns": {}}
        for col, typ in cols[t]:
            ci = sql.Identifier(col); ti = sql.Identifier("yarago", t)
            cur.execute(sql.SQL("SELECT count(*) FILTER (WHERE {c} IS NULL), count(DISTINCT {c}) FROM {t}").format(c=ci, t=ti))
            nulls, distinct = cur.fetchone()
            d = {"type": typ, "null_pct": round(100 * nulls / n, 1) if n else None, "distinct": distinct}
            if typ in ("integer", "bigint", "smallint", "numeric", "double precision", "date", "timestamp without time zone"):
                cur.execute(sql.SQL("SELECT min({c}), max({c}) FROM {t}").format(c=ci, t=ti))
                d["min"], d["max"] = cur.fetchone()
                if typ in ("integer", "bigint", "smallint") and distinct <= 2000 and re.search(r"id$|type|status|mode|flag|^is|eye", col, re.I):
                    cur.execute(sql.SQL("SELECT {c}, count(*) FROM {t} GROUP BY 1 ORDER BY 2 DESC").format(c=ci, t=ti))
                    d["values"] = cur.fetchall()
            elif typ == "text" and not IDENTIFYING.search(col):
                cur.execute(sql.SQL("SELECT {c} FROM {t} WHERE {c} IS NOT NULL AND {c} <> '' ORDER BY random() LIMIT 3000").format(c=ci, t=ti))
                vals = [r[0] for r in cur.fetchall()]
                d["nonempty_sample"] = len(vals)
                d["avg_len"] = round(sum(map(len, vals)) / len(vals), 1) if vals else 0
                d["shapes"] = Counter(shape(v) for v in vals).most_common(8)
                # short coded values (<= 4 chars, e.g. RE/LE/Y/N) are safe to show
                short = Counter(v for v in vals if len(v) <= 4)
                if short and sum(short.values()) > 0.8 * len(vals):
                    d["short_values"] = short.most_common(15)
            info["columns"][col] = d
        out["tables"][t] = info
        print(f"  {t}: {n} rows, {len(info['columns'])} columns")

p = OUT / "yarago_explore.json"
p.write_text(json.dumps(out, default=jdefault, indent=1), encoding="utf-8")
print("written", p, f"{p.stat().st_size // 1024} KB")
