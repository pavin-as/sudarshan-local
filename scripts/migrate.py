"""Apply db/migrations/*.sql in order (each file is idempotent). Usage: python scripts/migrate.py"""
from pathlib import Path
import psycopg
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
c = dotenv_values(ROOT / ".env")
with psycopg.connect(host=c["PG_HOST"], port=int(c["PG_PORT"]), dbname=c["PG_DB"],
                     user=c["PG_APP_USER"], password=c["PG_APP_PASSWORD"]) as conn:
    for f in sorted((ROOT / "db" / "migrations").glob("*.sql")):
        conn.execute(f.read_text(encoding="utf-8"))
        conn.commit()
        print("applied", f.name)
