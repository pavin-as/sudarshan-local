// EMR daily report (D-051): one day's consultations by MRD with the EMR completeness items not recorded in Yarago,
// one screen at a time (optometry for the optometrists, doctor screen for the doctor). Week 1 is for the team: no
// login or person is shown. From 17:30 the list is what was missing then; items saved afterwards show as done later.
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { clock, niceDate, stamp, todayIST, weekdayName } from "../format";
import { ErrorNotice, Loading } from "../components/ui";

type Screen = "optometry" | "doctor";
interface Item { screen: Screen; item: string; label: string; position: number }
interface Visit {
  visitId: number; time: string; statusId: number; isNew: boolean; missing: string[]; mrd: string | null;
  atReport: { statusId: number; missing: string[] } | null;
}
interface Daily { date: string; at: string; takenAt: string | null; syncedAt: string | null; items: Item[]; visits: Visit[] }

const SCREEN_WORDS: Record<Screen, string> = { optometry: "Optometry screen", doctor: "Doctor screen" };
const OPEN_WORDS: Record<number, string> = { 1: "Checked in", 2: "In examination" };

export function EmrDailyPage() {
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIST();
  const screen: Screen = params.get("screen") === "doctor" ? "doctor" : "optometry";
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }); };
  const q = useQuery({ queryKey: ["emr-daily", date], queryFn: () => api<Daily>(`/emr-daily?date=${date}`), refetchInterval: 150_000 });
  const d = q.data;

  const items = (d?.items ?? []).filter((i) => i.screen === screen).sort((a, b) => a.position - b.position);
  const mine = new Set(items.map((i) => i.item));
  const label = new Map(items.map((i) => [i.item, i.label]));
  const done = (d?.visits ?? []).filter((v) => v.statusId === 3);
  const open = (d?.visits ?? []).filter((v) => v.statusId !== 3);
  // what counts: what was missing when the report was taken (for visits completed by then), else what is missing now
  const judged = (v: Visit) => (d?.takenAt && v.atReport?.statusId === 3 ? v.atReport.missing : v.missing).filter((k) => mine.has(k));
  const now = (v: Visit) => v.missing.filter((k) => mine.has(k));
  const rows = done.map((v) => ({ v, judged: judged(v), now: now(v), later: !!d?.takenAt && v.atReport?.statusId !== 3 }))
                   .filter((r) => r.judged.length || r.now.length);
  const complete = done.length - done.filter((v) => judged(v).length).length;
  const missedCount = items.map((i) => ({ ...i, n: done.filter((v) => judged(v).includes(i.item)).length }))
                           .filter((i) => i.n).sort((a, b) => b.n - a.n || a.position - b.position);
  const isToday = date === todayIST();

  return (
    <div className="stack emr-daily">
      <div className="page-head">
        <div>
          <h1>EMR daily report: {SCREEN_WORDS[screen]}</h1>
          <div className="muted">{weekdayName(date, true)}, {niceDate(date, true)}{d && <> · {d.takenAt
            ? `report taken ${clock(d.takenAt)}`
            : isToday && clock(new Date().toISOString()) < d.at ? `report is taken at ${d.at}; until then the list changes as work is saved`
            : "no report was kept for this day: the current state is shown"}</>}</div>
        </div>
        <span className="grow" />
        <div className="seg no-print" role="group" aria-label="Screen">
          {(["optometry", "doctor"] as Screen[]).map((s) =>
            <button key={s} aria-pressed={screen === s} onClick={() => set("screen", s)}>{SCREEN_WORDS[s]}</button>)}
        </div>
        <input className="no-print" type="date" value={date} max={todayIST()} onChange={(e) => e.target.value && set("date", e.target.value)} aria-label="Day" />
        <button className="btn-primary no-print" onClick={() => window.print()} disabled={!d}>Print</button>
        <Link className="no-print" to="/emr-completeness">Monthly figures</Link>
      </div>

      {q.error && <ErrorNotice error={q.error} />}
      {!d ? <Loading /> : !d.visits.length ? <div className="panel empty">No consultations {isToday ? "yet today" : "on this day"}.</div> : <>
        <section className="emr-daily-summary">
          <span><b>{done.length}</b> consultations completed</span>
          <span className="ok-word"><b>{complete}</b> with everything recorded</span>
          <span className={done.length - complete ? "miss-word" : ""}><b>{done.length - complete}</b> with something missing</span>
          {!!open.length && <span><b>{open.length}</b> not marked complete in Yarago</span>}
        </section>

        {!!missedCount.length && (
          <section className="panel scroll-x">
            <h2 className="emr-daily-h">Most missed</h2>
            <table className="list">
              <thead><tr><th>Item</th><th className="right">Missed</th><th className="right">Recorded</th></tr></thead>
              <tbody>{missedCount.map((i) => (
                <tr key={i.item}><td>{i.label}</td><td className="right">{i.n} of {done.length}</td>
                  <td className="right">{Math.round((100 * (done.length - i.n)) / done.length)}%</td></tr>))}</tbody>
            </table>
          </section>)}

        <section className="panel scroll-x">
          <h2 className="emr-daily-h">Consultations with something not recorded</h2>
          {!rows.length ? <div className="empty">Everything was recorded for every completed consultation.</div> : (
            <table className="list">
              <thead><tr><th>Time</th><th>MRD</th><th>Visit</th><th>Not recorded</th></tr></thead>
              <tbody>{rows.map(({ v, judged: j, now: n, later }) => (
                <tr key={v.visitId}>
                  <td>{v.time}</td>
                  <td><b>{v.mrd ?? "—"}</b></td>
                  <td>{v.isNew ? "New" : "Review"}{later && <div className="small muted">completed after {d.at}</div>}</td>
                  <td>
                    {[...new Set([...j, ...n])].sort((a, b) => items.findIndex((i) => i.item === a) - items.findIndex((i) => i.item === b)).map((k) =>
                      n.includes(k)
                        ? <span key={k} className="tag alert">{label.get(k)}</span>
                        : <span key={k} className="tag emr-later" title="Recorded after the report was taken">{label.get(k)} · added later</span>)}
                  </td>
                </tr>))}</tbody>
            </table>)}
        </section>

        {!!open.length && (
          <section className="panel scroll-x">
            <h2 className="emr-daily-h">Not marked complete in Yarago</h2>
            <p className="small muted emr-daily-note">Not counted above. Mark the visit complete in Yarago once the patient has left.</p>
            <table className="list">
              <thead><tr><th>Time</th><th>MRD</th><th>Visit</th><th>Yarago status</th><th>Not recorded so far</th></tr></thead>
              <tbody>{open.map((v) => (
                <tr key={v.visitId}><td>{v.time}</td><td><b>{v.mrd ?? "—"}</b></td><td>{v.isNew ? "New" : "Review"}</td>
                  <td>{OPEN_WORDS[v.statusId] ?? `Status ${v.statusId}`}</td>
                  <td>{now(v).map((k) => <span key={k} className="tag">{label.get(k)}</span>)}</td></tr>))}</tbody>
            </table>
          </section>)}

        <p className="small muted">Every item is expected at every consultation, new or review (the items of the EMR completeness page).
          Recorded means not empty, not "0" and not the word "null". Injection and laser appointments are left out.
          {d.takenAt && <> Counts are as at {clock(d.takenAt)}; items saved after that show as "added later".</>}
          {d.syncedAt && <> Yarago data as of {stamp(d.syncedAt)}.</>}</p>
      </>}
    </div>
  );
}
