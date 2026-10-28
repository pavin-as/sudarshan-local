"""
Yarago (MySQL 5.6) -> PostgreSQL mirror for Sudarshan.

  python sync/yarago_sync.py full [--force]   full copy of every Yarago table into yarago_staging, then into yarago
  python sync/yarago_sync.py incremental      one cycle: new/changed rows of the hot tables + child rows of changed visits
  python sync/yarago_sync.py service          runs forever: incremental every 150 s, full copy nightly at 01:00,
                                              analytics rebuild nightly at 02:30 (after the 02:00 backup)
  python sync/yarago_sync.py analytics        rebuild the analytics schema now (analytics.refresh())
  python sync/yarago_sync.py verify [--all]   compare row counts Yarago vs mirror (hot tables, or all tables)
  python sync/yarago_sync.py status           show what was last synced

Rules: reads Yarago only as sudarshan_ro; a full copy refuses to start between 07:00 and 21:00 unless --force.
Logs: logs/yarago_sync.log (rotating). Every run is recorded in app.sync_runs.
"""
import argparse
import datetime as dt
import hashlib
import logging
import re
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import psycopg
import pymysql
import pymysql.cursors
from dotenv import dotenv_values
from psycopg import sql

ROOT = Path(__file__).resolve().parent.parent
CFG = dotenv_values(ROOT / ".env")
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)

MIRROR, STAGING = "yarago", "yarago_staging"
BATCH = 5000
INCREMENTAL_EVERY_S = 150
OVERLAP = dt.timedelta(minutes=10)          # re-read rows modified shortly before the last checkpoint
CLINIC_HOURS = (7, 21)                      # full copy blocked between these hours unless --force
SMALL_TABLE_ROWS = 50_000                   # hot tables with no change column are re-copied whole if below this

# Hot tables refreshed every cycle (changes detected by id and/or modified date).
HOT_TABLES = [
    "tblpatientregistration", "tbllinkpatientcurrentappointment", "tblprofiledetails",
    "tblappointments", "tbl_patient_appointment_history", "tbl_opto_patient_appointment_history",
    "tbldiagnosis", "tbldiagnosis_history", "tbloptometryexamination", "tbl_opto_optometryexamination",
    "tblvisionsubtable",
    "tblpatientinjectionopdinvestigationdetials", "tblpatientlaseropdinvestigationdetials", "tblpatientissurgery",
    "tblfollowuppatientdetails", "tblpatient_followup_smsdetails",
    "tbltimerpatientwaiting", "tbldilatationpatientslist",
    "tblpatientsappointmentbillingdetails", "tbl_patient_payment_duedetails", "tbl_payment_receptionist_new",
    "tblopticalpatientpayment", "tbl_payment_injectionorlaser_procedure_for_billing",
    # pharmacy and optical orders and their lines (D-056): with the payments above, so the day's pharmacy sales and
    # payments reach the reconciliation together (they were nightly, so a payment waited a day for its order)
    "tblopticalpatientorders", "tblopticalpatientorderdetails",
    # pharmacy purchases and what is paid to wholesalers (D-033): small tables, so the balance is minutes old, not a day
    "tblopticalpharmacypurchase", "tblopticalpharmacypurchasedetails", "tblpurchasepaymentdetails",
]
# Visit tables whose changes trigger a re-copy of that visit's child rows.
VISIT_TABLES = ["tblappointments", "tbl_patient_appointment_history", "tbl_opto_patient_appointment_history"]

RE_MOD = re.compile(r"modif|updated", re.I)
RE_APPT = re.compile(r"^(n|t|a)?_?app(o|t|m)?[a-z]*_?id$", re.I)
RE_PAT = re.compile(r"^(n|a)?_?pat(ient)?_?id$", re.I)
DATE_TYPES = {"date", "datetime", "timestamp"}
TEXT_TYPES = {"char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"}
BIN_TYPES = {"binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"}

log = logging.getLogger("yarago_sync")
RE_HIGH = re.compile("[\u0080-\u00ff]")


