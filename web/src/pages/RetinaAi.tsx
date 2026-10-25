// Retina AI, research use only (D-040): grade a fundus photograph with the DR model, give your own grade, see how often
// they agree. Admin and doctors (retina_ai.use). The photograph is sent to the grader on shichika and never kept.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { niceDate, stamp } from "../format";
import { Drawer, ErrorNotice, Loading, useToast } from "../components/ui";
import { PatientPicker, type PickedPatient } from "../components/PatientPicker";

const GRADES = ["No DR", "Mild NPDR", "Moderate NPDR", "Severe NPDR", "Proliferative DR"];
const EYE: Record<string, string> = { RE: "Right eye", LE: "Left eye" };
const SOURCE: Record<string, string> = { upload: "Uploaded", batch: "Folder import", legacy_import: "Old grader" };
const MAX_MB = 40;

interface Grading {
  id: number; createdAt: string; patientId: number | null; mrd: string | null; patientName: string | null; eye: "RE" | "LE" | null;
  source: string; batchId: string | null; status: "ok" | "rejected" | "error"; error: string | null; imageFilename: string | null;
  remarks: string; createdBy: string | null; doctorGrades: number; myGrade: number | null; myUngradable: boolean | null; myBlinded: boolean | null;
  aiGrade?: number | null; probs?: number[] | null; rawOutputs?: number[] | null; calibration?: string | null; imageWidth?: number | null;
  imageHeight?: number | null; inferenceMs?: number | null; modelSha256?: string | null; modelCommit?: string | null; graderVersion?: string | null;
  aiSeen?: boolean;
}
interface DoctorGrade { grade: number | null; ungradable: boolean; note: string; blinded: boolean; at: string; by: string; mine: boolean }

type Tab = "grade" | "todo" | "records" | "agreement" | "system";
const TABS: [Tab, string][] = [["grade", "Grade a photograph"], ["todo", "To grade"], ["records", "Records"], ["agreement", "Agreement"], ["system", "System"]];

const gradeWords = (g: number | null | undefined) => (g == null ? "—" : `${g} · ${GRADES[g]}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const myGradeWords = (g: Grading) => (g.myUngradable ? "Not gradable" : g.myGrade != null ? gradeWords(g.myGrade) : null);

function ResearchBanner() {
  return (
    <div className="notice" role="note">
      <b>Research use only.</b> This model is not a medical device. It has no published accuracy and has not been checked on
      Sampada patients. Never use its grade to make, confirm or withhold a clinical decision: every photograph is still graded
      by the treating doctor. Results stay on this page; they do not go into the patient's record.
    </div>
  );
}

export function RetinaAiPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>("grade");
  const todo = useQuery({ queryKey: ["retina", "todo"], enabled: can("retina_ai.use"),
                          queryFn: () => api<{ gradings: Grading[] }>("/retina-ai/to-grade") });
  if (!can("retina_ai.use")) return <div className="notice error">The retina AI page is for admin and doctors only.</div>;
  const toGrade = todo.data?.gradings.length ?? 0;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head"><div className="grow"><h1>Retina AI <span className="ds-ai">Research</span></h1>
        <div className="muted">Diabetic retinopathy grade from a fundus photograph, by a research model on shichika. The photograph is not kept.</div></div></div>
      <ResearchBanner />
      <div className="seg" role="tablist" aria-label="Retina AI">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}{k === "todo" && !!toGrade && <span className="count">{toGrade}</span>}</button>))}
      </div>
      {tab === "grade" && <GradeTab />}
      {tab === "todo" && <ToGradeTab />}
      {tab === "records" && <RecordsTab />}
      {tab === "agreement" && <AgreementTab />}
      {tab === "system" && <SystemTab />}
    </div>
  );
}

// ---------- grade a photograph ----------
async function uploadPhoto(file: File, patientId: number, eye: string, blind: boolean) {
  const res = await fetch(`/api/retina-ai/grade?patientId=${patientId}&eye=${eye}&blind=${blind}`, {
    method: "POST", credentials: "same-origin", body: file,
    headers: { "content-type": file.type, "x-file-name": encodeURIComponent(file.name) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Upload failed (${res.status})`);
  return data as { grading: Grading; aiHidden: boolean };
}

function GradeTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [eye, setEye] = useState<"RE" | "LE" | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [blind, setBlind] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ grading: Grading; aiHidden: boolean } | null>(null);

  useEffect(() => {                        // shown from a data: address (the page allows no other kind); never sent anywhere but the grader
    if (!file) { setPreview(null); return; }
    const r = new FileReader();
    r.onload = () => setPreview(String(r.result));
    r.readAsDataURL(file);
  }, [file]);

  const problem = !patient ? "Find the patient first." : !eye ? "Choose the eye." : !file ? "Choose the photograph."
    : !["image/jpeg", "image/png"].includes(file.type) ? "Choose a JPG or PNG photograph."
    : file.size > MAX_MB * 1024 * 1024 ? `The photograph is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_MB} MB.` : null;

  const go = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await uploadPhoto(file!, patient!.patientId, eye!, blind);
      setResult(r);
      if (r.grading.status === "ok") toast(r.aiHidden ? "Graded and saved. Give your grade to see the AI grade." : "Graded and saved");
      await qc.invalidateQueries({ queryKey: ["retina"] });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const next = () => { setFile(null); setResult(null); setError(null); setEye(null); };

  return (
    <section className="panel panel-pad stack">
      <div className="fields">
        <div className="wide">
          <div className="small"><b>Patient</b></div>
          {patient
            ? <div className="row"><b>{patient.name}</b><span className="muted">{patient.mrd}</span>
                <button className="btn-quiet btn-small" onClick={() => { setPatient(null); next(); }}>Change</button></div>
            : <PatientPicker onPick={(p) => { setPatient(p); next(); }} autoFocus />}
        </div>
        <div>
          <div className="small"><b>Eye</b></div>
          <div className="seg">{(["RE", "LE"] as const).map((e) =>
            <button key={e} aria-pressed={eye === e} onClick={() => { setEye(e); setResult(null); }}>{EYE[e]}</button>)}</div>
        </div>
        <label className="field wide"><span>Fundus photograph (JPG or PNG, up to {MAX_MB} MB)</span>
          <input type="file" accept="image/jpeg,image/png" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }} /></label>
        <label className="row small wide"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          Give my own grade first; show the AI grade after (counts towards the agreement figures)</label>
      </div>
      {preview && <img src={preview} alt="The chosen photograph" style={{ maxWidth: 320, maxHeight: 320, borderRadius: 8, border: "1px solid var(--line)" }} />}
      <div className="row">
        <span className="grow muted small">{problem ?? `Ready: ${patient!.mrd}, ${EYE[eye!].toLowerCase()}, ${file!.name}`}</span>
        <button className="btn-primary" disabled={!!problem || busy} onClick={() => void go()}>{busy ? "Grading…" : "Grade with the research model"}</button>
      </div>
      <ErrorNotice error={error} />
      {result && (result.grading.status !== "ok"
        ? <div className="notice error" role="alert">Not graded: {result.grading.error} The attempt is recorded. Choose another photograph.</div>
        : result.aiHidden
          ? <MyGradeForm grading={result.grading} intro="Your grade of this photograph (the AI grade is hidden until you save):"
              onSaved={async () => { setResult({ grading: (await api<{ grading: Grading }>(`/retina-ai/gradings/${result.grading.id}`)).grading, aiHidden: false }); }} />
          : <><AiResult g={result.grading} />
              {result.grading.myGrade == null && !result.grading.myUngradable &&
                <MyGradeForm grading={result.grading} intro="Your grade (you have seen the AI grade, so it will not count as blinded):" onSaved={() => {}} />}</>)}
      {result && <div className="row"><button onClick={next}>Grade another photograph{patient ? ` of ${patient.mrd}` : ""}</button></div>}
    </section>
  );
}

