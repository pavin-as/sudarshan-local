// "Injection response" (D-050, OCT_PLAN Step 7): for each eye, Sudarshan's central subfield thickness (CST) from the
// Maestro2 scans over time, the injections given (Yarago) and the best corrected vision, on one date axis. CST is
// Sudarshan's own measurement from Topcon's layer lines; until it is checked against IMAGEnet (the Step 7 gate) the chart
// says so. Clinical roles (clinical.read).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { niceDate } from "../format";
import { EYE_COLORS } from "./TrendChart";

interface Point { studyId: number; date: string; eye: "RE" | "LE" | null; kind: string; protocol: string | null; cstIlmBm: number | null; cstIlmRpe: number | null; centre: string }
interface Injection { date: string; eye: string | null; drug: string | null; number: number | null }
interface Vision { date: string; bcvaRe: string | null; bcvaLe: string | null; logmarRe: number | null; logmarLe: number | null }
export interface ThicknessCheck { on: string; definition: string; n: number; biasUm: number; loaUm: [number, number] }
interface Data { points: Point[]; injections: Injection[]; vision: Vision[]; checked: ThicknessCheck | null }

const day = (d: string) => Date.parse(`${d}T00:00:00+05:30`);
/** Back from day() to the clinic's date (not UTC's, which is the evening before). */
const dateOf = (t: number) => new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
export function checkedWords(c: ThicknessCheck | null) {
  return c ? `Checked against IMAGEnet on ${niceDate(c.on, true)} (${c.n} scans, ${c.definition}: Sudarshan ${c.biasUm >= 0 ? "+" : ""}${c.biasUm} µm on average, 95% within ${c.loaUm[0]} to ${c.loaUm[1]} µm).`
           : "Not yet checked against IMAGEnet: read the values as a guide only.";
}

