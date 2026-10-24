// Day prints, as the Google app's Day Overview printed them (D-029):
//   /print?date=&kind=day_consult|day_checkin[&start=HH:MM]  the day list sorted by consult start or check-in time,
//        optionally with consult starts moved by the doctor's late (or early) start
//   /print?date=&kind=poa                                     one table per plan of action (eye left out)
// Every print is recorded on the server (app.print_log). The browser's print dialog opens by itself.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { Dialog, ErrorNotice, Loading } from "../components/ui";
import { niceDate, planItems, stamp, weekdayName } from "../format";

type Kind = "day_consult" | "day_checkin" | "poa";
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** Plan for grouping: items without the eye, joined as the Google app did ("REF / DIL / OCT"). */
export const poaGroup = (p: string | null) => planItems(p).map((x) => x.replace(/\s*\((LE|RE|BE)\)/gi, "").trim()).join(" / ") || "-";
const planShow = (p: string | null) => planItems(p).join(" / ") || "-";

/** Earliest consult start of the day and the shift a doctor start time means (Google app calculateTimeDelay). */
export function delayFor(appts: { consultStart: string | null }[], doctorStart: string) {
  const starts = appts.map((a) => a.consultStart).filter(Boolean) as string[];
  if (!starts.length) return null;
  const earliest = starts.reduce((m, t) => (toMin(t) < toMin(m) ? t : m));
  return { earliest, delay: toMin(doctorStart) - toMin(earliest) };
}

export function delayWords(d: { earliest: string; delay: number }, start: string) {
  return d.delay > 0 ? `Delay of ${d.delay} minutes: the first consult was due at ${d.earliest}, the doctor starts at ${start}. Every consult start moves ${d.delay} minutes later.`
    : d.delay < 0 ? `Early by ${-d.delay} minutes: the first consult was due at ${d.earliest}, the doctor starts at ${start}. Every consult start moves ${-d.delay} minutes earlier.`
    : `No delay: the doctor starts at ${start}, as planned.`;
}

export function PrintDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const nav = useNavigate();
  const [sort, setSort] = useState<"day_consult" | "day_checkin">("day_consult");
  const [late, setLate] = useState(false);
  const [start, setStart] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const work = async () => {
    setError(null);
    try {
      const r = await api<any>("/print/day", { body: { date, kind: sort, preview: true } });
      const d = delayFor(r.appointments, start);
      setShown(d ? delayWords(d, start) : "No booking that day has a consult start.");
    } catch (e) { setError(e); }
  };
  const go = () => nav(`/print?date=${date}&kind=${sort}${late && start ? `&start=${start}` : ""}`);
  return (
    <Dialog narrow title="Print the day list" onClose={onClose}
      foot={<><span className="grow" /><button className="btn-primary" disabled={late && !start} onClick={go}>Print</button></>}>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small muted">Sort the list by</legend>
        <label className="row"><input type="radio" name="sort" checked={sort === "day_consult"} onChange={() => setSort("day_consult")} />
          <span><b>Consult start</b><div className="small muted">When each patient is due with the doctor</div></span></label>
        <label className="row"><input type="radio" name="sort" checked={sort === "day_checkin"} onChange={() => setSort("day_checkin")} />
          <span><b>Check-in time</b><div className="small muted">The booked slot</div></span></label>
      </fieldset>
      <label className="row" style={{ marginTop: "0.8rem" }}><input type="checkbox" checked={late} onChange={(e) => { setLate(e.target.checked); setShown(null); }} />
        <span><b>Adjust for doctor's late arrival</b><div className="small muted">Move every consult start by the doctor's actual start</div></span></label>
      {late && <div className="row">
        <label className="field"><span>Doctor actually starts at</span>
          <input type="time" step={600} value={start} onChange={(e) => { setStart(e.target.value); setShown(null); }} /></label>
        <button disabled={!start} onClick={() => void work()}>Work out delay</button></div>}
      {shown && <div className="ds-note small">{shown}</div>}
      <ErrorNotice error={error} />
    </Dialog>
  );
}