function AiResult({ g }: { g: Grading }) {
  const probs = g.probs ?? [];
  return (
    <div className="panel panel-pad stack" style={{ borderLeft: "4px solid var(--disc)" }}>
      <div className="row"><h2 className="grow">AI grade: {gradeWords(g.aiGrade)}</h2><span className="ds-ai">AI-generated · verify</span></div>
      <table className="list compact">
        <thead><tr><th>Grade</th><th>Score</th><th style={{ width: "40%" }}></th><th>Raw output</th></tr></thead>
        <tbody>{GRADES.map((name, i) => (
          <tr key={i} style={i === g.aiGrade ? { fontWeight: 700 } : undefined}>
            <td>{i} · {name}</td><td>{pct(probs[i])}</td>
            <td><div aria-hidden="true" style={{ height: 8, borderRadius: 4, background: "var(--line-soft)" }}>
              <div style={{ height: 8, borderRadius: 4, width: `${Math.max(0, Math.min(1, probs[i] ?? 0)) * 100}%`, background: i === g.aiGrade ? "var(--disc)" : "var(--ink-soft)" }} /></div></td>
            <td className="muted small">{g.rawOutputs?.[i]?.toPrecision(4) ?? "—"}</td></tr>))}
        </tbody>
      </table>
      <div className="muted small">The score shows which grade won, not how sure the model is: this model often gives 100% to one grade even when it
        is wrong. {g.imageWidth ? `Photograph ${g.imageWidth}×${g.imageHeight}, ` : ""}{g.inferenceMs ? `graded in ${Math.round(g.inferenceMs)} ms, ` : ""}
        model {g.modelSha256?.slice(0, 12) ?? "?"}…, {g.calibration === "softmax_applied" ? "softmax applied" : "native probabilities"}.</div>
    </div>
  );
}

function MyGradeForm({ grading, intro, onSaved }: { grading: Grading; intro: string; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [grade, setGrade] = useState<string>(grading.myUngradable ? "x" : grading.myGrade != null ? String(grading.myGrade) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ blinded: boolean }>(`/retina-ai/gradings/${grading.id}/my-grade`, { method: "PUT",
        body: { grade: grade === "x" ? null : Number(grade), ungradable: grade === "x", note } });
      toast(r.blinded ? "Your grade is saved (blinded: given before you saw the AI grade)" : "Your grade is saved (not blinded: you had seen the AI grade)");
      await qc.invalidateQueries({ queryKey: ["retina"] });
      await onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <div className="small">{intro}</div>
      <div className="row">
        <select value={grade} onChange={(e) => setGrade(e.target.value)} aria-label="Your DR grade">
          <option value="">Choose a grade…</option>
          {GRADES.map((n, i) => <option key={i} value={i}>{i} · {n}</option>)}
          <option value="x">Not gradable (blur, opacity, poor field)</option>
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" maxLength={1000} style={{ flex: 1, minWidth: 160 }} />
        <button className="btn-primary" disabled={!grade || busy} onClick={() => void save()}>Save my grade</button>
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}

// ---------- photographs I have not graded (no AI grade shown) ----------
function ToGradeTab() {
  const q = useQuery({ queryKey: ["retina", "todo"], queryFn: () => api<{ gradings: Grading[] }>("/retina-ai/to-grade") });
  const [open, setOpen] = useState<number | null>(null);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const rows = q.data.gradings;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Photographs you have not graded</h2></div>
      <div className="panel-pad muted small" style={{ paddingBottom: 0 }}>The AI grade is not shown here, so your grade counts as blinded. Sudarshan does not
        keep photographs: look at the photograph in the Remidio dashboard or the original file (file name below).</div>
      {!rows.length ? <div className="empty">Nothing to grade.</div> : <div className="scroll-x"><table className="list">
        <thead><tr><th>Graded by AI</th><th>Patient</th><th>Eye</th><th>File</th><th></th></tr></thead>
        <tbody>{rows.map((g) => (
          <tr key={g.id}><td className="nowrap">{stamp(g.createdAt)}</td>
            <td>{g.patientId ? <Link to={`/patients/${g.patientId}`}>{g.patientName ?? g.mrd}</Link> : g.mrd ?? "—"} <span className="muted small">{g.mrd}</span></td>
            <td>{g.eye ? EYE[g.eye] : "—"}</td><td className="small">{g.imageFilename}</td>
            <td>{open === g.id
              ? <MyGradeForm grading={g} intro={g.aiSeen ? "You have seen the AI grade of this photograph, so your grade will not count as blinded." : "Your grade:"} onSaved={() => setOpen(null)} />
              : <button className="btn-small" onClick={() => setOpen(g.id)}>Give my grade</button>}</td></tr>))}
        </tbody></table></div>}
    </section>
  );
}

