// OCT / OCTA viewer (D-049, docs/OCT_PLAN.md Step 4): the exam's colour photograph with the scan lines on it, the B-scans
// one at a time (slider, arrow keys, mouse wheel; click a line on the photograph or a slab to jump), Topcon's layer lines,
// brightness and contrast, and for OCTA the en face slabs. What a clinician needs to look at a Maestro2 scan in Sudarshan;
// IMAGEnet stays the full viewer. Clinical roles (clinical.read).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { stamp } from "../format";
import { Drawer, ErrorNotice, Loading } from "./ui";
import { checkedWords, type ThicknessCheck } from "./InjectionResponse";

interface Study {
  id: number; photoId: number | null; eye: "RE" | "LE" | null; capturedAt: string | null; device: string | null; protocol: string | null;
  kind: "oct" | "octa"; frames: number; rows: number; cols: number; layers: string[] | null; slabs: string[] | null;
  spacing: { axialMm: number; lateralMm: number; betweenMm: number | null } | null;
}
interface View {
  scanLines: (number[] | null)[] | null; linesOnColourPhoto: boolean; spacing: Study["spacing"];
  layers: { labels: string[]; shape: [number, number, number]; scale: number } | null;
  slabs: { n: number; label: string; definition: string }[];
}
export interface OctListItem { id: number; eye: "RE" | "LE" | null; kind: "oct" | "octa"; protocol: string | null; frames: number; capturedAt: string | null; slabs: string[] | null }

const EYE: Record<string, string> = { RE: "Right eye", LE: "Left eye" };
const LAYER_COLOURS = ["#f5c542", "#4cc9f0", "#90e0ef", "#f72585", "#ff8fab", "#80ed99", "#c77dff", "#ffffff", "#ffd6a5", "#a0c4ff"];
/** "3D H/Macula/320/320/6x6mm/Angio" -> "3D H · Macula · 6x6mm · Angio" */
export const protocolWords = (p: string | null) => (p ?? "protocol not given").split("/").filter((x) => !/^\d+$/.test(x)).join(" · ");
export const octTitle = (s: OctListItem) => `${s.kind === "octa" ? "OCTA" : "OCT"} · ${s.eye ? EYE[s.eye] : "eye not given"} · ${protocolWords(s.protocol)}`;

type Sectors = Record<"C" | "S1" | "N1" | "I1" | "T1" | "S2" | "N2" | "I2" | "T2", number | null>;
interface ThicknessResult { version: number; kind: "cube" | "radial"; centre: { method: string };
  results: Record<"ILM-BM" | "ILM-OS/RPE", { cstUm: number | null; sectorsUm: Sectors } | null> }

/** The ETDRS grid (1, 3, 6 mm) with Sudarshan's thickness per sector, nasal on the disc's side as on the photograph. */
function EtdrsGrid({ t, eye, checked }: { t: ThicknessResult; eye: "RE" | "LE" | null; checked: ThicknessCheck | null }) {
  const [def, setDef] = useState<"ILM-BM" | "ILM-OS/RPE">("ILM-BM");
  const r = t.results[def];
  if (!r) return null;
  const s = r.sectorsUm, nasalRight = eye !== "LE";
  const R = [16, 48, 96], c = 100;                          // 1, 3, 6 mm diameters, drawn to scale
  const at = (ring: 1 | 2, side: "S" | "N" | "I" | "T") => {
    const rr = ring === 1 ? 32 : 72;
    const dx = side === "N" ? (nasalRight ? rr : -rr) : side === "T" ? (nasalRight ? -rr : rr) : 0;
    const dy = side === "S" ? -rr : side === "I" ? rr : 0;
    return { x: c + dx, y: c + dy + 4 };
  };
  const v = (x: number | null) => (x == null ? "—" : String(x));
  return (
    <div className="stack" style={{ gap: "0.3rem", alignItems: "flex-start" }}>
      <div className="row small" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
        <b>Thickness (µm), ETDRS grid</b>
        <select value={def} onChange={(e) => setDef(e.target.value as any)} aria-label="Thickness definition">
          <option value="ILM-BM">ILM to BM</option><option value="ILM-OS/RPE">ILM to OS/RPE</option></select>
      </div>
      <svg viewBox="0 0 200 200" style={{ width: 210, maxWidth: "100%" }} role="img" aria-label={`Central subfield ${v(r.cstUm)} micrometres`}>
        {R.map((rad) => <circle key={rad} cx={c} cy={c} r={rad} fill="none" stroke="var(--line)" />)}
        {[45, 135].map((a) => { const k = Math.cos((a * Math.PI) / 180);
          return <g key={a}><line x1={c + 16 * k} y1={c - 16 * k * (a === 45 ? 1 : -1)} x2={c + 96 * k} y2={c - 96 * k * (a === 45 ? 1 : -1)} stroke="var(--line)" />
                   <line x1={c - 16 * k} y1={c + 16 * k * (a === 45 ? 1 : -1)} x2={c - 96 * k} y2={c + 96 * k * (a === 45 ? 1 : -1)} stroke="var(--line)" /></g>; })}
        <text x={c} y={c + 4} textAnchor="middle" fontWeight={700} fontSize={13}>{v(s.C)}</text>
        {(["S", "N", "I", "T"] as const).flatMap((side) => [1, 2].map((ring) => { const p = at(ring as 1 | 2, side);
          return <text key={side + ring} x={p.x} y={p.y} textAnchor="middle" fontSize={11}>{v(s[`${side}${ring}` as keyof Sectors])}</text>; }))}
        <text x={nasalRight ? 196 : 4} y={196} textAnchor={nasalRight ? "end" : "start"} fontSize={9} fill="var(--ink-soft)">nasal</text>
      </svg>
      <div className="small muted" style={{ maxWidth: 360 }}>
        Central subfield (1 mm) <b>{v(r.cstUm)} µm</b>; centre: {t.centre.method}{t.kind === "radial" ? " (radial scan: fewer samples than a cube)" : ""}.
        {" "}Sudarshan's measurement from Topcon's layer lines. {checkedWords(checked)}
      </div>
    </div>
  );
}

