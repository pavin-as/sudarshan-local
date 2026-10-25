// Live screening outcome of an AI grading (D-045, D-046): refer / uncertain / routine from the model's referral score
// (p2+p3+p4) and its cut-offs in the setting retina.screening_cutoffs (keyed by model SHA-256). Ungradable photographs
// (Remidio INSUFFICIENT quality, or a doctor marked "cannot be graded") are always "uncertain". Research, silent: shown
// on the Retina AI page only; the DR outcome never clears a patient (macular oedema, symptoms, quality need a person).
import { outcomeOf, type Outcome } from "./evalScreening.js";
import { setting } from "./outreach.js";

export interface Cutoff { name: string; refer: number; clear: number; source: string }
export type Cutoffs = Record<string, Cutoff>;

export const screeningCutoffs = () => setting<Cutoffs>("retina.screening_cutoffs", {});

export interface Screened { outcome: Outcome; score: number; refer: number; clear: number; source: string; model: string; ungradable: boolean }

/** Outcome of one grading, or null when the grading failed or its model has no cut-offs. */
export function screeningFor(g: { status: string; probs: number[] | null; modelSha256: string | null; photoQuality?: string | null;
                                  doctorUngradable?: boolean | null }, cutoffs: Cutoffs): Screened | null {
  if (g.status !== "ok" || !g.probs || g.probs.length !== 5 || !g.modelSha256) return null;
  const c = cutoffs[g.modelSha256];
  if (!c) return null;
  const score = Number(g.probs[2]) + Number(g.probs[3]) + Number(g.probs[4]);
  const ungradable = g.photoQuality === "INSUFFICIENT" || !!g.doctorUngradable;
  return { outcome: outcomeOf(score, c.refer, c.clear, ungradable), score, refer: c.refer, clear: c.clear, source: c.source, model: c.name, ungradable };
}

/** Graders switched on in retina.graders: "arko" or "rfm:<head>". */
export async function activeGraders(): Promise<{ key: string; grader: string; head: string | null }[]> {
  const list = await setting<string[]>("retina.graders", ["arko"]);
  return (Array.isArray(list) ? list : []).map((key) => {
    const [grader, head] = String(key).split(":");
    return { key: String(key), grader, head: head || null };
  });
}
