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
  // research DR grader (D-040): Docker container on this machine only; the key is shared with its docker\.env
  retinaAi: {
    url: (process.env.RETINA_AI_URL ?? "http://127.0.0.1:7860").replace(/\/$/, ""),
    key: process.env.RETINA_AI_KEY ?? "",
    timeoutMs: num("RETINA_AI_TIMEOUT_MS", 60_000),
    // fundus photographs received from Remidio (D-041): administrators only, in the nightly backup
    photoDir: process.env.RETINA_PHOTO_DIR ?? "D:\\Sudarshan\\data\\fundus",
  },
  // Remidio Host Gateway API (D-041): written by scripts/setup-remidio.ps1; the tokens are never logged
  remidio: {
    url: (process.env.REMIDIO_URL ?? "https://remidio-backend-india.appspot.com").replace(/\/$/, ""),
    clientName: process.env.REMIDIO_CLIENT_NAME ?? "PACS_GATEWAY",
    clientIdToken: process.env.REMIDIO_CLIENT_ID_TOKEN ?? "",
    clientAuthToken: process.env.REMIDIO_CLIENT_AUTH_TOKEN ?? "",
    site: process.env.REMIDIO_SITE ?? "TIRUR",
  },
  // Topcon Maestro2 photographs (D-048): IMAGEnet's exams on the ImageNet PC's read-only share, converted on shichika with
  // Topcon's DICOM OCT Export Tool and scripts\topcon_photo.py. The share password is written by scripts\setup-topcon.ps1
  // and never logged. A share path that is not \\host\share (the tests: a local folder) is read without signing in.
  topcon: {
    share: process.env.TOPCON_SHARE ?? "\\\\192.168.0.152\\SudarshanOCT$",
    dataDir: process.env.TOPCON_DATA_DIR ?? "Data",
    user: process.env.TOPCON_SHARE_USER ?? "OCT_PC\\sudarshan_ro",
    password: process.env.TOPCON_SHARE_PASSWORD ?? "",
    tool: process.env.TOPCON_TOOL ?? "D:\\Sudarshan\\tools\\topcon\\DicomOctExport-3.0.0.39\\DicomOctExport.exe",
    python: process.env.OCT_PYTHON ?? "D:\\Sudarshan\\tools\\oct-venv\\Scripts\\python.exe",
    // copies and exports of the exam being imported (patient data, administrators only); emptied after each exam
    workDir: process.env.TOPCON_WORK_DIR ?? "D:\\Sudarshan\\data\\oct\\work\\import",
    // OCT / OCTA scans kept (D-049): each exam's DICOM and the viewer's files; administrators and SYSTEM only
    octDir: process.env.OCT_DIR ?? "D:\\Sudarshan\\data\\oct\\store",
    // IMAGEnet's archive folders (the Jukebox volumes), read with their subfolders: "E=\\host\share;F=\\host\share2".
    // An exam found there is logged as <label>/<path below the share>; the live folder's exams by name alone.
    archives: (process.env.TOPCON_ARCHIVES ?? "").split(";").map((x) => x.trim()).filter(Boolean).map((x) => {
      const i = x.indexOf("=");
      return i > 0 ? { label: x.slice(0, i).trim(), dir: x.slice(i + 1).trim() } : { label: x.replace(/[^A-Za-z0-9]/g, "").slice(-12), dir: x };
    }),
  },
};
