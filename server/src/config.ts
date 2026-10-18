// Settings come from the app's .env (D:\Sudarshan\app\.env). Never print secrets.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, "..", "..");          // server/dist -> app
loadEnv({ path: process.env.SUDARSHAN_ENV ?? path.join(APP_ROOT, ".env") });

function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const config = {
  pg: {
    host: process.env.PG_HOST ?? "127.0.0.1",
    port: num("PG_PORT", 5432),
    database: process.env.PG_DB ?? "sudarshan",
    user: process.env.PG_APP_USER ?? "sudarshan_app",
    password: process.env.PG_APP_PASSWORD || undefined,
    max: num("PG_POOL_MAX", 10),
  },
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  port: num("SERVER_PORT", 8484),           // not 8080: Tomcat (Yarago) usually holds it
  // true once Caddy serves https://sudarshan.local; plain http on the LAN until then
  cookieSecure: (process.env.COOKIE_SECURE ?? "false").toLowerCase() === "true",
  sessionHours: num("SESSION_HOURS", 12),
  timezone: "Asia/Kolkata",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