def fix_mojibake(s):
    """Yarago keeps UTF-8 text (e.g. Malayalam) in latin1 columns; read as utf8mb4 it arrives garbled.
    Turn the characters back into the original bytes and decode them as UTF-8. Real Latin-1 text
    (e.g. 'café') is not valid UTF-8 as bytes, so it is left unchanged."""
    if not RE_HIGH.search(s):
        return s
    try:
        b = bytearray()
        for ch in s:
            o = ord(ch)
            b.extend((o,) if o < 256 else ch.encode("cp1252"))
        return b.decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s
UNRELIABLE_MOD = set()   # tables whose modified column matched most of the table; use id only (nightly copy covers edits)
TODAY_SKIPPED = set()    # visit tables today's re-read cannot use (no key or no index on the visit column); logged once


def setup_logging():
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = RotatingFileHandler(LOG_DIR / "yarago_sync.log", maxBytes=5_000_000, backupCount=10, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(fh)
    log.addHandler(sh)


# ------------------------------------------------------------------ connections
def my_conn(stream=False):
    return pymysql.connect(
        host=CFG["YARAGO_HOST"], port=int(CFG["YARAGO_PORT"]), user=CFG["YARAGO_RO_USER"],
        password=CFG["YARAGO_RO_PASSWORD"], database=CFG["YARAGO_DB"], charset="utf8mb4",
        cursorclass=pymysql.cursors.SSCursor if stream else pymysql.cursors.Cursor,
        read_timeout=600, connect_timeout=15)


def pg_conn():
    return psycopg.connect(host=CFG["PG_HOST"], port=int(CFG["PG_PORT"]), dbname=CFG["PG_DB"],
                           user=CFG["PG_APP_USER"], password=CFG["PG_APP_PASSWORD"])


def q(name):  # MySQL identifier
    return "`" + name.replace("`", "``") + "`"


# ------------------------------------------------------------------ schema
class Table:
    def __init__(self, name, cols, approx_rows, indexed=()):
        self.name = name                    # MySQL name (original case)
        self.pg = name.lower()              # PostgreSQL name
        self.cols = cols                    # list of dicts
        self.approx_rows = approx_rows or 0
        self.indexed = set(indexed)         # columns that lead an index in Yarago
        names = [c["name"] for c in cols]
        auto = [c["name"] for c in cols if c["key"] == "PRI" and "auto_increment" in c["extra"]]
        pri = [c["name"] for c in cols if c["key"] == "PRI"]
        self.key = auto[:1] if auto else pri            # key used for upserts in the mirror
        ints = {"tinyint", "smallint", "mediumint", "int", "bigint"}
        self.idcol = auto[0] if auto else (pri[0] if len(pri) == 1 and self.col(pri[0])["dt"] in ints else None)
        mods = [c["name"] for c in cols if RE_MOD.search(c["name"]) and c["dt"] in DATE_TYPES]
        self.modcol = mods[0] if mods else None
        appts = [n for n in names if RE_APPT.match(n)]
        self.apptcol = appts[0] if appts else None
        pats = [n for n in names if RE_PAT.match(n)]
        self.patcol = pats[0] if pats else None
        self.hash = hashlib.sha1("|".join(f'{c["name"]}:{c["ct"]}' for c in cols).encode()).hexdigest()

    def col(self, n):
        return next(c for c in self.cols if c["name"] == n)

    @property
    def names(self):
        return [c["name"] for c in self.cols]

    @property
    def pg_names(self):
        return [c["name"].lower() for c in self.cols]


def load_schema(mc, only=None):
    cur = mc.cursor()
    cur.execute("SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA=%s AND TABLE_TYPE='BASE TABLE'", (CFG["YARAGO_DB"],))
    rows = {r[0]: r[1] for r in cur.fetchall()}
    cur.execute("SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, COLUMN_KEY, EXTRA, "
                "NUMERIC_PRECISION, NUMERIC_SCALE FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME, ORDINAL_POSITION", (CFG["YARAGO_DB"],))
    cols = {}
    for t, n, dtp, ct, k, x, p, s in cur.fetchall():
        cols.setdefault(t, []).append({"name": n, "dt": dtp.lower(), "ct": ct.lower(), "key": k, "extra": x or "",
                                       "p": p, "s": s})
    cur.execute("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS "
                "WHERE TABLE_SCHEMA=%s AND SEQ_IN_INDEX=1", (CFG["YARAGO_DB"],))
    idx = {}
    for t, n in cur.fetchall():
        idx.setdefault(t, set()).add(n)
    want = set(only) if only else None
    return {t: Table(t, cols[t], rows[t], idx.get(t, ())) for t in sorted(rows)
            if t in cols and (want is None or t in want)}


def pg_type(c):
    d, ct, uns = c["dt"], c["ct"], "unsigned" in c["ct"]
    if d == "tinyint":
        return "smallint"
    if d == "smallint":
        return "integer"
    if d in ("mediumint", "int"):
        return "bigint" if uns else "integer"
    if d == "bigint":
        return "numeric(20)" if uns else "bigint"
    if d == "decimal":
        return f'numeric({c["p"]},{c["s"]})' if c["p"] else "numeric"
    if d in ("float", "double", "real"):
        return "double precision"
    if d == "date":
        return "date"
    if d in ("datetime", "timestamp"):
        return "timestamp"
    if d == "year":
        return "integer"
    if d == "bit":
        return "bigint"
    if d in BIN_TYPES:
        return "bytea"
    return "text"  # char, varchar, *text, enum, set, time, anything else


def make_converter(table):
    """Returns a function that cleans one MySQL row for PostgreSQL."""
    fns = []
    for i, c in enumerate(table.cols):
        d = c["dt"]
        if d in DATE_TYPES:
            fns.append((i, lambda v: None if isinstance(v, (str, bytes)) else v))   # 0000-00-00 and other invalid dates
        elif d == "time":
            fns.append((i, lambda v: None if v is None else str(v)))
        elif d == "bit":
            fns.append((i, lambda v: int.from_bytes(v, "big") if isinstance(v, (bytes, bytearray)) else v))
        elif d in BIN_TYPES:
            fns.append((i, lambda v: v.encode() if isinstance(v, str) else v))
        elif pg_type(c) == "text":
            def clean(v):
                if isinstance(v, (bytes, bytearray)):
                    v = bytes(v).decode("utf-8", "replace")
                elif v is not None and not isinstance(v, str):
                    v = str(v)
                return fix_mojibake(v.replace("\x00", "")) if v else v
            fns.append((i, clean))
    if not fns:
        return lambda r: r

    def conv(r):
        r = list(r)
        for i, f in fns:
            if r[i] is not None:
                r[i] = f(r[i])
        return r
    return conv


def ident(schema, name):
    return sql.Identifier(schema, name)


def create_table(pc, schema, t):
    cols = sql.SQL(", ").join(sql.SQL("{} {}").format(sql.Identifier(c["name"].lower()), sql.SQL(pg_type(c)))
                              for c in t.cols)
    pc.execute(sql.SQL("CREATE TABLE {} ({})").format(ident(schema, t.pg), cols))


def add_keys_and_indexes(pc, schema, t):
    if t.key:
        try:
            pc.execute(sql.SQL("ALTER TABLE {} ADD PRIMARY KEY ({})").format(
                ident(schema, t.pg), sql.SQL(", ").join(sql.Identifier(k.lower()) for k in t.key)))
        except psycopg.errors.UniqueViolation:
            pc.connection.rollback()
            log.warning("%s: key %s not unique in data, no primary key added", t.name, t.key)
            return
    for colname in {t.apptcol, t.patcol} - {None}:
        if t.key and colname in t.key:
            continue
        pc.execute(sql.SQL("CREATE INDEX ON {} ({})").format(ident(schema, t.pg), sql.Identifier(colname.lower())))


def copy_rows(pc, schema, t, rows_iter):
    conv = make_converter(t)
    n = 0
    stmt = sql.SQL("COPY {} ({}) FROM STDIN").format(
        ident(schema, t.pg), sql.SQL(", ").join(sql.Identifier(c) for c in t.pg_names))
    with pc.copy(stmt) as cp:
        for r in rows_iter:
            cp.write_row(conv(r))
            n += 1
    return n


def stream(mcur, query, params=None):
    mcur.execute(query, params)
    while True:
        rows = mcur.fetchmany(BATCH)
        if not rows:
            break
        yield from rows


def mirror_max(pc, schema, t):
    idv = modv = None
    if t.idcol:
        pc.execute(sql.SQL("SELECT max({}) FROM {}").format(sql.Identifier(t.idcol.lower()), ident(schema, t.pg)))
        idv = pc.fetchone()[0]
    if t.modcol:
        pc.execute(sql.SQL("SELECT max({}) FROM {} WHERE {} <= now() + interval '1 day'").format(
            sql.Identifier(t.modcol.lower()), ident(schema, t.pg), sql.Identifier(t.modcol.lower())))
        modv = pc.fetchone()[0]
        if isinstance(modv, dt.date) and not isinstance(modv, dt.datetime):
            modv = dt.datetime.combine(modv, dt.time())
    return idv, modv


def save_state(pc, t, last_id, last_mod, rows, status):
    pc.execute("""
        INSERT INTO yarago.sync_state (table_name, last_id, last_modified, last_run_at, last_row_count, last_status, columns_hash)
        VALUES (%s, %s, %s, now(), %s, %s, %s)
        ON CONFLICT (table_name) DO UPDATE SET
          last_id = COALESCE(EXCLUDED.last_id, yarago.sync_state.last_id),
          last_modified = COALESCE(EXCLUDED.last_modified, yarago.sync_state.last_modified),
          last_run_at = now(), last_row_count = EXCLUDED.last_row_count,
          last_status = EXCLUDED.last_status, columns_hash = EXCLUDED.columns_hash""",
               (t.pg, last_id, last_mod, rows, status, t.hash))


def run_start(pc, mode):
    pc.execute("INSERT INTO app.sync_runs (mode) VALUES (%s) RETURNING id", (mode,))
    rid = pc.fetchone()[0]
    pc.connection.commit()
    return rid


def run_end(pc, rid, status, tables, rows, msg=None):
    pc.execute("UPDATE app.sync_runs SET finished_at=now(), status=%s, tables_done=%s, rows_copied=%s, message=%s "
               "WHERE id=%s", (status, tables, rows, msg, rid))
    pc.connection.commit()


# ------------------------------------------------------------------ full copy
def full(force=False):
    h = dt.datetime.now().hour
    if CLINIC_HOURS[0] <= h < CLINIC_HOURS[1] and not force:
        log.error("Full copy blocked during clinic hours (%02d:00-%02d:00). Use --force to override.", *CLINIC_HOURS)
        return 2
    t0 = time.time()
    meta = my_conn()
    tables = load_schema(meta)
    meta.close()
    log.info("FULL copy started: %d Yarago tables", len(tables))
    kids = [t for t in tables.values() if not t.modcol and t.apptcol and t.approx_rows > 1000]
    slow = [t.name for t in kids if t.apptcol not in t.indexed]
    if slow:
        log.info("child tables without an index on their visit column (refreshed by new id + nightly only): %s",
                 ", ".join(slow))
    pg = pg_conn()
    pc = pg.cursor()
    rid = run_start(pc, "full")
    pc.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(STAGING)))
    pc.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(STAGING)))
    pg.commit()

    my = my_conn(stream=True)
    mcur = my.cursor()
    mcur.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
    total, warnings = 0, []
    for i, t in enumerate(tables.values(), 1):
        ts = time.time()
        try:
            create_table(pc, STAGING, t)
            n = copy_rows(pc, STAGING, t, stream(mcur, f"SELECT * FROM {q(t.name)}"))
            pg.commit()
            add_keys_and_indexes(pc, STAGING, t)
            pg.commit()
            total += n
            if n >= 10000 or time.time() - ts > 5:
                log.info("  [%d/%d] %s: %d rows in %.1fs", i, len(tables), t.name, n, time.time() - ts)
        except Exception as e:  # one bad table must not stop the rest
            pg.rollback()
            warnings.append(f"{t.name}: {e}")
            log.exception("  %s failed", t.name)
            mcur.close()
            mcur = my.cursor()   # streamed result may be half-read; start a fresh cursor
    my.rollback()
    my.close()

    # move staging into the mirror, table by table
    pc.execute("SELECT table_name, columns_hash FROM yarago.sync_state")
    known = dict(pc.fetchall())
    pc.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=%s", (STAGING,))
    staged = {r[0] for r in pc.fetchall()}
    pc.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=%s", (MIRROR,))
    existing = {r[0] for r in pc.fetchall()}
    rebuilt = []
    for t in tables.values():
        if t.pg not in staged:
            continue
        try:
            if t.pg in existing and known.get(t.pg) == t.hash:
                # same structure: refill in place so views on top of it keep working
                pc.execute(sql.SQL("TRUNCATE {}").format(ident(MIRROR, t.pg)))
                pc.execute(sql.SQL("INSERT INTO {} SELECT * FROM {}").format(ident(MIRROR, t.pg), ident(STAGING, t.pg)))
            else:
                if t.pg in existing:
                    rebuilt.append(t.pg)
                pc.execute(sql.SQL("DROP TABLE IF EXISTS {} CASCADE").format(ident(MIRROR, t.pg)))
                pc.execute(sql.SQL("ALTER TABLE {} SET SCHEMA {}").format(ident(STAGING, t.pg), sql.Identifier(MIRROR)))
            idv, modv = mirror_max(pc, MIRROR, t)
            pc.execute(sql.SQL("SELECT count(*) FROM {}").format(ident(MIRROR, t.pg)))
            save_state(pc, t, idv, modv, pc.fetchone()[0], "full")
            pg.commit()
        except Exception as e:
            pg.rollback()
            warnings.append(f"{t.name} (swap): {e}")
            log.exception("  swap of %s failed", t.name)
    pc.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(STAGING)))
    pc.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(STAGING)))
    pg.commit()
    warnings.extend(apply_views(pg))
    if rebuilt:
        warnings.append("structure changed (dependent views must be recreated): " + ", ".join(rebuilt))
    status = "warning" if warnings else "ok"
    msg = "; ".join(warnings)[:4000] or None
    run_end(pc, rid, status, len(staged), total, msg)
    pg.close()
    log.info("FULL copy %s: %d tables, %d rows, %.1f min%s", status, len(staged), total, (time.time() - t0) / 60,
             f" | {msg}" if msg else "")
    return 0


