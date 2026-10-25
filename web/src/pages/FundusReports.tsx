// Fundus reports (D-042): doctors report Remidio photographs here, per photo session (one patient, one exam), per eye.
// Clinical roles read; doctors write; a correction needs a reason. The research AI grade is never shown on this page.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { niceDate, stamp } from "../format";
import { Drawer, ErrorNotice, Loading, useToast } from "../components/ui";
import { PhotoThumb, PhotoViewer } from "./RetinaAi";

type Words = { DR: Record<string, string>; DME: Record<string, string>; FINDINGS: Record<string, string>; REFERRAL: Record<string, string> };
export interface Session {
  patientId: number; examDate: string; examKey: number; photoIds: number[]; photos: number; lastAt: string; anyPoor: boolean;
  mrd: string; patientName: string; ageYears: number | null; sex: string | null;
  reportId: number | null; summary: string | null; reportedAt: string | null; reportedBy: string | null; amendedAt: string | null;
}
interface SessionPhoto { id: number; eye: "RE" | "LE" | null; field: string | null; quality: string | null; capturedAt: string | null }
interface Report {
  id: number; reDr: string | null; leDr: string | null; reDme: string | null; leDme: string | null; reFindings: string[]; leFindings: string[];
  reOther: string; leOther: string; referral: string; comments: string; reportedAt: string; reportedBy: string;
  amendedAt: string | null; amendedBy: string | null; amendmentReason: string | null;
}
const EYE: Record<string, string> = { RE: "Right eye", LE: "Left eye" };

export function useFundusTodo(enabled: boolean) {
  const r = useQuery({ queryKey: ["fundus", "todo-count"], enabled, refetchInterval: 5 * 60_000,
                       queryFn: () => api<{ todo: number }>("/fundus/sessions?status=todo") });
  return r.data?.todo ?? 0;
}

