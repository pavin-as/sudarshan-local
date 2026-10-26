// Retinal thickness from Topcon's own layer lines (D-049, OCT_PLAN Step 7): central subfield thickness (CST) and the nine
// ETDRS sectors (centre 1 mm; inner ring 1-3 mm; outer ring 3-6 mm; superior / nasal / inferior / temporal), for 3D macula
// cubes and radial macula scans. Two definitions, as IMAGEnet offers more than one: ILM to BM, and ILM to OS/RPE. Pure:
// no database, no files; checked against IMAGEnet before anyone relies on it (OCT_PLAN Step 7 gate).
//   Geometry: each sample's place in mm comes from the scan's spacing; its direction on the eye from the scan lines on the
//   colour photograph (image x right, y down). Superior = up on the photograph. Nasal = the optic disc's side: the image's
//   right for a right eye, left for a left eye (checked 26 Oct on Maestro2 photographs).
//   Centre: for a cube, the thinnest point (ILM-BM, smoothed) within 1.5 mm of the scan centre, i.e. the foveal pit; for
//   a radial scan, where its lines cross.
export interface Spacing { axialMm: number; lateralMm: number; betweenMm: number | null }
export interface LayerGrid { data: Int16Array; shape: [number, number, number]; scale: number; labels: string[] }
export type Sector = "C" | "S1" | "N1" | "I1" | "T1" | "S2" | "N2" | "I2" | "T2";
export const SECTORS: Sector[] = ["C", "S1", "N1", "I1", "T1", "S2", "N2", "I2", "T2"];
export const DEFINITIONS = { "ILM-BM": ["ILM", "BM"], "ILM-OS/RPE": ["ILM", "OS/RPE"] } as const;
export type Definition = keyof typeof DEFINITIONS;
export interface Thickness {
  version: 1; kind: "cube" | "radial";
  centre: { uMm: number; vMm: number; method: "thinnest point" | "scan centre" };
  results: Record<Definition, { cstUm: number | null; sectorsUm: Record<Sector, number | null>; cover: Record<Sector, number> } | null>;
}
const MIN_COVER = 0.5;                       // a sector needs half its samples measured

/** Which ETDRS sector a point (mm from the centre; u right, v down on the photograph) falls in, or null outside 6 mm. */
export function sectorOf(u: number, v: number, nasalRight: boolean): Sector | null {
  const r = Math.hypot(u, v);
  if (r < 0.5) return "C";
  if (r >= 3) return null;
  const ring = r < 1.5 ? "1" : "2";
  const deg = (Math.atan2(-v, u) * 180) / Math.PI;     // 0 = right, 90 = up, (-180, 180]
  // each boundary belongs to one sector: S [45, 135), I (-135, -45], right (-45, 45), left the rest
  const side = deg >= 45 && deg < 135 ? "S" : deg > -135 && deg <= -45 ? "I" : (Math.abs(deg) < 45) === nasalRight ? "N" : "T";
  return (side + ring) as Sector;
}

/** Thickness in micrometres at B-scan b, column c, between two surfaces; null where either is missing. */
function between(g: LayerGrid, sp: Spacing, b: number, c: number, top: number, bottom: number): number | null {
  const [, surfaces, cols] = g.shape;
  const a = g.data[(b * surfaces + top) * cols + c], z = g.data[(b * surfaces + bottom) * cols + c];
  if (a < 0 || z < 0 || z < a) return null;
  return ((z - a) / g.scale) * sp.axialMm * 1000;
}