def apply_views(pg):
    """Re-create db/views/*.sql (a full copy may have dropped tables they depend on)."""
    problems = []
    for f in sorted((ROOT / "db" / "views").glob("*.sql")):
        try:
            pg.execute(f.read_text(encoding="utf-8"))
            pg.commit()
        except Exception as e:
            pg.rollback()
            problems.append(f"view file {f.name}: {e}")
            log.exception("applying %s failed", f.name)
    return problems


# ------------------------------------------------------------------ incremental
def upsert(pc, t, rows):
    """rows: cleaned rows for table t -> INSERT ... ON CONFLICT on t.key"""
    if not rows:
        return 0
    pc.execute(sql.SQL("CREATE TEMP TABLE tmp_sync (LIKE {}) ON COMMIT DROP").format(ident(MIRROR, t.pg)))
    stmt = sql.SQL("COPY tmp_sync ({}) FROM STDIN").format(sql.SQL(", ").join(sql.Identifier(c) for c in t.pg_names))
    with pc.copy(stmt) as cp:
        for r in rows:
            cp.write_row(r)
    keys = [k.lower() for k in t.key]
    nonkey = [c for c in t.pg_names if c not in keys]
    cols = sql.SQL(", ").join(sql.Identifier(c) for c in t.pg_names)
    keyl = sql.SQL(", ").join(sql.Identifier(k) for k in keys)
    if nonkey:
        action = sql.SQL("DO UPDATE SET ") + sql.SQL(", ").join(
            sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c)) for c in nonkey)
    else:
        action = sql.SQL("DO NOTHING")
    pc.execute(sql.SQL("INSERT INTO {} ({}) SELECT DISTINCT ON ({}) {} FROM tmp_sync ORDER BY {} ON CONFLICT ({}) {}").format(
        ident(MIRROR, t.pg), cols, keyl, cols, keyl, keyl, action))
    return len(rows)


