"""Configure Metabase for Sudarshan through its API (run by install-metabase.ps1; safe to run again).
    python scripts\\metabase_setup.py
- first run: creates the admin login (admin@gs.sampadavr.com, temporary password METABASE_ADMIN_PASSWORD in .env) and an
  API key for this script (METABASE_API_KEY, added to .env); later runs use the key, so a changed password does not matter
- the database connection "Sudarshan analytics" as sudarshan_bi (analytics schema only)
- outgoing mail through Gmail (METABASE_SMTP_* in .env)
- collection "Sudarshan", the questions and the four dashboards defined in scripts/metabase_dashboards.py
  (questions and dashboards with the same name are updated in place, so edits made in Metabase to those are replaced;
  copy a dashboard under another name to keep your own version)
- the weekly email of "Clinic week" to admin@gs.sampadavr.com, Monday 07:00
Never prints a password or key.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from metabase_dashboards import COLLECTION, DASHBOARDS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
BASE = "http://127.0.0.1:3000"
ADMIN_EMAIL = "admin@gs.sampadavr.com"
DB_NAME = "Sudarshan analytics"
SUBSCRIBE = ("Clinic week", "admin@gs.sampadavr.com", "mon", 7)


def read_env():
    vals = {}
    for line in ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


CFG = read_env()
HEADERS = {"Content-Type": "application/json"}


def api(method, path, body=None, ok=(200, 202, 204)):
    req = urllib.request.Request(BASE + path, method=method, headers=HEADERS,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")[:400]
        if e.code in ok:
            return None
        raise SystemExit(f"Metabase {method} {path} -> {e.code}: {msg}")


def step(t):
    print(f"  {t}")


# ---------------------------------------------------------------- login
def login():
    props = api("GET", "/api/session/properties")
    if not props.get("has-user-setup"):
        r = api("POST", "/api/setup", {
            "token": props["setup-token"],
            "user": {"email": ADMIN_EMAIL, "first_name": "Pavin", "last_name": "Sampada VR", "password": CFG["METABASE_ADMIN_PASSWORD"],
                     "site_name": "Sampada VR - Sudarshan"},
            "prefs": {"site_name": "Sampada VR - Sudarshan", "site_locale": "en", "allow_tracking": False},
        })
        HEADERS["X-Metabase-Session"] = r["id"]
        step(f"admin login created: {ADMIN_EMAIL} (temporary password in .env, METABASE_ADMIN_PASSWORD)")
    elif CFG.get("METABASE_API_KEY"):
        HEADERS["x-api-key"] = CFG["METABASE_API_KEY"]
        api("GET", "/api/user/current")
        step("signed in with the API key")
        return
    else:
        r = api("POST", "/api/session", {"username": ADMIN_EMAIL, "password": CFG["METABASE_ADMIN_PASSWORD"]})
        HEADERS["X-Metabase-Session"] = r["id"]
    # an API key for later runs (the admin's password will be changed)
    groups = api("GET", "/api/permissions/group")
    admin_group = next(g["id"] for g in groups if g["name"] == "Administrators")
    key = api("POST", "/api/api-key", {"name": "Sudarshan setup script", "group_id": admin_group})
    with ENV.open("a", encoding="ascii") as f:
        f.write(f"\nMETABASE_API_KEY={key['unmasked_key']}\n")
    HEADERS.pop("X-Metabase-Session", None)
    HEADERS["x-api-key"] = key["unmasked_key"]
    step("API key created for this script (METABASE_API_KEY in .env)")


# ---------------------------------------------------------------- database
def database():
    details = {"host": "127.0.0.1", "port": int(CFG.get("PG_PORT", 5432)), "dbname": CFG.get("PG_DB", "sudarshan"),
               "user": "sudarshan_bi", "password": CFG["BI_PG_PASSWORD"], "ssl": False,
               "schema-filters-type": "inclusion", "schema-filters-patterns": "analytics"}
    dbs = api("GET", "/api/database")
    dbs = dbs["data"] if isinstance(dbs, dict) else dbs
    db = next((d for d in dbs if d["name"] == DB_NAME), None)
    body = {"engine": "postgres", "name": DB_NAME, "details": details, "is_full_sync": True, "auto_run_queries": True}
    if db:
        api("PUT", f"/api/database/{db['id']}", body)
        db_id = db["id"]
    else:
        db_id = api("POST", "/api/database", body)["id"]
    for d in dbs:   # Metabase's sample database and its example dashboards are not wanted
        if d.get("is_sample"):
            api("DELETE", f"/api/database/{d['id']}")
    for c in api("GET", "/api/collection"):
        if c.get("name") == "Examples" and not c.get("archived") and isinstance(c.get("id"), int):
            api("PUT", f"/api/collection/{c['id']}", {"archived": True})
    api("POST", f"/api/database/{db_id}/sync_schema")
    for _ in range(60):
        meta = api("GET", f"/api/database/{db_id}/metadata")
        if any(t["name"] == "fact_visit" for t in meta.get("tables", [])):
            break
        time.sleep(3)
    step(f"connection '{DB_NAME}' (sudarshan_bi, analytics schema only), {len(meta.get('tables', []))} tables seen")
    return db_id


# ---------------------------------------------------------------- mail
def mail():
    if not (CFG.get("METABASE_SMTP_USER") and CFG.get("METABASE_SMTP_PASSWORD")):
        step("mail not set up: METABASE_SMTP_USER / METABASE_SMTP_PASSWORD missing in .env")
        return False
    sender = CFG["METABASE_SMTP_USER"]
    api("PUT", "/api/email", {
        "email-smtp-host": CFG.get("METABASE_SMTP_HOST") or "smtp.gmail.com",
        "email-smtp-port": int(CFG.get("METABASE_SMTP_PORT") or 465),
        "email-smtp-security": "ssl",
        "email-smtp-username": sender,
        "email-smtp-password": CFG["METABASE_SMTP_PASSWORD"].replace(" ", ""),
        "email-from-address": sender,
        "email-from-name": "Sampada VR - Sudarshan",
        "email-reply-to": [sender],
    })
    step(f"mail: sends as {sender} through {CFG.get('METABASE_SMTP_HOST') or 'smtp.gmail.com'} (connection tested by Metabase)")
    return True


# ---------------------------------------------------------------- collection, questions, dashboards
def collection():
    for c in api("GET", "/api/collection"):
        if c.get("name") == COLLECTION and not c.get("archived"):
            return c["id"]
    return api("POST", "/api/collection", {"name": COLLECTION, "description": "Built by scripts/metabase_setup.py from the analytics schema. Definitions: docs/METRICS.md."})["id"]


def cards_in(coll_id):
    items = api("GET", f"/api/collection/{coll_id}/items?models=card&models=dashboard")
    items = items["data"] if isinstance(items, dict) else items
    return {(i["model"], i["name"]): i["id"] for i in items}


def upsert_card(q, db_id, coll_id, existing):
    body = {
        "name": q["name"], "description": q.get("description"), "collection_id": coll_id,
        "display": q["display"], "visualization_settings": q.get("viz", {}),
        "dataset_query": {"type": "native", "native": {"query": q["sql"], "template-tags": {}}, "database": db_id},
    }
    cid = existing.get(("card", q["name"]))
    if cid:
        api("PUT", f"/api/card/{cid}", body)
        return cid
    return api("POST", "/api/card", body)["id"]


def check_card(cid, name):
    r = api("POST", f"/api/card/{cid}/query")
    if r.get("status") != "completed" or r.get("error"):
        raise SystemExit(f"question '{name}' failed: {str(r.get('error'))[:300]}")
    return r["row_count"]


def upsert_dashboard(d, db_id, coll_id, existing):
    did = existing.get(("dashboard", d["name"]))
    if not did:
        did = api("POST", "/api/dashboard", {"name": d["name"], "description": d["description"], "collection_id": coll_id})["id"]
    else:
        api("PUT", f"/api/dashboard/{did}", {"description": d["description"]})
    dashcards, rows = [], []
    for n, item in enumerate(d["cards"]):
        if "text" in item:
            dashcards.append({"id": -(n + 1), "card_id": None, "row": item["row"], "col": item["col"],
                              "size_x": item["w"], "size_y": item["h"],
                              "visualization_settings": {"virtual_card": {"name": None, "display": "text", "visualization_settings": {},
                                                                          "dataset_query": {}, "archived": False},
                                                         "text": item["text"]}})
            continue
        cid = upsert_card(item, db_id, coll_id, existing)
        rows.append((item["name"], check_card(cid, item["name"])))
        dashcards.append({"id": -(n + 1), "card_id": cid, "row": item["row"], "col": item["col"],
                          "size_x": item["w"], "size_y": item["h"], "visualization_settings": {}, "parameter_mappings": []})
    api("PUT", f"/api/dashboard/{did}", {"dashcards": dashcards, "tabs": []})
    step(f"dashboard '{d['name']}': {len(rows)} questions, all ran ({', '.join(f'{r}' for _, r in rows)} rows)")
    return did


def subscription(dash_id, name, to, day, hour):
    dash = api("GET", f"/api/dashboard/{dash_id}")
    cards = [{"id": dc["card_id"], "include_csv": False, "include_xls": False, "dashboard_card_id": dc["id"]}
             for dc in dash["dashcards"] if dc.get("card_id")]
    body = {"name": name, "dashboard_id": dash_id, "collection_id": dash["collection_id"], "cards": cards, "skip_if_empty": False,
            "channels": [{"channel_type": "email", "enabled": True, "recipients": [{"email": to}],
                          "schedule_type": "weekly", "schedule_day": day, "schedule_hour": hour, "schedule_frame": None}]}
    pulses = api("GET", f"/api/pulse?dashboard_id={dash_id}") or []
    mine = next((p for p in pulses if p.get("dashboard_id") == dash_id and not p.get("archived")), None)
    if mine:
        api("PUT", f"/api/pulse/{mine['id']}", body)
    else:
        api("POST", "/api/pulse", body)
    step(f"subscription: '{name}' to {to}, every {day.capitalize()} {hour:02d}:00")


def main():
    print("Metabase setup")
    login()
    api("PUT", "/api/setting/report-timezone", {"value": "Asia/Kolkata"})
    api("PUT", "/api/setting/start-of-week", {"value": "monday"})
    db_id = database()
    mailed = mail()
    coll = collection()
    existing = cards_in(coll)
    ids = {d["name"]: upsert_dashboard(d, db_id, coll, existing) for d in DASHBOARDS}
    wanted = {q["name"] for d in DASHBOARDS for q in d["cards"] if "sql" in q}
    for (model, name), cid in cards_in(coll).items():      # questions no dashboard uses any more (renamed or removed)
        if model == "card" and name not in wanted:
            api("PUT", f"/api/card/{cid}", {"archived": True})
            step(f"archived old question '{name}'")
    if mailed:
        name, to, day, hour = SUBSCRIBE
        subscription(ids[name], name, to, day, hour)
    print("done")


if __name__ == "__main__":
    main()