/** Where each sample lies, in mm from the scan centre with u to the photograph's right and v down; null if unknown. */
function samplePositions(g: LayerGrid, sp: Spacing, lines: (number[] | null)[] | null, kind: "cube" | "radial"): ((b: number, c: number) => [number, number]) | null {
  const [frames, , cols] = g.shape;
  const ok = (lines ?? []).filter((l): l is number[] => !!l && l.length >= 4);
  if (ok.length < frames) return null;
  const unit = (l: number[]) => { const dx = l[2] - l[0], dy = l[3] - l[1], n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
  const half = cols / 2;
  if (kind === "cube") {
    if (!sp.betweenMm) return null;
    const [ax, ay] = unit(ok[0]);                                         // along a B-scan
    const first = ok[0], last = ok[ok.length - 1];
    const sx = (last[0] + last[2]) / 2 - (first[0] + first[2]) / 2, sy = (last[1] + last[3]) / 2 - (first[1] + first[3]) / 2;
    const n = Math.hypot(sx, sy) || 1, [bx, by] = [sx / n, sy / n];       // from B-scan to B-scan
    return (b, c) => {
      const s = (c + 0.5 - half) * sp.lateralMm, t = (b + 0.5 - frames / 2) * sp.betweenMm!;
      return [s * ax + t * bx, s * ay + t * by];
    };
  }
  const dirs = ok.map(unit);
  return (b, c) => { const s = (c + 0.5 - half) * sp.lateralMm; return [s * dirs[b][0], s * dirs[b][1]]; };
}

export function scanKind(protocol: string | null, frames: number, sp: Spacing | null): "cube" | "radial" | null {
  const p = (protocol ?? "").toLowerCase();
  if (!p.includes("macula") || !sp) return null;
  if (p.startsWith("radial") && frames >= 6) return "radial";
  if (p.startsWith("3d") && frames >= 32 && sp.betweenMm) return "cube";
  return null;
}

export function computeThickness(g: LayerGrid, sp: Spacing, lines: (number[] | null)[] | null, eye: "RE" | "LE" | null,
                                 protocol: string | null): Thickness | null {
  const [frames, , cols] = g.shape;
  const kind = scanKind(protocol, frames, sp);
  if (!kind || !eye) return null;
  const pos = samplePositions(g, sp, lines, kind);
  if (!pos) return null;
  const idx = (name: string) => g.labels.indexOf(name);
  const ilm = idx("ILM"), bm = idx("BM");
  if (ilm < 0 || bm < 0) return null;
  // the centre
  let cu = 0, cv = 0, method: Thickness["centre"]["method"] = "scan centre";
  if (kind === "cube") {
    const k = Math.max(1, Math.round(0.15 / sp.lateralMm)), kb = Math.max(1, Math.round(0.15 / sp.betweenMm!));
    let best = Infinity;
    for (let b = kb; b < frames - kb; b++) for (let c = k; c < cols - k; c++) {
      const [u, v] = pos(b, c);
      if (Math.hypot(u, v) > 1.5) continue;
      let sum = 0, n = 0;
      for (let db = -kb; db <= kb; db++) for (let dc = -k; dc <= k; dc++) { const t = between(g, sp, b + db, c + dc, ilm, bm); if (t != null) { sum += t; n++; } }
      if (n > ((2 * k + 1) * (2 * kb + 1)) / 2 && sum / n < best) { best = sum / n; cu = u; cv = v; }
    }
    if (best < Infinity) method = "thinnest point";
  }
  const nasalRight = eye === "RE";
  const results = {} as Thickness["results"];
  for (const [name, [topName, bottomName]] of Object.entries(DEFINITIONS) as [Definition, readonly [string, string]][]) {
    const top = idx(topName), bottom = idx(bottomName);
    if (top < 0 || bottom < 0) { results[name] = null; continue; }
    const sum: Record<string, number> = {}, n: Record<string, number> = {}, all: Record<string, number> = {};
    for (let b = 0; b < frames; b++) for (let c = 0; c < cols; c++) {
      const [u, v] = pos(b, c);
      const s = sectorOf(u - cu, v - cv, nasalRight);
      if (!s) continue;
      all[s] = (all[s] ?? 0) + 1;
      const t = between(g, sp, b, c, top, bottom);
      if (t != null) { sum[s] = (sum[s] ?? 0) + t; n[s] = (n[s] ?? 0) + 1; }
    }
    const sectorsUm = {} as Record<Sector, number | null>, cover = {} as Record<Sector, number>;
    for (const s of SECTORS) {
      cover[s] = all[s] ? (n[s] ?? 0) / all[s] : 0;
      sectorsUm[s] = all[s] && cover[s] >= MIN_COVER ? Math.round(sum[s] / n[s]) : null;
    }
    results[name] = { cstUm: sectorsUm.C, sectorsUm, cover };
  }
  return { version: 1, kind, centre: { uMm: Math.round(cu * 1000) / 1000, vMm: Math.round(cv * 1000) / 1000, method }, results };
}