def fetch_all(mc, query, params, t):
    cur = mc.cursor()
    cur.execute(query, params)
    conv = make_converter(t)
    return [conv(r) for r in cur.fetchall()]


def refresh_today_visits(mc, pc, schema, state):
    """Re-read the visit tables' rows of today's appointments (a few dozen, by an indexed column). Returns rows read."""
    pc.execute("SELECT aappoint_id FROM yarago.tblappointments "
               "WHERE tappoint_date_time >= current_date AND tappoint_date_time < current_date + 1")
    ids = [r[0] for r in pc.fetchall()]
    n = 0
    for name in VISIT_TABLES:
        t = schema.get(name)
        if not ids or name == "tblappointments" or not t or t.pg not in state or state[t.pg][2] != t.hash:
            continue
        if not t.key or not t.apptcol or t.apptcol not in t.indexed:
            if name not in TODAY_SKIPPED:   # never scan a big table unindexed in clinic hours; say so once
                TODAY_SKIPPED.add(name)
                log.warning("  %s: no key or no index on its visit column (%s): today's edits arrive with the nightly copy",
                            name, t.apptcol)
            continue
        ph = ",".join(["%s"] * len(ids))
        rows = fetch_all(mc, f"SELECT * FROM {q(t.name)} WHERE {q(t.apptcol)} IN ({ph})", ids, t)
        n += upsert(pc, t, rows)
        pc.execute("DROP TABLE IF EXISTS tmp_sync")
    return n


