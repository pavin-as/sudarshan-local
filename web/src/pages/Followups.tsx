// Follow-up calls: patients Yarago says should have come back, ranked by clinical risk, with a call script.
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

interface FuPatient { patientId: number; name: string; mrd: string; mobile: string | null; followupId?: number; script?: string; reasons?: string[] }

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
      {patient.script && <div className="fu-script"><div className="small muted">What to say</div>{patient.script}</div>}
      <label className="field"><span>What happened</span>
        <select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {wantsNext && <label className="field"><span>Call again on</span><input type="date" value={next} min={todayIST()} onChange={(e) => setNext(e.target.value)} /></label>}
      <label className="field"><span>Note</span><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></label>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

const TIER_SHORT: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Monitor", 4: "Routine" };

export function FollowupsPage() {
  const { can } = useAuth();
  const [view, setView] = useState<"to_call" | "upcoming" | "all_overdue">("to_call");
  const [days, setDays] = useState(90);
  const [tier, setTier] = useState<number | null>(null);
  const [calling, setCalling] = useState<FuPatient | null>(null);
  const q = useQuery({
    queryKey: ["followups", view, days, tier],
    queryFn: () => api<any>(`/followups?view=${view}&maxOverdueDays=${days}&limit=300${tier ? `&tier=${tier}` : ""}`),
  });
  const rows: any[] = q.data?.followups ?? [];
  return (
    <>
      <div className="page-head">
        <div><h1>Follow-up calls</h1>
          <div className="muted">Patients who were asked to come back, most at risk first. Once booked or closed they leave this list.</div></div>
        <span className="grow" />
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
        <div className="fu-tiers" role="group" aria-label="Risk">
          {q.data.tiers.map((t: any) => (
            <button key={t.tier} className={`fu-tier t${t.tier}`} aria-pressed={tier === t.tier} onClick={() => setTier(tier === t.tier ? null : t.tier)}>
              <span className="fu-n">{t.count}</span><span>{t.words}</span>
              <span className="small">{t.notCalled} not called yet</span>
            </button>))}
          <div className="fu-tier plain"><span className="fu-n">{q.data.cameBackAfterCall30d}</span><span>came back after a call</span><span className="small">in the last 30 days</span></div>
        </div>)}
      <div className="panel">
        {q.isLoading ? <Loading /> : rows.length === 0 ? <div className="empty">Nobody to call in this list.</div> : (
          <table className="list">
            <thead><tr><th>Risk</th><th>Patient</th><th>Due</th><th>Last visit</th><th>Last call</th><th /></tr></thead>
            <tbody>{rows.map((f) => (
              <tr key={f.patientId} className="fu-row">
                <td><span className={`fu-badge t${f.tier}`} title={f.tierWords}>{TIER_SHORT[f.tier]}</span></td>
                <td><Link to={`/patients/${f.patientId}`}><b>{f.name}</b></Link> <span className="muted small">{f.mrd}</span>
                  {f.reasons.length > 0 && <div className="small">{f.reasons.map((r: string) => <span key={r} className="tag">{r}</span>)}</div>}
                  {f.mobile && <div className="small"><a href={`tel:${f.mobile}`}>{f.mobile}</a></div>}</td>
                <td className="nowrap">{niceDate(f.dueDate, true)}{f.daysOverdue > 0 && <div className="overdue small">{f.daysOverdue} days overdue</div>}</td>
                <td className="nowrap">{niceDate(f.fromVisitDate, true)}{f.doctor && <div className="small muted">{f.doctor}</div>}</td>
                <td className="small">{f.lastAction ? <><b>{WORDS[f.lastAction] ?? f.lastAction}</b>, {stamp(f.lastActionAt)}{f.lastNote && <div className="muted">{f.lastNote}</div>}</> : <span className="muted">not called yet</span>}
                  {f.appointmentDate && <div>Booked for {niceDate(f.appointmentDate)}</div>}</td>
                <td className="right">{can("followups.write") && <button className="btn-small" onClick={() => setCalling({ patientId: f.patientId, name: f.name, mrd: f.mrd, mobile: f.mobile, followupId: f.followupId, script: f.script, reasons: f.reasons })}>Call</button>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      <p className="small muted" style={{ marginTop: "0.6rem" }}>Urgent: an injection in the last 6 months, ROP or retinal detachment. High: laser in the last year, or diabetic
        retinopathy, vein occlusion, AMD and other retinal disease. Monitor: diabetes or a condition to watch. Within each, the most recently overdue first.
        The condition comes from the latest examination findings, grouped as in the dashboards.</p>
      {calling && <FollowupLogForm patient={calling} onClose={() => setCalling(null)} />}
    </>
  );
}
