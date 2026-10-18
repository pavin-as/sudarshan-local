"""Apply db/migrations/*.sql then db/views/*.sql, in name order (all idempotent).
Usage: python scripts/migrate.py"""
from pathlib import Path
import psycopg
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
c = dotenv_values(ROOT / ".env")
with psycopg.connect(host=c["PG_HOST"], port=int(c["PG_PORT"]), dbname=c["PG_DB"],
                     user=c["PG_APP_USER"], password=c["PG_APP_PASSWORD"]) as conn:
    for folder in ("migrations", "views"):
        for f in sorted((ROOT / "db" / folder).glob("*.sql")):
            conn.execute(f.read_text(encoding="utf-8"))
            conn.commit()
            print("applied", f"{folder}/{f.name}")