def incremental():
    t0 = time.time()
    mc = my_conn()
    pg = pg_conn()
    pc = pg.cursor()
    pc.execute("SELECT table_name, last_id, last_modified, columns_hash FROM yarago.sync_state")
    state = {r[0]: r[1:] for r in pc.fetchall()}
    if not state:
        log.error("No sync state yet - run a full copy first.")
        return 2
    schema = load_schema(mc)
    rid = run_start(pc, "incremental")
    total, done, warnings = 0, 0, []
    changed_visits = set()

    # 1. hot tables
    for name in HOT_TABLES:
        t = schema.get(name)
        if not t or t.pg not in state:
            continue
        last_id, last_mod, h = state[t.pg]
        if h != t.hash:
            warnings.append(f"{name}: structure changed in Yarago, skipped until next full copy")
            continue
        try:
            where, params = [], []
            if t.idcol and last_id is not None:
                where.append(f"{q(t.idcol)} > %s")
                params.append(last_id)
            if t.modcol and last_mod is not None and t.name not in UNRELIABLE_MOD:
                where.append(f"{q(t.modcol)} >= %s")
                params.append(last_mod - OVERLAP)
            if where and t.key:
                rows = fetch_all(mc, f"SELECT * FROM {q(t.name)} WHERE " + " OR ".join(where), params, t)
                if t.modcol and len(rows) > 5000 and len(rows) > 0.5 * max(t.approx_rows, 1):
                    UNRELIABLE_MOD.add(t.name)
                    log.warning("  %s: modified column %s matched %d rows (most of the table); "
                                "using new ids only from now on, edits arrive with the nightly copy",
                                name, t.modcol, len(rows))
                n = upsert(pc, t, rows)
            elif t.approx_rows < SMALL_TABLE_ROWS:
                rows = fetch_all(mc, f"SELECT * FROM {q(t.name)}", None, t)
                pc.execute(sql.SQL("DELETE FROM {}").format(ident(MIRROR, t.pg)))
                n = copy_rows(pc, MIRROR, t, rows) if rows else 0
            else:
                continue
            if name in VISIT_TABLES and rows:
                vcol = t.idcol if name == "tblappointments" else t.apptcol
                if vcol:
                    i = t.names.index(vcol)
                    changed_visits.update(r[i] for r in rows if r[i] is not None)
            idv, modv = mirror_max(pc, MIRROR, t)
            save_state(pc, t, idv, modv, n, "incremental")
            pg.commit()
            total += n
            done += 1
            if n:
                log.info("  %s: %d rows", name, n)
        except Exception as e:
            pg.rollback()
            warnings.append(f"{name}: {e}")
            log.exception("  %s failed", name)

    # 1b. today's visit records again, by appointment id: Yarago saves the optometry and doctor screens into them without
    # touching their modified column, so without this the day's work only arrived with the nightly copy (D-051)
    try:
        total += refresh_today_visits(mc, pc, schema, state)
        pg.commit()
    except Exception as e:
        pg.rollback()
        warnings.append(f"today's visits: {e}")
        log.exception("  today's visits failed")

    # 2. clinical child tables (no modified date): new rows by id + all rows of changed visits
    children = [t for t in schema.values()
                if t.pg in state and not t.modcol and t.apptcol and t.key and t.name not in HOT_TABLES]
    visits = sorted(changed_visits)
    for t in children:
        last_id, _, h = state[t.pg]
        if h != t.hash:
            continue
        try:
            n = 0
            if t.idcol and last_id is not None:
                rows = fetch_all(mc, f"SELECT * FROM {q(t.name)} WHERE {q(t.idcol)} > %s", (last_id,), t)
                n += upsert(pc, t, rows)
                pc.execute("DROP TABLE IF EXISTS tmp_sync")
            by_visit = visits if t.apptcol in t.indexed else []
            for i in range(0, len(by_visit), 500):
                chunk = by_visit[i:i + 500]
                ph = ",".join(["%s"] * len(chunk))
                rows = fetch_all(mc, f"SELECT * FROM {q(t.name)} WHERE {q(t.apptcol)} IN ({ph})", chunk, t)
                pc.execute(sql.SQL("DELETE FROM {} WHERE {} = ANY(%s)").format(
                    ident(MIRROR, t.pg), sql.Identifier(t.apptcol.lower())), (chunk,))
                n += copy_rows(pc, MIRROR, t, rows) if rows else 0
            if n:
                idv, _ = mirror_max(pc, MIRROR, t)
                save_state(pc, t, idv, None, n, "incremental")
                log.info("  %s: %d rows (child of %d changed visits)", t.name, n, len(visits))
            pg.commit()
            total += n
        except Exception as e:
            pg.rollback()
            warnings.append(f"{t.name}: {e}")
            log.exception("  %s failed", t.name)

    mc.close()
    status = "warning" if warnings else "ok"
    msg = "; ".join(warnings)[:4000] or None
    run_end(pc, rid, status, done, total, msg)
    pg.close()
    log.info("incremental %s: %d rows, %d changed visits, %.1fs%s", status, total, len(visits), time.time() - t0,
             f" | {msg}" if msg else "")
    return 0


