"""Check the Metabase mail settings in .env: signs in to the SMTP server and signs out. Sends nothing.
    python scripts\\check_smtp.py
.env: METABASE_SMTP_USER, METABASE_SMTP_PASSWORD, optional METABASE_SMTP_HOST (default smtp.gmail.com),
METABASE_SMTP_PORT (default 465).
Prints only the account, the server and whether the login worked - never the password.
"""
import smtplib
import ssl
import sys
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"


def read_env(path: Path) -> dict:
    vals = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip('"').strip("'")
    return vals


env = read_env(ENV)
user, password = env.get("METABASE_SMTP_USER"), env.get("METABASE_SMTP_PASSWORD")
host, port = env.get("METABASE_SMTP_HOST") or "smtp.gmail.com", int(env.get("METABASE_SMTP_PORT") or 465)
if not user or not password:
    sys.exit("METABASE_SMTP_USER and METABASE_SMTP_PASSWORD must both be set in .env")
# shape only, never the value: a Google app password is 16 letters (Google shows it in groups of 4 with spaces)
print(f"account: {user}  server: {host}:{port}  password: {len(password.replace(' ', ''))} characters")
try:
    with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=20) as s:
        s.login(user, password.replace(" ", ""))
    print("OK: the login was accepted. Mail can be sent from this account.")
except smtplib.SMTPAuthenticationError as e:
    print(f"refused: {e.smtp_code} {e.smtp_error.decode(errors='replace')[:160]}")
    sys.exit("FAILED: use an app password (Google account > Security > 2-Step Verification > App passwords); "
             "2-Step Verification must be on, and the Workspace admin must allow app passwords.")
except Exception as e:
    sys.exit(f"FAILED: could not reach or talk to {host}:{port}: {type(e).__name__}")