export function DayPrintPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const date = sp.get("date") ?? "";
  const kind = (sp.get("kind") ?? "day_consult") as Kind;
  const start = sp.get("start");
  const m = useMutation({ mutationFn: (body: any) => api<any>("/print/day", { body }) });
  const [printed, setPrinted] = useState(false);

  const data = m.data;
  const delay = useMemo(() => (data && start ? delayFor(data.appointments, start) : null), [data, start]);
  useEffect(() => { m.mutate({ date, kind, doctorStart: start ?? null, delayMin: null }); }, [date, kind, start]); // eslint-disable-line react-hooks/exhaustive-deps
  // the print dialog opens by itself, unless &noprint=1 (look first, then "Print again")
  const auto = sp.get("noprint") !== "1";
  useEffect(() => { if (data && !printed && auto) { setPrinted(true); setTimeout(() => window.print(), 400); } }, [data, printed, auto]);

  if (m.error) return <ErrorNotice error={m.error} />;
  if (!data) return <Loading />;
  const shift = delay?.delay ?? 0;
  const appts = data.appointments.map((a: any) => ({ ...a,
    shownConsult: a.consultStart && shift ? fromMin(toMin(a.consultStart) + shift) : a.consultStart }));
  const stats = {
    total: appts.length,
    confirmed: appts.filter((a: any) => a.confirmed).length,
    waiting: appts.filter((a: any) => a.status === "waitlist").length,
    // as the Google app counted: a temporary MRD starting N is a new patient, an SPD number an old one
    newP: appts.filter((a: any) => /^N/i.test(a.mrd ?? "")).length,
    oldP: appts.filter((a: any) => /^S/i.test(a.mrd ?? "")).length,
  };
  const planCount = new Map<string, number>();
  for (const a of appts) planCount.set(poaGroup(a.planOfAction), (planCount.get(poaGroup(a.planOfAction)) ?? 0) + 1);
  const key = (t: string | null) => (t ? toMin(t) : 9999);
  const sorted = [...appts].sort((a: any, b: any) => kind === "day_consult" ? key(a.shownConsult) - key(b.shownConsult) || key(a.slotTime) - key(b.slotTime)
                                                                            : key(a.slotTime) - key(b.slotTime));
  const groups = kind === "poa" ? [...appts.reduce((g: Map<string, any[]>, a: any) => g.set(poaGroup(a.planOfAction), [...(g.get(poaGroup(a.planOfAction)) ?? []), a]), new Map()).entries()]
    .map(([plan, list]) => ({ plan, list: list.sort((a: any, b: any) => key(a.slotTime) - key(b.slotTime)) }))
    .sort((a, b) => key(a.list[0].slotTime) - key(b.list[0].slotTime)) : [];

  const table = (list: any[], withOriginal: boolean) => (
    <table className="print-table">
      <thead><tr><th>No.</th><th>Check-in</th><th>Consult start</th>{withOriginal && <th>Planned consult</th>}<th>MRD</th><th>Patient</th><th>Age</th>
        <th>Sex</th><th>Phone</th><th>Type</th><th>Visit type</th><th>Doctor</th><th>Plan of action</th><th>Remarks</th></tr></thead>
      <tbody>{list.map((a, i) => (
        <tr key={a.id}><td>{i + 1}</td><td>{a.slotTime ?? (a.status === "waitlist" ? "Waitlist" : "-")}</td>
          <td className={withOriginal && a.consultStart ? "moved" : ""}>{a.shownConsult ?? "-"}</td>
          {withOriginal && <td className="struck">{a.consultStart ?? "-"}</td>}
          <td>{a.mrd ?? "-"}</td><td>{a.patientName}</td><td>{a.ageText ?? a.ageYears ?? "-"}</td><td>{a.gender ?? "-"}</td><td>{a.phone ?? "-"}</td>
          <td>{a.patientType ?? "-"}</td><td>{a.appointmentType ?? "-"}</td><td>{a.doctorName ?? "-"}</td><td>{planShow(a.planOfAction)}</td><td>{a.remarks ?? "-"}</td></tr>))}
      </tbody>
    </table>);

  const byLevel = (lv: string) => data.findings.filter((f: any) => f.level === lv);
  const nameOf = (id: number) => appts.find((a: any) => a.id === id);
  return (
    <div className="day-print">
      <style>{"@page { size: A4 landscape; margin: 10mm; }"}</style>
      <div className="row no-print" style={{ marginBottom: "0.8rem" }}>
        <button onClick={() => nav(-1)}>Back</button><button className="btn-primary" onClick={() => window.print()}>Print again</button>
        <span className="muted small">This print is recorded in Sudarshan.</span></div>
      <header className="print-head">
        <h1>Appointments for {weekdayName(date, true)}, {niceDate(date, true)}</h1>
        <p>{kind === "poa" ? "Grouped by plan of action" : `Sorted by ${kind === "day_consult" ? "consult start" : "check-in time"}`}</p>
        {delay && delay.delay !== 0 && <p className="print-warn">Consult starts moved {Math.abs(delay.delay)} minutes {delay.delay > 0 ? "later: the doctor started late" : "earlier: the doctor started early"} ({start}; first consult was due at {delay.earliest})</p>}
        <p className="small">Printed {stamp(data.printedAt)} by {data.printedBy ?? user?.fullName}</p>
      </header>
      <div className="print-stats">
        <div><b>{stats.total}</b>Total</div><div><b>{stats.confirmed}</b>Confirmed</div><div><b>{stats.waiting}</b>Waiting list</div>
        <div><b>{stats.newP}</b>New</div><div><b>{stats.oldP}</b>Old</div></div>
      <h2>Plan of action</h2>
      <div className="print-plans">{[...planCount.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => <div key={p}><span>{p}</span><b>{n}</b></div>)}</div>
      {kind === "poa" ? groups.map((g) => <section key={g.plan}><h3>Plan of action: {g.plan} ({g.list.length})</h3>{table(g.list, false)}</section>)
        : table(sorted, !!delay && delay.delay !== 0)}
      {kind !== "poa" && (data.findings.length > 0 || data.specialCases.length > 0) && (
        <section className="print-rules">
          <h2>Scheduling rule notes</h2>
          <p className="small">{byLevel("error").length} against the rules, {byLevel("warning").length} to check, {byLevel("info").length} notes; worked out by Sudarshan's rules</p>
          {data.specialCases.length > 0 && <>
            <h3>Special cases ({data.specialCases.length})</h3>
            <table className="print-table"><thead><tr><th>Patient</th><th>Time</th><th>Type</th></tr></thead>
              <tbody>{data.specialCases.map((s: any) => { const a = nameOf(s.id); return (
                <tr key={s.id}><td>{a?.patientName ?? "-"}</td><td>{a?.slotTime ?? "-"}</td><td>{s.types.join(", ")}</td></tr>); })}</tbody></table></>}
          {[["error", "Against the rules"], ["warning", "To check"], ["info", "Notes"]].map(([lv, words]) => byLevel(lv).length > 0 && (
            <div key={lv} className={`print-rule-group ${lv}`}><h3>{words} ({byLevel(lv).length})</h3>
              <ul>{byLevel(lv).map((f: any, i: number) => <li key={i}>{f.message}{f.suggestion && <div className="small">{f.suggestion}</div>}</li>)}</ul></div>))}
        </section>)}
    </div>
  );
}