# ------------------------------------------------------------------ verify / status / service
def verify(all_tables=False):
    mc = my_conn()
    schema = load_schema(mc, None if all_tables else HOT_TABLES)
    pg = pg_conn()
    pc = pg.cursor()
    rid = run_start(pc, "verify")
    cur = mc.cursor()
    bad = []
    for t in schema.values():
        cur.execute(f"SELECT COUNT(*) FROM {q(t.name)}")
        ym = cur.fetchone()[0]
        try:
            pc.execute(sql.SQL("SELECT count(*) FROM {}").format(ident(MIRROR, t.pg)))
            pm = pc.fetchone()[0]
        except psycopg.errors.UndefinedTable:
            pg.rollback()
            pm = None
        flag = "" if ym == pm else "   <-- differs"
        if flag:
            bad.append(f"{t.name} yarago={ym} mirror={pm}")
        if flag or not all_tables:
            print(f"{t.name:55} yarago={ym:>9}  mirror={pm if pm is not None else 'missing':>9}{flag}")
    mc.close()
    run_end(pc, rid, "warning" if bad else "ok", len(schema), 0, "; ".join(bad)[:4000] or None)
    pg.close()
    print(f"\n{len(schema)} tables checked, {len(bad)} differ")
    return 1 if bad else 0