/** Distance from a point to a segment, for "which scan line did they click". */
function segDist(px: number, py: number, l: number[]) {
  const [x1, y1, x2, y2] = l;
  const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function OctViewer({ studyId, onClose }: { studyId: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ["oct", "study", studyId], queryFn: () => api<{ study: Study; view: View; photo: { width: number; height: number } | null;
                                                                                    thickness: ThicknessResult | null; checked: ThicknessCheck | null }>(`/oct/studies/${studyId}`) });
  const layersQ = useQuery({
    queryKey: ["oct", "layers", studyId], enabled: !!q.data?.view.layers,
    queryFn: async () => { const r = await fetch(`/api/oct/studies/${studyId}/layers`, { credentials: "same-origin" }); if (!r.ok) throw new Error(`layers: HTTP ${r.status}`); return new Int16Array(await r.arrayBuffer()); },
  });
  const [n, setN] = useState(1);
  const [depth, setDepth] = useState(3);
  const [showLayers, setShowLayers] = useState(true);
  const [bright, setBright] = useState(100);
  const [contrast, setContrast] = useState(100);
  const bscanRef = useRef<HTMLDivElement>(null);
  const s = q.data?.study, v = q.data?.view, photo = q.data?.photo;
  const frames = s?.frames ?? 1;
  const go = (k: number) => setN(Math.max(1, Math.min(frames, Math.round(k))));

  // start in the middle of a volume (the fovea in a macula cube); arrow keys move through the B-scans
  useEffect(() => { if (s) setN(Math.ceil(s.frames / 2)); }, [s?.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;   // the slider moves itself
      if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setN((x) => Math.min(frames, x + 1)); }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setN((x) => Math.max(1, x - 1)); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [frames]);
  useEffect(() => {          // the next and previous B-scans load in the background, so scrolling is smooth
    for (const k of [n - 2, n - 1, n + 1, n + 2]) if (k >= 1 && k <= frames) new Image().src = `/api/oct/studies/${studyId}/bscan/${k}`;
  }, [n, frames, studyId]);
  useEffect(() => {
    const el = bscanRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); setN((x) => Math.max(1, Math.min(frames, x + (e.deltaY > 0 ? 1 : -1)))); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [frames, q.data]);

  const lines = useMemo(() => {
    const l = (v?.scanLines ?? []).map((x) => (x && x.length >= 4 ? x : null));
    return v?.linesOnColourPhoto && l.some(Boolean) ? l : null;
  }, [v]);
  const layerPaths = useMemo(() => {
    const L = layersQ.data, shape = v?.layers?.shape;
    if (!L || !shape || !s) return [];
    const [, surfaces, cols] = shape, b = n - 1, scale = v!.layers!.scale;
    return Array.from({ length: surfaces }, (_, k) => {
      const parts: string[] = [];
      let open = false;
      for (let c = 0; c < cols; c++) {
        const h = L[(b * surfaces + k) * cols + c];
        if (h < 0) { open = false; continue; }
        parts.push(`${open ? "L" : "M"}${c + 0.5},${(h / scale).toFixed(1)}`);
        open = true;
      }
      return parts.join(" ");
    });
  }, [layersQ.data, v, n, s]);

  if (q.error) return <Drawer wide title="OCT scan" onClose={onClose}><ErrorNotice error={q.error} /></Drawer>;
  if (!s || !v) return <Drawer wide title="OCT scan" onClose={onClose}><Loading /></Drawer>;
  const sp = v.spacing ?? s.spacing;
  const widthMm = sp ? s.cols * sp.lateralMm : null, depthMm = sp ? s.rows * sp.axialMm : null;
  const aspect = widthMm && depthMm ? `${widthMm} / ${depthMm * depth}` : `${s.cols} / ${s.rows}`;
  const filter = `brightness(${bright}%) contrast(${contrast}%)`;
  const clickPhoto = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!lines || !photo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * photo.width, py = ((e.clientY - r.top) / r.height) * photo.height;
    let best = 0, bestD = Infinity;
    lines.forEach((l, i) => { if (l) { const d = segDist(px, py, l); if (d < bestD) { bestD = d; best = i; } } });
    go(best + 1);
  };
  const many = (lines?.length ?? 0) > 24;      // a cube: draw its outline and the current line, not 320 lines

  return (
    <Drawer wide onClose={onClose} title={`${s.kind === "octa" ? "OCTA" : "OCT"} · ${s.eye ? EYE[s.eye] : "eye not given"}`}
            sub={[protocolWords(s.protocol), s.device, s.capturedAt && stamp(s.capturedAt)].filter(Boolean).join(" · ")}>
      <div className="stack" style={{ gap: "0.8rem" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "0.8rem", alignItems: "start" }}>
          {s.photoId && photo ? (
            <figure style={{ margin: 0, position: "relative" }}>
              <img src={`/api/retina-ai/photos/${s.photoId}/image`} alt="Colour fundus photograph of this exam" style={{ width: "100%", display: "block", borderRadius: 8, background: "#000" }} />
              {lines && <svg viewBox={`0 0 ${photo.width} ${photo.height}`} preserveAspectRatio="none" onClick={clickPhoto}
                             style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair" }} aria-label="Scan lines: click one to show its B-scan">
                {many ? (() => { const a = lines[0]!, z = lines[lines.length - 1]!;
                  return <polygon points={`${a[0]},${a[1]} ${a[2]},${a[3]} ${z[2]},${z[3]} ${z[0]},${z[1]}`} fill="none" stroke="#7fdbff" strokeOpacity={0.7} strokeWidth={photo.width / 400} />; })()
                  : lines.map((l, i) => l && i !== n - 1 && <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="#7fdbff" strokeOpacity={0.55} strokeWidth={photo.width / 500} />)}
                {lines[n - 1] && (() => { const l = lines[n - 1]!; return <line x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="#39ff14" strokeWidth={photo.width / 250} />; })()}
              </svg>}
              <figcaption className="small muted">{lines ? "Green: the B-scan shown. Click a line (or inside the box) to show that B-scan." : "Scan position not given for this exam."}</figcaption>
            </figure>
          ) : <div className="notice">No colour photograph with this scan.</div>}
          <div className="stack" style={{ gap: "0.4rem" }}>
            <div ref={bscanRef} style={{ position: "relative", width: "100%", aspectRatio: aspect, background: "#000", borderRadius: 8, overflow: "hidden" }}
                 aria-label={`B-scan ${n} of ${frames}`}>
              <img src={`/api/oct/studies/${s.id}/bscan/${n}`} alt={`B-scan ${n} of ${frames}`} draggable={false}
                   style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "fill", filter }} />
              {showLayers && layerPaths.length > 0 && <svg viewBox={`0 0 ${s.cols} ${s.rows}`} preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
                {layerPaths.map((d, k) => d && <path key={k} d={d} fill="none" stroke={LAYER_COLOURS[k % LAYER_COLOURS.length]} strokeWidth={1.2} vectorEffect="non-scaling-stroke" opacity={0.85} />)}
              </svg>}
            </div>
            <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <button onClick={() => go(n - 1)} disabled={n <= 1} aria-label="Previous B-scan">◀</button>
              <input type="range" min={1} max={frames} value={n} onChange={(e) => go(Number(e.target.value))} aria-label="B-scan" style={{ flex: 1, minWidth: 140 }} />
              <button onClick={() => go(n + 1)} disabled={n >= frames} aria-label="Next B-scan">▶</button>
              <b className="nowrap">{n} / {frames}</b>
            </div>
            <div className="row small" style={{ gap: "0.8rem", flexWrap: "wrap" }}>
              <label className="row">Depth <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>true shape</option><option value={2}>×2</option><option value={3}>×3</option><option value={4}>×4</option></select></label>
              {v.layers && <label className="row"><input type="checkbox" checked={showLayers} onChange={(e) => setShowLayers(e.target.checked)} /> Layer lines</label>}
              <label className="row">Brightness <input type="range" min={50} max={200} value={bright} onChange={(e) => setBright(Number(e.target.value))} /></label>
              <label className="row">Contrast <input type="range" min={50} max={250} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} /></label>
              <button className="btn-quiet" onClick={() => { setBright(100); setContrast(100); setDepth(3); }}>Reset</button>
            </div>
            {showLayers && v.layers && <div className="small" style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
              {v.layers.labels.map((l, k) => <span key={l} className="nowrap"><span style={{ display: "inline-block", width: 14, height: 3, background: LAYER_COLOURS[k % LAYER_COLOURS.length], verticalAlign: "middle", marginRight: 4 }} />{l}</span>)}
              <span className="muted">Topcon's own segmentation, as exported; not checked by Sudarshan.</span></div>}
          </div>
        </div>

        {q.data?.thickness && <EtdrsGrid t={q.data.thickness} eye={s.eye} checked={q.data.checked} />}

        {v.slabs.length > 0 && <div className="stack" style={{ gap: "0.4rem" }}>
          <b>OCTA en face slabs</b>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.6rem" }}>
            {v.slabs.map((sl) => (
              <figure key={sl.n} style={{ margin: 0 }}>
                <div style={{ position: "relative", aspectRatio: "1", background: "#000", borderRadius: 6, overflow: "hidden", cursor: "crosshair" }}
                     onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); go(((e.clientY - r.top) / r.height) * frames + 0.5); }}
                     title="Click to show the B-scan at that height">
                  <img src={`/api/oct/studies/${s.id}/slab/${sl.n}`} alt={`${sl.label} slab`} style={{ width: "100%", height: "100%", display: "block", filter }} />
                  <div style={{ position: "absolute", left: 0, right: 0, top: `${((n - 0.5) / frames) * 100}%`, height: 1, background: "#39ff14", opacity: 0.8 }} />
                </div>
                <figcaption className="small"><b>{sl.label}</b><div className="muted">{sl.definition.split(",").slice(1).join(" to ").trim()}</div></figcaption>
              </figure>))}
          </div>
        </div>}

        <div className="small muted">
          {[`${frames} B-scan${frames === 1 ? "" : "s"} of ${s.cols} × ${s.rows} pixels`,
            widthMm && depthMm && `${widthMm.toFixed(1)} mm across, ${depthMm.toFixed(2)} mm deep`,
            sp && `${(sp.lateralMm * 1000).toFixed(1)} µm across, ${(sp.axialMm * 1000).toFixed(1)} µm deep per pixel`,
            sp?.betweenMm && `B-scans ${(sp.betweenMm * 1000).toFixed(1)} µm apart`,
            depth !== 1 && `depth shown ×${depth}`].filter(Boolean).join(" · ")}.
          {" "}Use the arrow keys or the mouse wheel over the B-scan to move through the scan. Full review stays in IMAGEnet.
        </div>
      </div>
    </Drawer>
  );
}

/** A day's OCT / OCTA scans of a patient, as buttons that open the viewer (fundus report sessions, patient page). */
export function OctScans({ patientId, date }: { patientId: number; date?: string }) {
  const q = useQuery({ queryKey: ["oct", "list", patientId, date ?? ""], queryFn: () => api<{ studies: OctListItem[] }>(`/oct/studies?patientId=${patientId}${date ? `&date=${date}` : ""}`) });
  const [open, setOpen] = useState<number | null>(null);
  if (!q.data?.studies.length) return null;
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <b>OCT / OCTA scans (Topcon Maestro2)</b>
      <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        {q.data.studies.map((x) => (
          <button key={x.id} onClick={() => setOpen(x.id)} title={`${x.frames} B-scans${x.slabs?.length ? `, ${x.slabs.length} OCTA slabs` : ""}`}>
            {octTitle(x)}{!date && x.capturedAt ? ` · ${stamp(x.capturedAt)}` : ""}
          </button>))}
      </div>
      {open && <OctViewer studyId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
