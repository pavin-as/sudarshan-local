// Follow-up calls: patients Yarago says should have come back, one card per team (ROP, injection, laser, ...).
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { addDays, niceDate, stamp, todayIST } from "../format";
import { Dialog, ErrorNotice, Loading, useToast } from "../components/ui";
import { BookDialog } from "../components/BookDialog";

const ACTIONS: [string, string][] = [
  ["will_come", "Will come (no date yet)"], ["no_answer", "No answer"], ["called", "Spoke, undecided"], ["declined", "Does not want to come"],
  ["wrong_number", "Wrong number"], ["moved_away", "Moved away / treated elsewhere"], ["not_needed", "Doctor says not needed"],
  ["deceased", "Deceased"], ["note", "Just a note"],
];
const WORDS = Object.fromEntries([...ACTIONS, ["booked", "Booked"]]);

interface FuPatient { patientId: number; name: string; mrd: string; mobile: string | null; followupId?: number; reasons?: string[] }

export function FollowupLogForm({ patient, onClose }: { patient: FuPatient; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [action, setAction] = useState("no_answer");
  const [note, setNote] = useState("");
  const [next, setNext] = useState(addDays(todayIST(), 2));
  const [error, setError] = useState<unknown>(null);
  const [book, setBook] = useState(false);
  const wantsNext = ["no_answer", "called", "will_come"].includes(action);
  const save = async () => {
    try {
      await api(`/followups/${patient.patientId}/actions`, { body: { action, note: note || undefined, nextCallOn: wantsNext ? next : undefined, followupId: patient.followupId } });
      toast(`Saved: ${patient.name}, ${WORDS[action]}`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); }
  };
  if (book) return <BookDialog preset={{ date: addDays(todayIST(), 1), source: "followup", sourceRef: patient.followupId ? String(patient.followupId) : undefined,
    patient: { patientId: patient.patientId, mrd: patient.mrd, name: patient.name, mobile: patient.mobile, ageYears: null, sex: null, lastVisit: null } }}
    onClose={onClose}
    onBooked={async (id) => { await api(`/followups/${patient.patientId}/actions`, { body: { action: "booked", appointmentId: id, followupId: patient.followupId } }).catch(() => {}); await qc.invalidateQueries(); }} />;
  return (
    <Dialog narrow title={`Call ${patient.name}`} onClose={onClose}
      foot={<><button onClick={() => setBook(true)}>Book appointment instead</button><span className="grow" /><button className="btn-primary" onClick={() => void save()}>Save call</button></>}>
      <div className="muted">{patient.mrd}{patient.mobile && <>, <a href={`tel:${patient.mobile}`}>{patient.mobile}</a></>}</div>
      {patient.reasons && patient.reasons.length > 0 && <div className="small">{patient.reasons.map((r) => <span key={r} className="tag">{r}</span>)}</div>}
      <label className="field"><span>What happened</span>
        <select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {wantsNext && <label className="field"><span>Call again on</span><input type="date" value={next} min={todayIST()} onChange={(e) => setNext(e.target.value)} /></label>}
      <label className="field"><span>Note</span><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></label>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

export function FollowupsPage() {
  const { can } = useAuth();
  const [view, setView] = useState<"to_call" | "upcoming" | "all_overdue">("to_call");
  const [days, setDays] = useState(90);
  const [group, setGroup] = useState<string | null>(null);
  const [calling, setCalling] = useState<FuPatient | null>(null);
  const q = useQuery({
    queryKey: ["followups", view, days, group],
    queryFn: () => api<any>(`/followups?view=${view}&maxOverdueDays=${days}&limit=500${group ? `&group=${group}` : ""}`),
  });
  const labels: Record<string, string> = Object.fromEntries((q.data?.groups ?? []).map((g: any) => [g.key, g.label]));
  const rows: any[] = q.data?.followups ?? [];
  const inList: number | undefined = group ? q.data?.groups.find((g: any) => g.key === group)?.count : q.data?.total;
  const viewWords = { to_call: "To call", upcoming: "Due this week", all_overdue: "All overdue" }[view];
  return (
    <div className="fu-print">
      <div className="print-only fu-print-head">
        <h1>Follow-up calls: {group ? labels[group] : "All patients"}</h1>
        <div>{viewWords}{view === "to_call" && ` (overdue up to ${days} days; ROP babies however long)`}. Printed {niceDate(todayIST(), true)}.
          {" "}{rows.length} patient{rows.length === 1 ? "" : "s"}{inList != null && inList > rows.length ? ` of ${inList} (the first ${rows.length})` : ""}.</div>
      </div>
      <div className="page-head no-print">
        <div><h1>Follow-up calls</h1>
          <div className="muted">Patients who were asked to come back. Pick your team's card. Once booked or closed they leave this list.</div></div>
        <span className="grow" />
        <button onClick={() => window.print()} disabled={!rows.length} title="Print the list below, or choose Save as PDF in the print window">Print</button>
        <div className="seg" role="group" aria-label="Which patients">
          <button aria-pressed={view === "to_call"} onClick={() => setView("to_call")}>To call</button>
          <button aria-pressed={view === "upcoming"} onClick={() => setView("upcoming")}>Due this week</button>
          <button aria-pressed={view === "all_overdue"} onClick={() => setView("all_overdue")}>All overdue</button>
        </div>
        {view === "to_call" && (
          <label className="row small">Overdue up to
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>)}
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.data && (
        <div className="fu-tiers no-print" role="group" aria-label="Team">
          <button className="fu-tier all" aria-pressed={group === null} onClick={() => setGroup(null)}>
            <span className="fu-n">{q.data.total}</span><span>All patients</span>
            <span className="small">each counted once</span>
          </button>
          {q.data.groups.map((g: any) => (
            <button key={g.key} className={`fu-tier g-${g.key}`} aria-pressed={group === g.key} title={g.rule} onClick={() => setGroup(group === g.key ? null : g.key)}>
              <span className="fu-n">{g.count}</span><span>{g.label}</span>
              <span className="small">{g.notCalled} not called yet</span>
            </button>))}
          <div className="fu-tier plain"><span className="fu-n">{q.data.cameBackAfterCall30d}</span><span>came back after a call</span><span className="small">in the last 30 days</span></div>
        </div>)}
      {group && q.data && <p className="small muted fu-rule" style={{ margin: "-0.4rem 0 0.8rem" }}>
        <b>{labels[group]}</b>: {q.data.groups.find((g: any) => g.key === group)?.rule}.</p>}
      <div className="panel">
        {q.isLoading ? <Loading /> : rows.length === 0 ? <div className="empty">Nobody to call in this list.</div> : (
          <table className="list">
            <thead><tr><th>Group</th><th>Patient</th><th>Due</th><th>Last visit</th><th>Last call</th><th className="no-print" /></tr></thead>
            <tbody>{rows.map((f) => (
              <tr key={f.patientId} className="fu-row">
                <td>{f.groups.map((g: string) => <div key={g}><span className={`fu-badge g-${g}`}>{labels[g] ?? g}</span></div>)}</td>
                <td><Link to={`/patients/${f.patientId}`}><b>{f.name}</b></Link> <span className="muted small">{f.mrd}</span>
                  {f.reasons.length > 0 && <div className="small">{f.reasons.map((r: string) => <span key={r} className="tag">{r}</span>)}</div>}
                  {f.mobile && <div className="small"><a href={`tel:${f.mobile}`}>{f.mobile}</a></div>}</td>
                <td className="nowrap">{niceDate(f.dueDate, true)}{f.daysOverdue > 0 && <div className="overdue small">{f.daysOverdue} days overdue</div>}</td>
                <td className="nowrap">{niceDate(f.fromVisitDate, true)}{f.doctor && <div className="small muted">{f.doctor}</div>}</td>
                <td className="small">{f.lastAction ? <><b>{WORDS[f.lastAction] ?? f.lastAction}</b>, {stamp(f.lastActionAt)}{f.lastNote && <div className="muted">{f.lastNote}</div>}</> : <span className="muted">not called yet</span>}
                  {f.appointmentDate && <div>Booked for {niceDate(f.appointmentDate)}</div>}</td>
                <td className="right no-print">{can("followups.write") && <button className="btn-small" onClick={() => setCalling({ patientId: f.patientId, name: f.name, mrd: f.mrd, mobile: f.mobile, followupId: f.followupId, reasons: f.reasons })}>Call</button>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      <p className="small muted no-print" style={{ marginTop: "0.6rem" }}>Each card is one team's list. A patient can be on more than one card (for example an injection patient who
        also has diabetic retinopathy), so the cards do not add up to "All patients". Hover a card to see its rule. ROP babies show however long overdue (they leave after
        a mature retina or 12 months without an ROP visit) and the longest overdue come first; other lists are limited by "Overdue up to" and show the most recently
        overdue first. The condition comes from the latest examination findings, grouped as in the dashboards.</p>
      {calling && <FollowupLogForm patient={calling} onClose={() => setCalling(null)} />}
    </div>
  );
}