def status():
    pg = pg_conn()
    pc = pg.cursor()
    pc.execute("SELECT mode, started_at, finished_at, status, tables_done, rows_copied, left(message, 300) "
               "FROM app.sync_runs ORDER BY id DESC LIMIT 10")
    print("Last runs:")
    for r in pc.fetchall():
        print("  ", " | ".join("" if v is None else str(v) for v in r))
    pc.execute("SELECT count(*), sum(last_row_count), max(last_run_at) FROM yarago.sync_state")
    print("Mirror tables / rows / last activity:", pc.fetchone())
    pg.close()


# ------------------------------------------------------------------ analytics
def analytics():
    """Rebuild the analytics schema (reporting tables read by Metabase). Postgres only; never touches Yarago."""
    t0 = time.time()
    with pg_conn() as pg:
        rid = run_start(pg.cursor(), "analytics")
        pg.commit()
        try:
            counts = pg.execute("SELECT analytics.refresh()").fetchone()[0]
            pg.commit()
            run_end(pg.cursor(), rid, "ok", len(counts), sum(counts.values()))
            pg.commit()
            log.info("ANALYTICS rebuilt in %.1f s: %s", time.time() - t0, counts)
            # EMR completeness per month (D-028): its own step, so a failure here never undoes the rebuild above
            try:
                n = pg.execute("SELECT analytics.refresh_emr_completeness()").fetchone()[0]
                pg.commit()
                log.info("EMR completeness rebuilt: %s rows", n)
            except Exception:
                pg.rollback()
                log.exception("EMR completeness rebuild failed")
            # pharmacy sales, manufacturers and wholesalers (D-032): its own step, like the one above
            try:
                n = pg.execute("SELECT analytics.refresh_pharmacy()").fetchone()[0]
                pg.commit()
                log.info("Pharmacy analytics rebuilt: %s", n)
            except Exception:
                pg.rollback()
                log.exception("pharmacy analytics rebuild failed")
            # patient lists by group for the Patients page (D-039): its own step too
            try:
                n = pg.execute("SELECT app.refresh_patient_groups()").fetchone()[0]
                pg.commit()
                log.info("Patient groups rebuilt: %s rows", n)
            except Exception:
                pg.rollback()
                log.exception("patient groups rebuild failed")
            return 0
        except Exception as e:
            pg.rollback()
            run_end(pg.cursor(), rid, "error", 0, 0, str(e)[:4000])
            pg.commit()
            log.exception("analytics rebuild failed")
            return 1


def service():
    log.info("service started: incremental every %ds, full copy nightly at 01:00, analytics at 02:30", INCREMENTAL_EVERY_S)
    last_full = last_analytics = None
    while True:
        now = dt.datetime.now()
        try:
            if now.hour == 1 and last_full != now.date():
                full()
                last_full = now.date()
            elif now.hour == 2 and now.minute >= 30 and last_analytics != now.date():
                analytics()
                last_analytics = now.date()
            else:
                incremental()
        except Exception:
            log.exception("cycle failed")
        time.sleep(INCREMENTAL_EVERY_S)


def main():
    setup_logging()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["full", "incremental", "service", "verify", "status", "analytics"])
    ap.add_argument("--force", action="store_true", help="allow a full copy during clinic hours")
    ap.add_argument("--all", action="store_true", help="verify every table, not just the hot ones")
    a = ap.parse_args()
    if a.mode == "full":
        return full(a.force)
    if a.mode == "incremental":
        return incremental()
    if a.mode == "verify":
        return verify(a.all)
    if a.mode == "status":
        return status()
    if a.mode == "analytics":
        return analytics()
    return service()


if __name__ == "__main__":
    sys.exit(main() or 0)