// ---------- every grading, with the AI grade (each shown result is logged) ----------
function RecordsTab() {
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState({ text: "", from: "", to: "" });
  const [open, setOpen] = useState<number | null>(null);
  const qs = new URLSearchParams(Object.entries({ q: search.text, from: search.from, to: search.to }).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["retina", "records", qs], queryFn: () => api<{ gradings: Grading[] }>(`/retina-ai/gradings${qs ? `?${qs}` : ""}`) });
  return (
    <section className="panel">
      <form className="panel-head row" onSubmit={(e) => { e.preventDefault(); setSearch({ text: text.trim(), from, to }); }}>
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="MRD or name" aria-label="MRD or name" />
        <label className="row small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="submit">Search</button><span className="grow" />
        <span className="muted small">Newest first, up to 200</span>
      </form>
      {q.error ? <div className="panel-pad"><ErrorNotice error={q.error} /></div> : !q.data ? <Loading /> : !q.data.gradings.length ? <div className="empty">No gradings found.</div> :
        <div className="scroll-x"><table className="list">
          <thead><tr><th>When</th><th>Patient</th><th>Eye</th><th>AI grade</th><th>Your grade</th><th>Doctors</th><th>From</th><th>Remarks</th></tr></thead>
          <tbody>{q.data.gradings.map((g) => (
            <tr key={g.id} className="clickable" onClick={() => setOpen(g.id)}>
              <td className="nowrap">{stamp(g.createdAt)}</td>
              <td>{g.patientName ?? <span className="muted">not in Yarago</span>} <span className="muted small">{g.mrd}</span></td>
              <td>{g.eye ? EYE[g.eye] : "—"}</td>
              <td>{g.status === "ok" ? <b>{gradeWords(g.aiGrade)}</b> : <span className="pill cancelled">Not graded</span>}</td>
              <td>{myGradeWords(g) ?? "—"}{g.myBlinded === false && <div className="muted small">not blinded</div>}</td>
              <td>{g.doctorGrades || "—"}</td><td className="small">{SOURCE[g.source] ?? g.source}</td>
              <td className="small">{g.remarks || (g.status !== "ok" ? g.error : "")}</td></tr>))}
          </tbody></table></div>}
      {open && <GradingDrawer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function GradingDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["retina", "grading", id], queryFn: () => api<{ grading: Grading; doctorGrades: DoctorGrade[] }>(`/retina-ai/gradings/${id}`) });
  const [remarks, setRemarks] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return <Drawer title="AI grading" onClose={onClose}>{q.error ? <ErrorNotice error={q.error} /> : <Loading />}</Drawer>;
  const { grading: g, doctorGrades } = q.data;
  const saveRemarks = async () => {
    setError(null);
    try {
      await api(`/retina-ai/gradings/${id}/remarks`, { method: "PUT", body: { remarks: remarks ?? "" } });
      toast("Remarks saved"); setRemarks(null);
      await qc.invalidateQueries({ queryKey: ["retina"] });
    } catch (e) { setError(e); }
  };
  return (
    <Drawer wide onClose={onClose} title={g.patientName ?? g.mrd ?? "AI grading"}
      sub={[g.mrd, g.eye && EYE[g.eye], stamp(g.createdAt), SOURCE[g.source], g.createdBy && `by ${g.createdBy}`].filter(Boolean).join(" · ")}>
      <div className="stack">
        {g.patientId && <Link to={`/patients/${g.patientId}`}>Open the patient's record</Link>}
        <div className="small muted">File: {g.imageFilename ?? "—"}{g.batchId ? ` · ${g.batchId}` : ""}</div>
        {g.status === "ok" ? <AiResult g={g} /> : <div className="notice error">Not graded: {g.error}</div>}
        {g.status === "ok" && <>
          <h3>Doctors' grades</h3>
          {!doctorGrades.length ? <div className="muted">None yet.</div> :
            <table className="list compact"><tbody>{doctorGrades.map((d, i) => (
              <tr key={i}><td>{d.by}{d.mine ? " (you)" : ""}</td><td><b>{d.ungradable ? "Not gradable" : gradeWords(d.grade)}</b></td>
                <td className="small">{d.blinded ? "blinded" : "after seeing the AI grade"}</td><td className="small muted">{niceDate(d.at.slice(0, 10), true)}{d.note ? ` · ${d.note}` : ""}</td></tr>))}
            </tbody></table>}
          <MyGradeForm grading={g} intro={g.myGrade != null || g.myUngradable ? "Change your grade:" : "Your grade (not blinded: the AI grade is shown above):"} onSaved={() => {}} />
        </>}
        <h3>Remarks</h3>
        <textarea rows={3} value={remarks ?? g.remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={2000} />
        <div className="row"><span className="grow muted small">The grading itself cannot be changed or removed; only remarks.</span>
          <button disabled={remarks === null || remarks === g.remarks} onClick={() => void saveRemarks()}>Save remarks</button></div>
        <ErrorNotice error={error} />
      </div>
    </Drawer>
  );
}

// ---------- agreement ----------
interface Agreement {
  n: number; exact: number; withinOne: number; kappa: number | null; confusion: number[][]; ungradable: number;
  referable: { tp: number; fn: number; fp: number; tn: number; sensitivity: number | null; specificity: number | null };
  graders: { id: number; name: string; grades: number; blinded: number }[];
}
function AgreementTab() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [grader, setGrader] = useState("");
  const [all, setAll] = useState(false);
  const qs = new URLSearchParams(Object.entries({ from, to, graderId: grader, includeUnblinded: all ? "true" : "" }).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["retina", "agreement", qs], queryFn: () => api<Agreement>(`/retina-ai/agreement${qs ? `?${qs}` : ""}`) });
  const a = q.data;
  return (
    <section className="panel">
      <div className="panel-head row">
        <label className="row small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={grader} onChange={(e) => setGrader(e.target.value)} aria-label="Whose grades">
          <option value="">All doctors</option>
          {a?.graders.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.blinded} blinded of {g.grades})</option>)}
        </select>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include grades given after seeing the AI grade</label>
      </div>
      {q.error ? <div className="panel-pad"><ErrorNotice error={q.error} /></div> : !a ? <Loading /> : <div className="panel-pad stack">
        {!a.n ? <div className="empty">No photographs with both an AI grade and a {all ? "" : "blinded "}doctor's grade yet.</div> : <>
          <div className="stat-strip">
            <div className="stat"><b>{a.n}</b><span>photographs compared{a.ungradable ? ` (${a.ungradable} not gradable left out)` : ""}</span></div>
            <div className="stat"><b>{pct(a.exact / a.n)}</b><span>same grade ({a.exact})</span></div>
            <div className="stat"><b>{pct(a.withinOne / a.n)}</b><span>within one grade ({a.withinOne})</span></div>
            <div className="stat"><b>{a.kappa == null ? "—" : a.kappa.toFixed(2)}</b><span>weighted kappa</span></div>
            <div className="stat"><b>{pct(a.referable.sensitivity)}</b><span>referable DR found (missed {a.referable.fn})</span></div>
            <div className="stat"><b>{pct(a.referable.specificity)}</b><span>no referable DR, AI agreed ({a.referable.fp} false alarms)</span></div>
          </div>
          <div className="scroll-x"><table className="list compact">
            <thead><tr><th>Doctor's grade ↓ · AI grade →</th>{GRADES.map((_, i) => <th key={i}>AI {i}</th>)}<th>Total</th></tr></thead>
            <tbody>{a.confusion.map((row, i) => (
              <tr key={i}><th>{i} · {GRADES[i]}</th>{row.map((c, j) => <td key={j} style={i === j ? { fontWeight: 700, background: "var(--action-soft)" } : undefined}>{c || ""}</td>)}
                <td>{row.reduce((s, c) => s + c, 0)}</td></tr>))}</tbody></table></div>
          <div className="muted small">Referable DR = moderate NPDR or worse (grade 2 to 4). For screening, a missed referable eye matters far more than a
            false alarm: judge the model on "referable DR found" first. Kappa above 0.8 is strong, 0.6 to 0.8 moderate, below 0.4 poor.
            A few hundred blinded photographs are needed before these figures mean much.</div>
        </>}
      </div>}
    </section>
  );
}