function EyeChart({ eye, d, def }: { eye: "RE" | "LE"; d: Data; def: "cstIlmBm" | "cstIlmRpe" }) {
  const [hover, setHover] = useState<string | null>(null);
  const pts = d.points.filter((p) => p.eye === eye && p[def] != null);
  if (!pts.length) return null;
  const inj = d.injections.filter((i) => i.eye === eye || i.eye === "BE");
  const vis = d.vision.map((v) => ({ date: v.date, logmar: eye === "RE" ? v.logmarRe : v.logmarLe, text: eye === "RE" ? v.bcvaRe : v.bcvaLe }))
    .filter((v) => v.logmar != null);
  const first = Math.min(...pts.map((p) => day(p.date)), ...inj.map((i) => day(i.date)));
  const last = Math.max(...pts.map((p) => day(p.date)), ...inj.map((i) => day(i.date)), first + 86_400_000 * 30);
  const visIn = vis.filter((v) => day(v.date) >= first - 86_400_000 * 30 && day(v.date) <= last + 86_400_000);
  const W = 560, H = 190, L = 44, R = 50, T = 14, B = 34;
  const x = (t: number) => L + ((t - first) / Math.max(last - first, 1)) * (W - L - R);
  const vals = pts.map((p) => p[def]!);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 40) { const m = (hi + lo) / 2; lo = m - 20; hi = m + 20; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const vy = (v: number) => T + ((v - -0.1) / (1.5 - -0.1)) * (H - T - B);       // logMAR 1.5 (poor) low, -0.1 high
  const colour = eye === "RE" ? EYE_COLORS.re : EYE_COLORS.le;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(day(p.date)).toFixed(1)},${y(p[def]!).toFixed(1)}`).join("");
  const vline = visIn.map((v, i) => `${i ? "L" : "M"}${x(day(v.date)).toFixed(1)},${vy(v.logmar!).toFixed(1)}`).join("");
  const ticks = [0, 1, 2, 3].map((i) => lo + (i / 3) * (hi - lo));
  const h = hover ? pts.find((p) => p.date === hover) ?? null : null;
  const hInj = hover ? inj.filter((i) => i.date === hover) : [];
  const hVis = hover ? visIn.find((v) => v.date === hover) : null;
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="row small" style={{ justifyContent: "space-between" }}>
        <b>{eye === "RE" ? "Right eye" : "Left eye"}: central subfield thickness</b>
        <span className="legend"><span><i style={{ background: colour }} />CST (µm)</span><span><i style={{ background: "var(--oct)" }} />injection</span>{vis.length > 0 && <span><i style={{ background: "var(--ink-soft)" }} />vision (logMAR, dashed)</span>}</span>
      </figcaption>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${eye} central subfield thickness over ${pts.length} scans, with ${inj.length} injections`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => <g key={i}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" /><text x={L - 6} y={y(t) + 4} textAnchor="end">{Math.round(t)}</text></g>)}
        <text x={L} y={H - 6}>{niceDate(dateOf(first), true)}</text>
        <text x={W - R} y={H - 6} textAnchor="end">{niceDate(dateOf(last), true)}</text>
        {inj.map((i, k) => <g key={`i${k}`} onMouseEnter={() => setHover(i.date)}>
          <line x1={x(day(i.date))} x2={x(day(i.date))} y1={T} y2={H - B} stroke="var(--oct)" strokeOpacity={0.35} strokeDasharray="3 3" />
          <path d={`M${x(day(i.date)) - 5},${H - B + 10} L${x(day(i.date)) + 5},${H - B + 10} L${x(day(i.date))},${H - B + 2} Z`} fill="var(--oct)" />
        </g>)}
        {vline && <path d={vline} fill="none" stroke="var(--ink-soft)" strokeWidth={1.5} strokeDasharray="5 4" />}
        <path d={line} fill="none" stroke={colour} strokeWidth={2} />
        {pts.map((p) => <circle key={p.studyId} cx={x(day(p.date))} cy={y(p[def]!)} r={hover === p.date ? 5.5 : 4} fill={colour} stroke="#fff" strokeWidth={2}
                                 onMouseEnter={() => setHover(p.date)} />)}
      </svg>
      <div className="small muted" style={{ minHeight: "1.3em" }}>
        {hover ? [niceDate(hover, true), h && `CST ${h[def]} µm (${h.kind === "cube" ? "3D cube" : "radial scan"})`,
                  ...hInj.map((i) => `injection${i.number ? ` ${i.number}` : ""}${i.drug ? ` (${i.drug})` : ""}`), hVis && `vision ${hVis.text}`].filter(Boolean).join(" · ")
               : `${pts.length} scan${pts.length === 1 ? "" : "s"}, ${inj.length} injection${inj.length === 1 ? "" : "s"}. Point at a scan or an injection to see it.`}
      </div>
    </figure>
  );
}

export function InjectionResponse({ patientId }: { patientId: number }) {
  const q = useQuery({ queryKey: ["oct", "thickness", patientId], queryFn: () => api<Data>(`/oct/thickness?patientId=${patientId}`) });
  const [def, setDef] = useState<"cstIlmBm" | "cstIlmRpe">("cstIlmBm");
  if (!q.data?.points.length) return null;
  return (
    <section className="panel panel-pad stack">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <h2 className="grow">OCT thickness and injections</h2>
        <label className="row small">Thickness <select value={def} onChange={(e) => setDef(e.target.value as any)}>
          <option value="cstIlmBm">ILM to BM</option><option value="cstIlmRpe">ILM to OS/RPE</option></select></label>
      </div>
      <EyeChart eye="RE" d={q.data} def={def} />
      <EyeChart eye="LE" d={q.data} def={def} />
      <div className={`small ${q.data.checked ? "muted" : "notice"}`}>
        Sudarshan's measurement from Topcon's layer lines on the Maestro2 scans (central 1 mm). {checkedWords(q.data.checked)}
        {" "}Injections and vision come from Yarago.
      </div>
    </section>
  );
}
