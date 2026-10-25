// Remidio Host Gateway API (D-041), nothing else: the queue calls, the exams list, and downloading a photograph from the
// signed link a queue item carries. Read-only at Remidio except itemSuccessfullyHandled, which takes the item off the
// TIRUR queue once Sudarshan has stored it. Tokens (REMIDIO_CLIENT_ID_TOKEN, REMIDIO_CLIENT_AUTH_TOKEN) are never logged.
// Learned on 25 Oct 2026: the live server accepts the dashboard's client auth token with the Postman collection's
// PACS_GATEWAY client token; getExamsByDate wants dates as yyyy-MM-dd and the Site Identifier ("TIRUR").
import { config } from "../config.js";

export interface RemidioResponse { status: number; data: any }
export type RemidioTransport = (method: "GET" | "POST", path: string) => Promise<RemidioResponse>;
export type PhotoFetcher = (url: string) => Promise<Buffer>;

export class RemidioError extends Error {}

export const remidioReady = () => !!(config.remidio.clientIdToken && config.remidio.clientAuthToken);

const https: RemidioTransport = async (method, path) => {
  const res = await fetch(`${config.remidio.url}${path}`, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { clientName: config.remidio.clientName, clientIdentificationToken: config.remidio.clientIdToken,
               clientAuthToken: config.remidio.clientAuthToken },
  });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
};
let transport: RemidioTransport = https;
/** Tests replace Remidio; nothing else should. */
export function setRemidioTransport(t: RemidioTransport | null) { transport = t ?? https; }

const MAX_PHOTO = 40 * 1024 * 1024;
/** Photographs come only from Google Cloud Storage links signed by Remidio (they expire after about an hour). */
export function photoUrlAllowed(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "storage.googleapis.com"; } catch { return false; }
}
const download: PhotoFetcher = async (url) => {
  if (!photoUrlAllowed(url)) throw new RemidioError("photograph link is not a Remidio storage link");
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!res.ok) throw new RemidioError(`photograph download failed (HTTP ${res.status}${res.status === 400 || res.status === 403 ? ", the link may have expired" : ""})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_PHOTO) throw new RemidioError(`photograph is ${Math.round(len / 1048576)} MB, over the 40 MB limit`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PHOTO) throw new RemidioError("photograph is over the 40 MB limit");
  return buf;
};
let fetcher: PhotoFetcher = download;
export function setPhotoFetcher(f: PhotoFetcher | null) { fetcher = f ?? download; }
export const fetchPhoto = (url: string) => fetcher(url);

async function call(method: "GET" | "POST", path: string) {
  if (!remidioReady()) throw new RemidioError("Remidio is not set up: run scripts\\setup-remidio.ps1 on shichika");
  try { return await transport(method, path); }
  catch (e: any) { throw new RemidioError(e?.name === "TimeoutError" ? "Remidio did not answer within 30 seconds" : `could not reach Remidio: ${String(e?.message ?? e).slice(0, 150)}`); }
}

/** HTTP status of the last queue read, shown on the System tab (an "empty" 404 can also mean the queue is switched off). */
export let lastQueueHttp: number | null = null;

/** The item at the head of the queue, or null when the queue is empty. Reading does not take it off the queue. */
export async function getQueueItem(): Promise<any | null> {
  const r = await call("GET", "/api/gateway/getQueueItem");
  lastQueueHttp = r.status;
  if (r.status === 204 || r.status === 404) return null;
  if (r.status !== 200) throw new RemidioError(`queue read refused (HTTP ${r.status})`);
  const d = r.data?.data;
  return d && typeof d === "object" && Object.keys(d).length ? d : null;
}

/** Take the head item off the queue (only after it is stored). */
export async function itemHandled(): Promise<void> {
  const r = await call("POST", "/api/gateway/itemSuccessfullyHandled");
  if (r.status < 200 || r.status >= 300) throw new RemidioError(`Remidio did not take the item off the queue (HTTP ${r.status})`);
}

/** Exams of TIRUR between two days (yyyy-MM-dd). Read only. */
export async function getExamsByDate(from: string, to: string): Promise<any[]> {
  const r = await call("GET", `/api/gateway/getExamsByDate/${from}/${to}/${encodeURIComponent(config.remidio.site)}`);
  if (r.status !== 200) throw new RemidioError(`exams list refused (HTTP ${r.status})`);
  return Array.isArray(r.data?.data) ? r.data.data : [];
}

// ---------- queue items (pure) ----------
const EYE: Record<string, "RE" | "LE"> = { RIGHT: "RE", LEFT: "LE" };

/** A queue item without anything secret or short-lived: signed links and tokens removed (for meta and the log). */
export function stripLinks(item: unknown): unknown {
  return JSON.parse(JSON.stringify(item ?? null, (k, v) =>
    (typeof v === "string" && (/^https?:\/\//i.test(v) || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v))) ? "(link removed)" : v));
}

export interface QueuePhoto {
  remidioImageId: number; remidioExamId: number | null; remidioPatientId: number | null; mrn: string; sex: string | null;
  eye: "RE" | "LE" | null; field: string | null; quality: string | null; qualityScore: number | null; capturedAt: Date | null;
  width: number | null; height: number | null; url: string; thumbUrl: string | null; site: string | null;
}

/** The photograph in an IMAGE queue item (shape of Remidio's own example), or null for any other kind of item. */
export function photoFromItem(item: any): QueuePhoto | null {
  if (String(item?.type ?? "").toUpperCase() !== "IMAGE" || !item.image) return null;
  const i = item.image, p = item.patient ?? {};
  if (!i.id || typeof i.path !== "string") return null;
  return {
    remidioImageId: Number(i.id), remidioExamId: i.examId != null ? Number(i.examId) : (item.exam?.id ?? null),
    remidioPatientId: p.id != null ? Number(p.id) : null, mrn: String(p.mrn ?? "").trim(),
    sex: p.gender ? String(p.gender).toUpperCase().slice(0, 1) : null,
    eye: EYE[String(i.laterality ?? "").toUpperCase()] ?? null, field: i.field ?? null, quality: i.quality ?? null,
    qualityScore: i.discQualityResults?.qualityScore != null ? Number(i.discQualityResults.qualityScore) : null,
    capturedAt: i.date ? new Date(Number(i.date)) : null, width: i.width ?? null, height: i.height ?? null,
    url: i.path, thumbUrl: typeof i.thumbnailPath === "string" ? i.thumbnailPath : null,
    site: item.site?.siteCustomIdentifier ?? item.site?.siteName ?? null,
  };
}