// ---------- the grader ----------
function SystemTab() {
  const q = useQuery({ queryKey: ["retina", "status"], refetchInterval: 30_000, queryFn: () => api<any>("/retina-ai/status") });
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const { grader: g, counts: c } = q.data;
  return (
    <section className="panel panel-pad stack">
      <div className={`notice ${g.ready ? "ok" : "error"}`}>
        {g.ready ? "The grader is running and the model is loaded."
          : !g.keySet ? "RETINA_AI_KEY is not set in Sudarshan's .env: run scripts\\setup-retina-ai.ps1 on shichika."
          : !g.reachable ? "The grader does not answer. Docker Desktop starts only after someone signs in to Windows on shichika: sign in, wait a minute, then check again."
          : `The grader answers but the model is not ready${g.error ? `: ${g.error}` : " yet (it takes about a minute after Docker starts)"}.`}
      </div>
      <table className="list compact"><tbody>
        <tr><th>Model</th><td>{g.modelRepo ?? "—"} {g.modelCommit && <span className="muted">commit {g.modelCommit}</span>}</td></tr>
        <tr><th>Model file SHA-256</th><td className="small">{g.modelSha256 ?? "—"}</td></tr>
        <tr><th>Output</th><td>{g.calibration === "native_probabilities" ? "Native probabilities (softmax not applied again)" : g.calibration ?? "—"}</td></tr>
        <tr><th>Grader version</th><td>{g.version ?? "—"} {g.tensorflow && <span className="muted">TensorFlow {g.tensorflow}</span>}</td></tr>
        <tr><th>Running for</th><td>{g.uptimeSeconds != null ? `${Math.round(g.uptimeSeconds / 3600)} h` : "—"}{g.lastInferenceMs ? `, last photograph ${Math.round(g.lastInferenceMs)} ms` : ""}</td></tr>
        <tr><th>Gradings saved</th><td>{c.graded} graded, {c.notGraded} not graded, {c.withDoctorGrade} with a doctor's grade{c.lastAt ? `; last ${stamp(c.lastAt)}` : ""}</td></tr>
      </tbody></table>
      <div className="muted small">Folder import and copying the old grader's records run on the server console: see RUNBOOK, "Retina AI".</div>
    </section>
  );
}
