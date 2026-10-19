// Triage: how urgently a patient who calls or walks in needs to be seen. Seven questions; the most serious answer
// decides (Emergency / Urgent / Not urgent). Then book the patient or record what was decided.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { addDays, stamp, todayIST } from "../format";
import { Dialog, ErrorNotice, Loading, useToast } from "../components/ui";
import { BookDialog } from "../components/BookDialog";
import { PatientPicker, type PickedPatient } from "../components/PatientPicker";

interface Question { key: string; text: string; options: { score: 1 | 2 | 3; label: string }[] }
interface Assessment {
  id: number; patientId: number | null; mrd: string | null; patientName: string; phone: string | null; ageYears: number | null; gender: string | null;
  assessedAt: string; assessedBy: string; answers: Record<string, number>; maxScore: number; category: string;
  decision: string; decisionRemarks: string | null; decisionBy: string | null; decisionAt: string | null;
}
type View = "pending" | "decided" | "all";

const SCORE_WORDS = { 3: "Serious", 2: "Moderate", 1: "Mild" } as const;
const ADVICE: Record<string, string> = {
  Emergency: "See today, as soon as possible.",
  Urgent: "See within a day or two.",
  "Not Urgent": "A routine appointment is fine.",
};

export function useTriageMeta() {
  return useQuery({ queryKey: ["triage-questions"], staleTime: Infinity,
    queryFn: () => api<{ questions: Question[]; decisions: string[] }>("/triage/questions") });
}
export function useTriage(view: View, search = "") {
  return useQuery({ queryKey: ["triage", view, search],
    queryFn: () => api<{ assessments: Assessment[]; pending: number }>(`/triage?view=${view}${search ? `&q=${encodeURIComponent(search)}` : ""}`) });
}

function CategoryTag({ c }: { c: string }) {
  return <span className={`tag ${c === "Emergency" ? "alert" : c === "Urgent" ? "vip" : ""}`}>{c === "Not Urgent" ? "Not urgent" : c}</span>;
}

function score(answers: Record<string, number>) {
  const max = Math.max(0, ...Object.values(answers));
  return max === 3 ? "Emergency" : max === 2 ? "Urgent" : max === 1 ? "Not Urgent" : null;
}

function AssessDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (a: Assessment) => void }) {
  const meta = useTriageMeta();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [np, setNp] = useState({ name: "", phone: "", age: "", gender: "" });
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qs = meta.data?.questions ?? [];
  const done = qs.length > 0 && qs.every((q) => answers[q.key]);
  const result = done ? score(answers) : null;
  const save = async () => {
    setError(null); setBusy(true);
    try {
      if (!patient && !(isNew && np.name.trim())) throw new Error("Choose the patient from Yarago, or enter a new patient's name");
      const r = await api<{ assessment: Assessment }>("/triage", { body: { answers, ...(patient ? { patientId: patient.patientId }
        : { patientName: np.name.trim(), phone: np.phone.trim() || null, ageYears: np.age ? Number(np.age) : null, gender: np.gender || null }) } });
      onSaved(r.assessment);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog title="New triage assessment" onClose={onClose}
      foot={<><button onClick={onClose}>Cancel</button><span className="grow" />
        {result && <span className="small"><CategoryTag c={result} /> {ADVICE[result]}</span>}
        <button className="btn-primary" disabled={!done || busy} onClick={() => void save()}>Save assessment</button></>}>
      <section className="stack">
        <h3>Patient</h3>
        {patient ? (
          <div className="chosen"><div className="grow"><b>{patient.name}</b> <span className="muted">{patient.mrd}{patient.mobile && `, ${patient.mobile}`}</span></div>
            <button className="btn-small" onClick={() => setPatient(null)}>Change</button></div>
        ) : isNew ? (
          <div className="fields">
            <label className="field wide"><span>Name</span><input value={np.name} autoFocus onChange={(e) => setNp({ ...np, name: e.target.value })} /></label>
            <label className="field"><span>Phone</span><input value={np.phone} inputMode="tel" onChange={(e) => setNp({ ...np, phone: e.target.value })} /></label>
            <label className="field"><span>Age</span><input value={np.age} inputMode="numeric" onChange={(e) => setNp({ ...np, age: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="field"><span>Gender</span>
              <select value={np.gender} onChange={(e) => setNp({ ...np, gender: e.target.value })}><option value="" /><option>Female</option><option>Male</option><option>Other</option></select></label>
            <div className="wide"><button className="btn-quiet" onClick={() => setIsNew(false)}>Search Yarago instead</button></div>
          </div>
        ) : (
          <><PatientPicker onPick={setPatient} autoFocus />
            <div><button className="btn-quiet" onClick={() => setIsNew(true)}>New patient, not in Yarago yet</button></div></>
        )}
      </section>
      {meta.isLoading ? <Loading /> : qs.map((q, i) => (
        <fieldset key={q.key} className="triage-q">
          <legend><span className="q-num">{i + 1}</span>{q.text}</legend>
          <div className="triage-options">{q.options.map((o) => (
            <label key={o.score} className={`triage-option s${o.score} ${answers[q.key] === o.score ? "on" : ""}`}>
              <input type="radio" name={q.key} checked={answers[q.key] === o.score} onChange={() => setAnswers({ ...answers, [q.key]: o.score })} />
              <span className="grow">{o.label}</span><span className="small muted">{SCORE_WORDS[o.score]}</span>
            </label>))}</div>
        </fieldset>))}
      <ErrorNotice error={error} />
    </Dialog>
  );
}

function DecisionDialog({ a, onClose, onBook }: { a: Assessment; onClose: () => void; onBook: () => void }) {
  const meta = useTriageMeta();
  const toast = useToast();
  const qc = useQueryClient();
  const [decision, setDecision] = useState(a.decision === "Pending Action" ? "Declined: Wanted Today Only" : a.decision);
  const [remarks, setRemarks] = useState(a.decisionRemarks ?? "");
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/triage/${a.id}/decision`, { body: { decision, remarks: remarks.trim() || null } });
      toast(`Decision saved for ${a.patientName}`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Dialog narrow title={`${a.patientName}: what was decided?`} onClose={onClose}
      foot={<><button onClick={onBook}>Book appointment</button><span className="grow" /><button className="btn-primary" onClick={() => void save()}>Save decision</button></>}>
      <div><CategoryTag c={a.category} /> <span className="small muted">{ADVICE[a.category]}</span></div>
      <label className="field"><span>Decision</span>
        <select value={decision} onChange={(e) => setDecision(e.target.value)}>
          {(meta.data?.decisions ?? []).map((d) => <option key={d}>{d}</option>)}</select></label>
      <label className="field"><span>Remarks</span><textarea value={remarks} onChange={(e) => setRemarks(e.target.value)}
        placeholder={decision.startsWith("Other") ? "What was done (required)" : "Optional"} /></label>
      <p className="small muted">Booking from here records "Booked: today / tomorrow / later date" by itself.</p>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

export function TriagePage() {
  const { can } = useAuth();
  const write = can("appointments.write");
  const meta = useTriageMeta();
  const [view, setView] = useState<View>("pending");
  const [search, setSearch] = useState("");
  const [assessing, setAssessing] = useState(false);
  const [deciding, setDeciding] = useState<Assessment | null>(null);
  const [booking, setBooking] = useState<Assessment | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const list = useTriage(view, search.trim());
  const serious = (a: Assessment) => (meta.data?.questions ?? []).filter((q) => (a.answers[q.key] ?? 0) >= Math.max(2, a.maxScore))
    .map((q) => q.options.find((o) => o.score === a.answers[q.key])?.label).filter(Boolean);

  const booked = async (a: Assessment, appointmentId: number) => {
    const r = await api<{ appointment: { date: string } }>(`/appointments/${appointmentId}`);
    await api(`/triage/${a.id}/decision`, { body: { bookedFor: r.appointment.date } });
    await qc.invalidateQueries();
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Triage</h1><div className="muted">How urgently a patient who calls or walks in needs to be seen. The most serious answer decides.</div></div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which assessments">
          <button aria-pressed={view === "pending"} onClick={() => setView("pending")}>Waiting for a decision{list.data && view === "pending" ? ` (${list.data.pending})` : ""}</button>
          <button aria-pressed={view === "decided"} onClick={() => setView("decided")}>Decided</button>
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>All (60 days)</button>
        </div>
        <input type="search" placeholder="Name, MRD or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search assessments" />
        {write && <button className="btn-primary" onClick={() => setAssessing(true)}>New assessment</button>}
      </div>
      {list.error && <ErrorNotice error={list.error} />}
      <div className="panel">
        {list.isLoading ? <Loading /> : !list.data?.assessments.length ? <div className="empty">{view === "pending" ? "Every assessment has a decision." : "Nothing here."}</div> : (
          <table className="list">
            <thead><tr><th>Assessed</th><th>Patient</th><th>Result</th><th>Because</th><th>Decision</th><th /></tr></thead>
            <tbody>{list.data.assessments.map((a) => (
              <tr key={a.id}>
                <td className="nowrap small">{stamp(a.assessedAt)}{a.assessedBy && <div className="muted">{a.assessedBy}</div>}</td>
                <td>{a.patientId ? <Link to={`/patients/${a.patientId}`}><b>{a.patientName}</b></Link> : <b>{a.patientName}</b>}
                  {" "}<span className="muted small">{a.mrd ?? "new"}</span>
                  {a.phone && <div className="small"><a href={`tel:${a.phone}`}>{a.phone}</a></div>}</td>
                <td><CategoryTag c={a.category} /></td>
                <td className="small">{serious(a).join("; ") || <span className="muted">all answers mild</span>}</td>
                <td className="small">{a.decision === "Pending Action" ? <span className="warn-text">waiting</span>
                  : <><b>{a.decision}</b>{a.decisionRemarks && <div>{a.decisionRemarks}</div>}<div className="muted">{a.decisionBy}{a.decisionAt && `, ${stamp(a.decisionAt)}`}</div></>}</td>
                <td className="right">{write && <div className="row actions">
                  <button className="btn-small" onClick={() => setDeciding(a)}>{a.decision === "Pending Action" ? "Decide" : "Change"}</button>
                  {a.decision === "Pending Action" && <button className="btn-small btn-primary" onClick={() => setBooking(a)}>Book</button>}</div>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>

      {assessing && <AssessDialog onClose={() => setAssessing(false)}
        onSaved={(a) => { setAssessing(false); toast(`${a.patientName}: ${a.category === "Not Urgent" ? "not urgent" : a.category}`); void qc.invalidateQueries(); setDeciding(a); }} />}
      {deciding && <DecisionDialog a={deciding} onClose={() => setDeciding(null)} onBook={() => { setBooking(deciding); setDeciding(null); }} />}
      {booking && <BookDialog onClose={() => setBooking(null)} onBooked={(id) => void booked(booking, id)}
        preset={{ date: booking.category === "Emergency" ? todayIST() : addDays(todayIST(), 1),
                  urgency: booking.category === "Not Urgent" ? undefined : booking.category,
                  remarks: `Triage: ${booking.category === "Not Urgent" ? "not urgent" : booking.category.toLowerCase()}`,
                  ...(booking.patientId
                    ? { patient: { patientId: booking.patientId, mrd: booking.mrd ?? "", name: booking.patientName, mobile: booking.phone, ageYears: booking.ageYears, sex: booking.gender, lastVisit: null } }
                    : { newPatient: { name: booking.patientName, phone: booking.phone, ageYears: booking.ageYears, gender: booking.gender } }) }} />}
    </>
  );
}
