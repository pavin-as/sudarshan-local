// Research DR grader (D-040), nothing else: the call to the grader container and the agreement figures (pure, no
// database). The grader runs on this machine only (127.0.0.1:7860) and gets the photograph and its file name, never a
// name, MRD or phone number. The key RETINA_AI_KEY in .env is never logged.
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

export const GRADES = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"] as const;
export const IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const MAX_IMAGE_MB = 40;                 // same limit as the grader

export interface GraderResult {
  grade: number; probs: number[]; raw: number[]; calibration: string;
  preprocessMs: number; inferenceMs: number;
  imageSha256: string; width: number; height: number;
  modelRepo: string; modelCommit: string; modelSha256: string; graderVersion: string;
}
export type GradeOutcome = { kind: "ok"; result: GraderResult } | { kind: "rejected"; message: string } | { kind: "error"; message: string };

export interface GraderResponse { status: number; data: any }
export type GraderTransport = (method: "GET" | "POST", path: string, body?: Buffer, headers?: Record<string, string>) => Promise<GraderResponse>;

const http: GraderTransport = async (method, path, body, headers = {}) => {
  const res = await fetch(`${config.retinaAi.url}${path}`, {
    method, signal: AbortSignal.timeout(config.retinaAi.timeoutMs),
    headers: { "x-grader-key": config.retinaAi.key, ...headers },
    body: body ? new Uint8Array(body) : undefined,
  });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
};
let transport: GraderTransport = http;
/** Tests replace the grader; nothing else should. */
export function setGraderTransport(t: GraderTransport | null) { transport = t ?? http; }

export const offline = (why: string) => new HttpError(503, "retina_ai_offline",
  `The retina AI service is not available (${why}). Ask the administrator to start Docker Desktop on shichika; nothing was saved.`);

async function reach(method: "GET" | "POST", path: string, body?: Buffer, headers?: Record<string, string>) {
  try { return await transport(method, path, body, headers); }
  catch (e: any) {
    throw offline(e?.name === "TimeoutError" ? `no answer within ${Math.round(config.retinaAi.timeoutMs / 1000)} seconds` : "it does not answer");
  }
}

/** The grader's /health, in plain fields. Never throws: an unreachable grader is { reachable: false }. */
export async function graderHealth() {
  try {
    const r = await transport("GET", "/health");
    const d = r.data ?? {};
    return { reachable: true, ready: r.status === 200 && d.model_loaded === true, modelRepo: d.model_repo ?? null,
             modelCommit: d.model_commit ?? null, modelSha256: d.model_sha256 ?? null, calibration: d.output_calibration ?? null,
             version: d.app_version ?? null, tensorflow: d.tensorflow ?? null, uptimeSeconds: d.uptime_seconds ?? null,
             lastInferenceMs: d.last_inference_ms ?? null, error: d.error ?? null, keySet: !!config.retinaAi.key };
  } catch {
    return { reachable: false, ready: false, keySet: !!config.retinaAi.key };
  }
}

/** Grade one photograph. Image problems the person can fix come back as "rejected" with the grader's words. */
export async function gradeImage(image: Buffer, fileName: string, contentType: string): Promise<GradeOutcome> {
  if (!config.retinaAi.key) throw offline("RETINA_AI_KEY is not set in .env");
  const r = await reach("POST", "/api/grade", image, { "content-type": contentType, "x-file-name": encodeURIComponent(fileName) });
  const d = r.data ?? {};
  if (r.status === 200) {
    const probs = (d.probs ?? []).map(Number);
    if (probs.length !== 5 || !Number.isInteger(d.grade) || d.grade < 0 || d.grade > 4)
      return { kind: "error", message: "The grader answered with an unexpected result; nothing was graded." };
    return { kind: "ok", result: {
      grade: d.grade, probs, raw: (d.raw ?? []).map(Number), calibration: String(d.calibration ?? ""),
      preprocessMs: Number(d.preprocess_ms ?? 0), inferenceMs: Number(d.inference_ms ?? 0),
      imageSha256: String(d.image_sha256 ?? ""), width: Number(d.width ?? 0), height: Number(d.height ?? 0),
      modelRepo: String(d.model_repo ?? ""), modelCommit: String(d.model_commit ?? ""), modelSha256: String(d.model_sha256 ?? ""),
      graderVersion: String(d.app_version ?? ""),
    } };
  }
  if (r.status === 422) return { kind: "rejected", message: String(d.message ?? "The photograph could not be read.") };
  if (r.status === 401) throw offline("the key in .env does not match the grader's key");
  if (r.status === 503) throw offline("the model is not loaded yet; it takes about a minute after Docker starts");
  if (r.status === 404) throw offline("the grader is an older version without the Sudarshan connection");
  return { kind: "error", message: `The grader failed on this photograph (HTTP ${r.status}).` };
}

// ---------- agreement between the AI grade and doctors' grades (pure) ----------
export interface Pair { ai: number; doctor: number }

/** Quadratic weighted kappa for 5 ordinal grades: the usual agreement figure for DR grading. null when undefined. */
export function quadraticKappa(pairs: Pair[], n = 5): number | null {
  if (!pairs.length) return null;
  const O = Array.from({ length: n }, () => Array(n).fill(0));
  const ha = Array(n).fill(0), hp = Array(n).fill(0);
  for (const { doctor, ai } of pairs) { O[doctor][ai]++; ha[doctor]++; hp[ai]++; }
  const total = pairs.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const w = ((i - j) ** 2) / ((n - 1) ** 2);
    num += w * O[i][j];
    den += w * (ha[i] * hp[j]) / total;
  }
  return den ? 1 - num / den : null;
}

/** Figures for the Agreement screen. Referable DR = grade 2 or worse (moderate NPDR or worse). */
export function agreement(pairs: Pair[]) {
  const n = pairs.length;
  const confusion = Array.from({ length: 5 }, () => Array(5).fill(0));          // rows = doctor, columns = AI
  for (const p of pairs) confusion[p.doctor][p.ai]++;
  const exact = pairs.filter((p) => p.ai === p.doctor).length;
  const withinOne = pairs.filter((p) => Math.abs(p.ai - p.doctor) <= 1).length;
  const ref = (g: number) => g >= 2;
  const tp = pairs.filter((p) => ref(p.doctor) && ref(p.ai)).length;
  const fn = pairs.filter((p) => ref(p.doctor) && !ref(p.ai)).length;
  const fp = pairs.filter((p) => !ref(p.doctor) && ref(p.ai)).length;
  const tn = pairs.filter((p) => !ref(p.doctor) && !ref(p.ai)).length;
  return {
    n, exact, withinOne, kappa: quadraticKappa(pairs), confusion,
    referable: { tp, fn, fp, tn, sensitivity: tp + fn ? tp / (tp + fn) : null, specificity: tn + fp ? tn / (tn + fp) : null },
  };
}
