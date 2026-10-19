// Small line chart for one measure, right eye vs left eye, over visits.
// Colours validated for colour-blind separation (blue #2266cc / orange #c2600e); each line is also
// labelled at its end, and every point has a hover tooltip, so colour never carries meaning alone.
import { useState } from "react";
import { niceDate } from "../format";

export const EYE_COLORS = { re: "#2266cc", le: "#c2600e" };

export interface TrendPoint { date: string; re: number | null; le: number | null; reText?: string | null; leText?: string | null }

export function TrendChart({ title, unit, points, invert, domain }: {
  title: string; unit: string; points: TrendPoint[]; invert?: boolean; domain?: [number, number];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const data = points.filter((p) => p.re != null || p.le != null);
  if (data.length < 2) return <div className="muted small">{title}: not enough visits with a value to draw a trend.</div>;

  const W = 520, H = 170, L = 38, R = 70, T = 12, B = 26;
  const vals = data.flatMap((p) => [p.re, p.le]).filter((v): v is number => v != null);
  let [lo, hi] = domain ?? [Math.min(...vals), Math.max(...vals)];
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const x = (i: number) => L + (i / (data.length - 1)) * (W - L - R);
  // invert: for logMAR, lower is better, so better vision is drawn higher
  const y = (v: number) => invert ? T + ((v - lo) / (hi - lo)) * (H - T - B) : T + ((hi - v) / (hi - lo)) * (H - T - B);
  const ticks = [0, 1, 2, 3].map((i) => lo + (i / 3) * (hi - lo));
  const path = (k: "re" | "le") => {
    let d = "", pen = false;
    data.forEach((p, i) => { const v = p[k]; if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const lastOf = (k: "re" | "le") => { for (let i = data.length - 1; i >= 0; i--) if (data[i][k] != null) return i; return -1; };
  const labelEnd = (k: "re" | "le", text: string) => {
    const i = lastOf(k); if (i < 0) return null;
    return <text x={x(i) + 8} y={y(data[i][k]!) + 4} style={{ fill: "var(--ink)" }}>{text}</text>;
  };
  const fmt = (v: number | null, t?: string | null) => (t ?? (v == null ? "—" : String(Math.round(v * 100) / 100)));
  const h = hover != null ? data[hover] : null;

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="row small" style={{ justifyContent: "space-between" }}>
        <b>{title}</b>
        <span className="legend"><span><i style={{ background: EYE_COLORS.re }} />Right eye</span><span><i style={{ background: EYE_COLORS.le }} />Left eye</span></span>
      </figcaption>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} trend over ${data.length} visits`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line-soft)" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end">{Math.round(t * 10) / 10}</text>
          </g>
        ))}
        <text x={L} y={H - 6}>{niceDate(data[0].date, true)}</text>
        <text x={W - R} y={H - 6} textAnchor="end">{niceDate(data[data.length - 1].date, true)}</text>
        {h && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} stroke="var(--line)" />}
        <path d={path("re")} fill="none" stroke={EYE_COLORS.re} strokeWidth={2} />
        <path d={path("le")} fill="none" stroke={EYE_COLORS.le} strokeWidth={2} />
        {data.map((p, i) => (["re", "le"] as const).map((k) => p[k] != null && (
          <circle key={k + i} cx={x(i)} cy={y(p[k]!)} r={hover === i ? 5 : 3.5} fill={EYE_COLORS[k]} stroke="#fff" strokeWidth={2} />
        )))}
        {labelEnd("re", "RE")}{labelEnd("le", "LE")}
        {/* wide invisible hit targets, one per visit */}
        {data.map((_, i) => (
          <rect key={i} x={x(i) - (W - L - R) / (data.length - 1) / 2} y={T} width={(W - L - R) / (data.length - 1)} height={H - T - B}
            fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      <div className="small muted" style={{ minHeight: "1.3em" }}>
        {h ? <>{niceDate(h.date, true)}: right {fmt(h.re, h.reText)}, left {fmt(h.le, h.leText)} {unit}</> : `Point at a visit to see its values. ${invert ? "Higher on the chart = better vision." : ""}`}
      </div>
    </figure>
  );
}