function SessionRows({ sessions, onOpen, showPatient = true }: { sessions: Session[]; onOpen: (s: Session) => void; showPatient?: boolean }) {
  return (
    <div className="scroll-x"><table className="list">
      <thead><tr><th>Photographs</th><th>Taken</th>{showPatient && <th>Patient</th>}<th>Report</th></tr></thead>
      <tbody>{sessions.map((s) => (
        <tr key={`${s.patientId}-${s.examDate}-${s.examKey}`} className="clickable" onClick={() => onOpen(s)}>
          <td><div className="row" style={{ gap: "0.3rem", flexWrap: "nowrap" }}>{s.photoIds.slice(0, 4).map((id) => <PhotoThumb key={id} id={id} size={56} />)}</div></td>
          <td className="nowrap">{niceDate(s.examDate, true)}<div className="muted small">{s.photos} photograph{s.photos === 1 ? "" : "s"}{s.anyPoor ? ", some of poor quality" : ""}</div></td>
          {showPatient && <td><b>{s.patientName}</b> <span className="muted small">{s.mrd}</span>
            <div className="muted small">{[s.ageYears != null && `${s.ageYears} y`, s.sex].filter(Boolean).join(", ")}</div></td>}
          <td>{s.reportId ? <>{s.summary}<div className="muted small">{s.reportedBy}, {stamp(s.reportedAt)}{s.amendedAt ? " (corrected)" : ""}</div></>
                          : <span className="tag alert">Not reported yet</span>}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

export function FundusReportsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<"todo" | "reported" | "all">(can("fundus.report") ? "todo" : "all");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Session | null>(null);
  const qs = new URLSearchParams(Object.entries({ status, q: search }).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["fundus", "sessions", qs], refetchInterval: 60_000, queryFn: () => api<{ sessions: Session[]; todo: number }>(`/fundus/sessions?${qs}`) });
  if (!can("clinical.read")) return <div className="notice error">Fundus reports are for clinical staff.</div>;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head"><div className="grow"><h1>Fundus reports</h1>
        <div className="muted">Photographs from the Remidio FOP, one row per patient and exam. Doctors write the report here (not in Remidio Connect).</div></div></div>
      <section className="panel">
        <form className="panel-head row" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); }}>
          <div className="seg" role="group" aria-label="Which">
            {([["todo", `To report${q.data ? ` (${q.data.todo})` : ""}`], ["reported", "Reported"], ["all", "All"]] as const).map(([k, label]) =>
              <button type="button" key={k} aria-pressed={status === k} onClick={() => setStatus(k)}>{label}</button>)}
          </div>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="MRD or name" aria-label="MRD or name" />
          <button type="submit">Search</button>
        </form>
        {q.error ? <div className="panel-pad"><ErrorNotice error={q.error} /></div> : !q.data ? <Loading /> : !q.data.sessions.length
          ? <div className="empty">{status === "todo" ? "Every photo session has a report." : "No photo sessions found."}</div>
          : <SessionRows sessions={q.data.sessions} onOpen={setOpen} />}
      </section>
      {open && <SessionDrawer s={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The patient page's "Fundus photographs": the patient's sessions with their reports. */
export function PatientFundus({ patientId }: { patientId: number }) {
  const q = useQuery({ queryKey: ["fundus", "sessions", "patient", patientId], queryFn: () => api<{ sessions: Session[] }>(`/fundus/sessions?status=all&patientId=${patientId}`) });
  const [open, setOpen] = useState<Session | null>(null);
  if (!q.data?.sessions.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Fundus photographs</h2><span className="muted small">From the Remidio FOP, newest first</span></div>
      <SessionRows sessions={q.data.sessions} onOpen={setOpen} showPatient={false} />
      {open && <SessionDrawer s={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function SessionDrawer({ s, onClose }: { s: Session; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["fundus", "session", s.patientId, s.examDate, s.examKey],
                       queryFn: () => api<{ photos: SessionPhoto[]; report: Report | null; words: Words }>(`/fundus/session?patientId=${s.patientId}&examDate=${s.examDate}&examKey=${s.examKey}`) });
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<SessionPhoto | null>(null);
  const writer = can("fundus.report");
  return (
    <Drawer wide onClose={onClose} title={`${s.patientName} · ${s.mrd}`} sub={`Fundus photographs of ${niceDate(s.examDate, true)}`}>
      {q.error ? <ErrorNotice error={q.error} /> : !q.data ? <Loading /> : <div className="stack" style={{ gap: "1rem" }}>
        <Link to={`/patients/${s.patientId}`}>Open the patient's record</Link>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "0.8rem" }}>
          {q.data.photos.map((p) => (
            <figure key={p.id} style={{ margin: 0 }}>
              <button type="button" className="btn-quiet" style={{ padding: 0, width: "100%" }} onClick={() => setView(p)} aria-label="Open the photograph full size">
                <img src={`/api/retina-ai/photos/${p.id}/image`} alt={`${p.eye ? EYE[p.eye] : "Eye not given"}, fundus photograph`}
                     style={{ width: "100%", aspectRatio: "1", objectFit: "cover", background: "#000", borderRadius: 8, display: "block" }} />
              </button>
              <figcaption className="small"><b>{p.eye ? EYE[p.eye] : "Eye not given"}</b>{p.field && <span className="muted">, {p.field.toLowerCase()}</span>}
                {p.quality === "INSUFFICIENT" && <> <span className="tag alert">Quality insufficient</span></>}</figcaption>
            </figure>))}
        </div>
        {q.data.report && !editing && <ReportView r={q.data.report} w={q.data.words} />}
        {q.data.report && !editing && writer && <div className="row"><button onClick={() => setEditing(true)}>Correct this report</button></div>}
        {(!q.data.report || editing) && (writer
          ? <ReportForm s={s} w={q.data.words} existing={editing ? q.data.report : null} onDone={() => setEditing(false)} onCancel={editing ? () => setEditing(false) : undefined} />
          : <div className="notice">Not reported yet. A doctor writes the report here.</div>)}
      </div>}
      {view && <PhotoViewer photo={{ id: view.id, label: [view.eye && EYE[view.eye], view.field?.toLowerCase(), view.capturedAt && stamp(view.capturedAt)].filter(Boolean).join(" · ") }} onClose={() => setView(null)} />}
    </Drawer>
  );
}

function ReportView({ r, w }: { r: Report; w: Words }) {
  const eye = (dr: string | null, dme: string | null, f: string[], other: string) => dr == null ? <span className="muted">Not reported</span> : <>
    <div><b>{w.DR[dr]}</b></div>
    {dme && <div>{w.DME[dme]}</div>}
    {f.length > 0 && <div>{f.map((k) => (k === "other" ? other : w.FINDINGS[k])).join(", ")}</div>}
  </>;
  return (
    <section className="panel panel-pad stack" style={{ borderLeft: `4px solid ${r.referral === "urgent" ? "var(--vessel)" : r.referral === "routine" ? "var(--disc)" : "var(--done)"}` }}>
      <h3>Doctor's report</h3>
      <table className="list compact"><tbody>
        <tr><th>Right eye</th><td>{eye(r.reDr, r.reDme, r.reFindings, r.reOther)}</td></tr>
        <tr><th>Left eye</th><td>{eye(r.leDr, r.leDme, r.leFindings, r.leOther)}</td></tr>
        <tr><th>Referral</th><td><b>{w.REFERRAL[r.referral]}</b></td></tr>
        {r.comments && <tr><th>Comments</th><td style={{ whiteSpace: "pre-wrap" }}>{r.comments}</td></tr>}
      </tbody></table>
      <div className="muted small">Reported by {r.reportedBy}, {stamp(r.reportedAt)}.
        {r.amendedAt && <> Corrected by {r.amendedBy}, {stamp(r.amendedAt)}: {r.amendmentReason}</>}</div>
    </section>
  );
}

type EyeForm = { dr: string; dme: string; findings: string[]; other: string };
const emptyEye: EyeForm = { dr: "", dme: "", findings: [], other: "" };

function EyeCol({ title, v, set, w }: { title: string; v: EyeForm; set: (e: EyeForm) => void; w: Words }) {
  return (
    <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem" }}>
      <legend><b>{title}</b></legend>
      <label className="field"><span>Diabetic retinopathy</span>
        <select value={v.dr} onChange={(e) => set({ ...v, dr: e.target.value })}>
          <option value="">Not reported</option>{Object.entries(w.DR).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
      <label className="field"><span>Macular oedema</span>
        <select value={v.dme} onChange={(e) => set({ ...v, dme: e.target.value })}>
          <option value="">Not stated</option>{Object.entries(w.DME).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
      <div className="small"><b>Other findings</b></div>
      {Object.entries(w.FINDINGS).map(([k, t]) => (
        <label key={k} className="row small"><input type="checkbox" checked={v.findings.includes(k)}
          onChange={(e) => set({ ...v, findings: e.target.checked ? [...v.findings, k] : v.findings.filter((x) => x !== k) })} /> {t}</label>))}
      {v.findings.includes("other") && <input value={v.other} onChange={(e) => set({ ...v, other: e.target.value })} placeholder="Which other finding" maxLength={300} />}
    </fieldset>
  );
}

function ReportForm({ s, w, existing, onDone, onCancel }: { s: Session; w: Words; existing: Report | null; onDone: () => void; onCancel?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fromReport = (dr: string | null, dme: string | null, f: string[], o: string): EyeForm => ({ dr: dr ?? "", dme: dme ?? "", findings: f, other: o });
  const [re, setRe] = useState<EyeForm>(existing ? fromReport(existing.reDr, existing.reDme, existing.reFindings, existing.reOther) : emptyEye);
  const [le, setLe] = useState<EyeForm>(existing ? fromReport(existing.leDr, existing.leDme, existing.leFindings, existing.leOther) : emptyEye);
  const [referral, setReferral] = useState(existing?.referral ?? "");
  const [comments, setComments] = useState(existing?.comments ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problem = !re.dr && !le.dr ? "Give the DR grade of at least one eye." : !referral ? "Choose the referral."
    : existing && reason.trim().length < 5 ? "Say why the report is corrected." : null;
  const eyeOut = (e: EyeForm) => ({ dr: e.dr || null, dme: e.dme || null, findings: e.findings, other: e.other });
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { re: eyeOut(re), le: eyeOut(le), referral, comments };
      if (existing) await api(`/fundus/reports/${existing.id}`, { method: "PUT", body: { ...body, reason } });
      else await api("/fundus/reports", { body: { ...body, patientId: s.patientId, examDate: s.examDate, examKey: s.examKey } });
      toast(existing ? "Report corrected" : "Report saved and signed");
      await qc.invalidateQueries({ queryKey: ["fundus"] }); await qc.invalidateQueries({ queryKey: ["retina"] });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <section className="panel panel-pad stack">
      <h3>{existing ? "Correct the report" : "Doctor's report"}</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.8rem" }}>
        <EyeCol title="Right eye" v={re} set={setRe} w={w} /><EyeCol title="Left eye" v={le} set={setLe} w={w} />
      </div>
      <div className="row"><b className="small">Referral</b>
        <div className="seg" role="group" aria-label="Referral">{Object.entries(w.REFERRAL).map(([k, t]) =>
          <button type="button" key={k} aria-pressed={referral === k} onClick={() => setReferral(k)}>{t}</button>)}</div></div>
      <label className="field"><span>Comments</span><textarea rows={3} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={2000} /></label>
      {existing && <label className="field"><span>Why is it corrected? (kept with the report)</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. second look at the left macula" /></label>}
      <ErrorNotice error={error} />
      <div className="row"><span className="grow muted small">{problem ?? "Signed with your name when saved. A report cannot be removed; corrections are kept."}</span>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <button className="btn-primary" disabled={!!problem || busy} onClick={() => void save()}>{existing ? "Save correction" : "Save and sign report"}</button></div>
    </section>
  );
}
