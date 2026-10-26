// EMR completeness per month (D-028): how often each item is recorded in Yarago, by screen, against the SOP targets.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { stamp } from "../format";
import { ErrorNotice, Loading } from "../components/ui";

const SCREENS: [string, string][] = [["optometry", "Optometry screen"], ["doctor", "Doctor screen (doctor's assistant)"], ["injection", "Injection record (counted per injection)"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthWord = (m: string, current: boolean) => `${MONTHS[Number(m.slice(5, 7)) - 1]}${m.slice(5, 7) === "01" ? ` ${m.slice(0, 4)}` : ""}${current ? " (so far)" : ""}`;

function level(pct: number | null, target: number | null) {
  if (pct == null) return "";
  if (pct >= (target ?? 90)) return "good";
  return pct >= 50 ? "mid" : "low";
}

export function EmrCompletenessPage() {
  const [group, setGroup] = useState<"all" | "new" | "review">("all");
  const q = useQuery({ queryKey: ["emr", group], queryFn: () => api<any>(`/emr-completeness?group=${group}&months=6`) });
  const d = q.data;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>EMR completeness</h1>
          <div className="muted">Share of consultations with each item recorded in Yarago, per month. For the team's SOP review; counts only.</div></div>
        <span className="grow" />
        <Link to="/emr-daily">Daily report</Link>
        <div className="seg" role="group" aria-label="Which visits">
          <button aria-pressed={group === "all"} onClick={() => setGroup("all")}>All visits</button>
          <button aria-pressed={group === "new"} onClick={() => setGroup("new")}>New patients</button>
          <button aria-pressed={group === "review"} onClick={() => setGroup("review")}>Review visits</button>
        </div>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {!d ? <Loading /> : (
        <div className="panel scroll-x">
          <table className="list emr">
            <thead><tr><th>Item</th>{d.months.map((m: string, i: number) => <th key={m} className="right">{monthWord(m, i === d.months.length - 1)}</th>)}
              <th className="right">Last 12 months</th><th className="right">Target</th></tr></thead>
            {SCREENS.map(([screen, title]) => {
              const items = d.items.filter((it: any) => it.screen === screen);
              if (!items.length) return null;
              return (
                <tbody key={screen}>
                  <tr className="emr-group"><th colSpan={d.months.length + 3}>{title}</th></tr>
                  {items.map((it: any) => (
                    <tr key={it.item}>
                      <td>{it.label}</td>
                      {it.cells.map((c: any) => (
                        <td key={c.month} className={`right emr-cell ${level(c.pct, it.target)}`} title={c.total ? `${c.recorded} of ${c.total}` : "no visits"}>
                          {c.pct == null ? "—" : `${c.pct}%`}</td>))}
                      <td className={`right emr-cell ${level(it.pct12, it.target)}`}><b>{it.pct12 == null ? "—" : `${it.pct12}%`}</b></td>
                      <td className="right muted">{it.target != null ? `${it.target}%` : ""}</td>
                    </tr>))}
                </tbody>);
            })}
          </table>
        </div>)}
      {d && <p className="small muted">Green: at or above the target (90% where no target is set). Amber: 50% or more. Red: below 50%. Hover a cell for the
        counts. Injection and laser appointments are left out of the visit counts: they have no consultation record of their own.
        Recorded means not empty, not "0" and not the word "null". Rebuilt every night{d.updatedAt ? `; last ${stamp(d.updatedAt)}` : ""}.</p>}
    </div>
  );
}
