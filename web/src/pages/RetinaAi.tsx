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
const SOURCE: Record<string, string> = { upload: "Uploaded", batch: "Folder import", remidio: "Remidio FOP", topcon: "Topcon Maestro2" };
/** Which camera a kept photograph came from (D-041 Remidio, D-048 Maestro2). */
export const CAMERA: Record<string, string> = { remidio: "Remidio FOP", topcon: "Topcon Maestro2" };
const MAX_MB = 40;

interface Grading {
  id: number; createdAt: string; patientId: number | null; mrd: string | null; patientName: string | null; eye: "RE" | "LE" | null;
  source: string; batchId: string | null; status: "ok" | "rejected" | "error"; error: string | null; imageFilename: string | null;
  remarks: string; createdBy: string | null; doctorGrades: number; myGrade: number | null; myUngradable: boolean | null; myBlinded: boolean | null;
  aiGrade?: number | null; probs?: number[] | null; rawOutputs?: number[] | null; calibration?: string | null; imageWidth?: number | null;
  imageHeight?: number | null; inferenceMs?: number | null; modelSha256?: string | null; modelCommit?: string | null; graderVersion?: string | null;
  aiSeen?: boolean; photoId?: number | null; modelRepo?: string | null; photoQuality?: string | null; screening?: Screened | null;
}
/** Live screening outcome of a grading (D-046): research, silent, never shown to patients or used to clear anyone. */
interface Screened { outcome: "refer" | "uncertain" | "routine"; score: number; refer: number; clear: number; source: string; model: string; ungradable: boolean }
export interface Photo {
  id: number; capturedAt: string | null; receivedAt: string; patientId: number | null; mrd: string | null; patientName: string | null;
  mrn: string | null; sexCheck: "same" | "different" | null; eye: "RE" | "LE" | null; field: string | null; quality: string | null;
  width: number | null; height: number | null; hasThumb: boolean; gradings: number;
  source: "remidio" | "topcon"; device: string | null; protocol: string | null;
}
// the models measured so far (docs/AI_EVALUATION.md), by the start of their model SHA-256
const MODELS: Record<string, string> = { cd4b10c3: "Arko007 (unreliable)", f1a558fc: "RFM, APTOS head", b23dcc9b: "RFM, Messidor-2 head" };
const modelName = (g: { modelSha256?: string | null; screening?: Screened | null }) =>
  g.screening?.model ?? MODELS[String(g.modelSha256 ?? "").slice(0, 8)] ?? (g.modelSha256 ? `model ${g.modelSha256.slice(0, 8)}…` : "—");
const OUTCOME: Record<Screened["outcome"], [string, string]> = {
  refer: ["Refer", "tag alert"], uncertain: ["Uncertain: a person decides", "tag vip"], routine: ["Routine", "tag"],
};
function ScreeningTag({ s }: { s: Screened | null | undefined }) {
  if (!s) return <span className="muted small">—</span>;
  const [words, cls] = OUTCOME[s.outcome];
  return <span className={cls} title={`Referral score ${s.score.toFixed(3)}; refer at ${s.refer.toPrecision(3)} or above, routine below ${s.clear.toPrecision(3)} (${s.source})${s.ungradable ? "; photograph not gradable" : ""}`}>{words}</span>;
}
const FIELD: Record<string, string> = { MACULA: "macula", DISC: "disc", OTHER: "other field" };

/** A fundus photograph kept on shichika (Remidio D-041, Maestro2 D-048). */
export function PhotoThumb({ id, onOpen, size = 72 }: { id: number; onOpen?: () => void; size?: number }) {
  const img = <img src={`/api/retina-ai/photos/${id}/image?size=thumb`} alt="Fundus photograph" loading="lazy"
                   style={{ width: size, height: size, objectFit: "cover", borderRadius: 4, border: "1px solid var(--line)", display: "block", background: "#000" }} />;
  return onOpen ? <button type="button" className="btn-quiet" style={{ padding: 0 }} onClick={(e) => { e.stopPropagation(); onOpen(); }} aria-label="Open the photograph">{img}</button> : img;
}

export function PhotoViewer({ photo, onClose }: { photo: { id: number; label?: string; source?: string | null }; onClose: () => void }) {
  return (
    <Drawer wide title="Fundus photograph" sub={photo.label} onClose={onClose}>
      <img src={`/api/retina-ai/photos/${photo.id}/image`} alt="Fundus photograph, full size"
           style={{ width: "100%", maxHeight: "80vh", objectFit: "contain", background: "#000", borderRadius: 8 }} />
      <div className="muted small">{photo.source ? `From the ${CAMERA[photo.source] ?? photo.source}, kept` : "Kept"} on shichika. Open it in a new tab for full resolution:{" "}
        <a href={`/api/retina-ai/photos/${photo.id}/image`} target="_blank" rel="noreferrer">full size</a>.</div>
    </Drawer>
  );
}
const photoLabel = (p: { patientName?: string | null; mrd?: string | null; mrn?: string | null; eye?: string | null; capturedAt?: string | null; quality?: string | null; field?: string | null; source?: string | null; protocol?: string | null }) =>
  [p.patientName ?? (p.mrn ? `MRN ${p.mrn} (not in Yarago)` : null), p.mrd, p.eye && EYE[p.eye], p.field && FIELD[p.field], p.source && CAMERA[p.source], p.protocol,
   p.quality && (p.quality === "SUFFICIENT" ? "quality sufficient" : "quality INSUFFICIENT"), p.capturedAt && stamp(p.capturedAt)].filter(Boolean).join(" · ");
interface DoctorGrade { grade: number | null; ungradable: boolean; note: string; blinded: boolean; at: string; by: string; mine: boolean }

type Tab = "grade" | "todo" | "photos" | "records" | "agreement" | "evaluation" | "system";
const TABS: [Tab, string][] = [["grade", "Grade a photograph"], ["todo", "To grade"], ["photos", "Photographs"], ["records", "Records"],
  ["agreement", "Agreement"], ["evaluation", "Evaluation"], ["system", "System"]];

const gradeWords = (g: number | null | undefined) => (g == null ? "—" : `${g} · ${GRADES[g]}`);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const myGradeWords = (g: Grading) => (g.myUngradable ? "Not gradable" : g.myGrade != null ? gradeWords(g.myGrade) : null);

function ResearchBanner() {
  return (
    <div className="notice" role="note">
      <b>Research use only.</b> This model is not a medical device. It has no published accuracy and has not been checked on
      Sampada patients. Never use its grade to make, confirm or withhold a clinical decision: every photograph is still graded
      by the treating doctor. Results stay on this page; they do not go into the patient's record.
      <div style={{ marginTop: "0.35rem" }}><b>The current model (Arko007) is unreliable:</b> on 3,662 public test images (APTOS, 25 Oct 2026) it
        missed 3 in 10 eyes needing referral, called 1 in 4 proliferative DR eyes "No DR", and flagged 1 in 3 normal eyes. It is kept only
        for research and comparison; never use it for patient advice or screening decisions.</div>
      <div style={{ marginTop: "0.35rem" }}><b>RFM grades Remidio and Maestro2 photographs silently</b> (two heads, D-046), with a research screening outcome
        (Refer / Uncertain / Routine) from cut-offs chosen on public data. It is not validated on Sampada photographs: the outcome
        never clears a patient (macular oedema, symptoms and image quality need the doctor) and is only compared with the doctor's report.</div>
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
      {tab === "photos" && <PhotosTab />}
      {tab === "records" && <RecordsTab />}
      {tab === "agreement" && <AgreementTab />}
      {tab === "evaluation" && <EvaluationTab />}
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
      <div className="row"><h2 className="grow">AI grade: {gradeWords(g.aiGrade)} <span className="muted small">{modelName(g)}</span></h2><span className="ds-ai">AI-generated · verify</span></div>
      {g.screening && <div className="row small">Research screening outcome: <ScreeningTag s={g.screening} />
        <span className="muted">referral score {g.screening.score.toFixed(3)} (refer at {g.screening.refer.toPrecision(3)} or above, routine below {g.screening.clear.toPrecision(3)}; {g.screening.source}).
          Silent research: never clears a patient.</span></div>}
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
      <div className="muted small">{String(g.modelSha256 ?? "").startsWith("cd4b10c3") && <b>Unreliable model (Arko007, see the notice above). </b>}
        The score shows which grade won, not how sure the model is{String(g.modelSha256 ?? "").startsWith("cd4b10c3") ? ": this model often gives 100% to one grade even when it is wrong" : ""}. {g.imageWidth ? `Photograph ${g.imageWidth}×${g.imageHeight}, ` : ""}{g.inferenceMs ? `graded in ${Math.round(g.inferenceMs)} ms, ` : ""}
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
  const [view, setView] = useState<{ id: number; label: string } | null>(null);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const rows = q.data.gradings;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Photographs you have not graded</h2></div>
      <div className="panel-pad muted small" style={{ paddingBottom: 0 }}>The AI grade is not shown here, so your grade counts as blinded. Photographs from
        Remidio open here (click the picture); for uploaded ones Sudarshan keeps no copy, so look at the original file (file name below).</div>
      {!rows.length ? <div className="empty">Nothing to grade.</div> : <div className="scroll-x"><table className="list">
        <thead><tr><th></th><th>Graded by AI</th><th>Patient</th><th>Eye</th><th>File</th><th></th></tr></thead>
        <tbody>{rows.map((g) => (
          <tr key={g.id}><td>{g.photoId ? <PhotoThumb id={g.photoId} onOpen={() => setView({ id: g.photoId!, label: [g.patientName ?? g.mrd, g.eye && EYE[g.eye]].filter(Boolean).join(" · ") })} /> : null}</td>
            <td className="nowrap">{stamp(g.createdAt)}</td>
            <td>{g.patientId ? <Link to={`/patients/${g.patientId}`}>{g.patientName ?? g.mrd}</Link> : g.mrd ?? "—"} <span className="muted small">{g.mrd}</span></td>
            <td>{g.eye ? EYE[g.eye] : "—"}</td><td className="small">{g.imageFilename}</td>
            <td>{open === g.id
              ? <MyGradeForm grading={g} intro={g.aiSeen ? "You have seen the AI grade of this photograph, so your grade will not count as blinded." : "Your grade:"} onSaved={() => setOpen(null)} />
              : <button className="btn-small" onClick={() => setOpen(g.id)}>Give my grade</button>}</td></tr>))}
        </tbody></table></div>}
      {view && <PhotoViewer photo={view} onClose={() => setView(null)} />}
    </section>
  );
}

// ---------- photographs received from Remidio (no AI grade here) ----------
function PhotosTab() {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [unmatched, setUnmatched] = useState(false);
  const [camera, setCamera] = useState("");
  const [view, setView] = useState<Photo | null>(null);
  const qs = new URLSearchParams(Object.entries({ q: search, unmatched: unmatched ? "true" : "", source: camera }).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["retina", "photos", qs], refetchInterval: 60_000, queryFn: () => api<{ photos: Photo[] }>(`/retina-ai/photos${qs ? `?${qs}` : ""}`) });
  return (
    <section className="panel">
      <form className="panel-head row" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); }}>
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="MRD or name" aria-label="MRD or name" />
        <button type="submit">Search</button>
        <label className="row small"><input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} /> Only MRNs not found in Yarago</label>
        <select value={camera} onChange={(e) => setCamera(e.target.value)} aria-label="Camera">
          <option value="">Both cameras</option><option value="remidio">Remidio FOP</option><option value="topcon">Topcon Maestro2</option></select>
        <span className="grow" /><span className="muted small">Newest first, up to 300</span>
      </form>
      {q.error ? <div className="panel-pad"><ErrorNotice error={q.error} /></div> : !q.data ? <Loading /> : !q.data.photos.length
        ? <div className="empty">No photographs yet. They arrive from Remidio and the Maestro2 once their import is on (System tab).</div>
        : <div className="panel-pad" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "0.8rem" }}>
            {q.data.photos.map((p) => (
              <div key={p.id} className="stack" style={{ gap: "0.25rem" }}>
                <PhotoThumb id={p.id} size={160} onOpen={() => setView(p)} />
                <div className="small"><b>{p.patientId ? <Link to={`/patients/${p.patientId}`}>{p.patientName ?? p.mrd}</Link> : <>MRN {p.mrn ?? "—"}</>}</b>{p.patientId && <span className="muted"> {p.mrd}</span>}</div>
                <div className="small muted">{[p.eye && EYE[p.eye], p.field && FIELD[p.field], p.capturedAt && stamp(p.capturedAt)].filter(Boolean).join(" · ")}</div>
                <div className="small">
                  <span className="tag" title={p.protocol ?? undefined}>{CAMERA[p.source] ?? p.source}</span>
                  {p.quality === "INSUFFICIENT" && <span className="tag alert">Quality insufficient</span>}
                  {!p.patientId && <span className="tag alert">Not in Yarago</span>}
                  {p.sexCheck === "different" && <span className="tag alert">Sex differs from Yarago</span>}
                  {!p.gradings && <span className="tag">AI grading waiting</span>}
                </div>
              </div>))}
          </div>}
      {view && <PhotoViewer photo={{ id: view.id, label: photoLabel(view), source: view.source }} onClose={() => setView(null)} />}
    </section>
  );
}

// ---------- every grading, with the AI grade (each shown result is logged) ----------
function RecordsTab() {
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [model, setModel] = useState("");
  const [search, setSearch] = useState({ text: "", from: "", to: "" });
  const [open, setOpen] = useState<number | null>(null);
  const qs = new URLSearchParams(Object.entries({ q: search.text, from: search.from, to: search.to, model }).filter(([, v]) => v)).toString();
  const q = useQuery({ queryKey: ["retina", "records", qs], queryFn: () => api<{ gradings: Grading[] }>(`/retina-ai/gradings${qs ? `?${qs}` : ""}`) });
  const status = useQuery({ queryKey: ["retina", "status"], queryFn: () => api<any>("/retina-ai/status") });
  const models: { modelSha256: string; key: string }[] = (status.data?.graders ?? []).filter((x: any) => x.modelSha256);
  return (
    <section className="panel">
      <form className="panel-head row" onSubmit={(e) => { e.preventDefault(); setSearch({ text: text.trim(), from, to }); }}>
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="MRD or name" aria-label="MRD or name" />
        <label className="row small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Which model">
          <option value="">All models</option>
          {models.map((m) => <option key={m.modelSha256} value={m.modelSha256}>{modelName(m)}</option>)}
        </select>
        <button type="submit">Search</button><span className="grow" />
        <span className="muted small">Newest first, up to 200</span>
      </form>
      {q.error ? <div className="panel-pad"><ErrorNotice error={q.error} /></div> : !q.data ? <Loading /> : !q.data.gradings.length ? <div className="empty">No gradings found.</div> :
        <div className="scroll-x"><table className="list">
          <thead><tr><th></th><th>When</th><th>Patient</th><th>Eye</th><th>Model</th><th>AI grade</th><th>Screening (research)</th><th>Your grade</th><th>Doctors</th><th>From</th><th>Remarks</th></tr></thead>
          <tbody>{q.data.gradings.map((g) => (
            <tr key={g.id} className="clickable" onClick={() => setOpen(g.id)}>
              <td>{g.photoId ? <PhotoThumb id={g.photoId} size={48} /> : null}</td>
              <td className="nowrap">{stamp(g.createdAt)}</td>
              <td>{g.patientName ?? <span className="muted">not in Yarago</span>} <span className="muted small">{g.mrd}</span></td>
              <td>{g.eye ? EYE[g.eye] : "—"}</td>
              <td className="small">{modelName(g)}</td>
              <td>{g.status === "ok" ? <b>{gradeWords(g.aiGrade)}</b> : <span className="pill cancelled">Not graded</span>}</td>
              <td>{g.status === "ok" ? <ScreeningTag s={g.screening} /> : null}</td>
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
        {g.photoId && <a href={`/api/retina-ai/photos/${g.photoId}/image`} target="_blank" rel="noreferrer" title="Open full size">
          <img src={`/api/retina-ai/photos/${g.photoId}/image`} alt="Fundus photograph"
               style={{ width: "100%", maxHeight: "60vh", objectFit: "contain", background: "#000", borderRadius: 8 }} /></a>}
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

// ---------- evaluation sets (D-043) ----------
type Interval = [number, number] | null;
interface EvalResult {
  metrics: { n: number; patients: number; confusion: number[][]; accuracy: number | null; withinOne: number | null; macroF1: number | null; kappa: number | null; auroc: number | null;
             perClass: { grade: number; reference: number; recall: number | null; precision: number | null; specificity: number | null; f1: number }[];
             referable: { tp: number; fn: number; fp: number; tn: number; positives: number; negatives: number; sensitivity: number | null; specificity: number | null; ppv: number | null; npv: number | null } };
  intervals: Record<string, Interval>; cautions: string[]; bootstrap: { resamples: number; seed: number };
}
type Purpose = "validation" | "test" | "other";
interface EvalSet { id: number; name: string; notes: string; criteria: any; purpose: Purpose; createdAt: string; frozenAt: string | null; images: number; patients: number }
const PURPOSE: Record<Purpose, string> = { validation: "Validation (choose cut-offs)", test: "Test (check cut-offs once)", other: "Other" };
interface ScreeningResult {
  available: boolean; why?: string; refer: number; clear: number; source: string; fromValidation: boolean; cautions: string[];
  referSensitivity: number; clearSensitivity: number; ungradablePhotos: number;
  figures: { n: number; positives: number; negatives: number; refer: number; uncertain: number; routine: number; sensitivity: number | null;
             specificity: number | null; npv: number | null; referralRate: number | null; autoReferSensitivity: number | null;
             missedByGrade: { grade: number; eyes: number; missed: number }[]; missedIds: string[] };
  intervals: Record<"sensitivity" | "specificity" | "npv" | "referralRate", Interval>;
}
const ciText = (i: Interval, f: (x: number) => string) => (i ? ` (${f(i[0])} to ${f(i[1])})` : "");
const d3 = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(2));

function EvaluationTab() {
  const { can } = useAuth();
  const admin = can("settings.manage");
  const sets = useQuery({ queryKey: ["retina", "eval", "sets"], queryFn: () => api<{ sets: EvalSet[] }>("/retina-ai/eval/sets") });
  const [open, setOpen] = useState<number | null>(null);
  const [making, setMaking] = useState(false);
  const chosen = open ?? sets.data?.sets[0]?.id ?? null;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <section className="panel">
        <div className="panel-head"><h2 className="grow">Evaluation sets</h2>
          {admin && !making && <button onClick={() => setMaking(true)}>New evaluation set</button>}</div>
        <div className="panel-pad muted small" style={{ paddingBottom: 0 }}>A set fixes which photographs, and which doctor's grade of each, every model is measured on.
          Freeze it before reporting figures: a frozen set never changes. The reference is the doctor's fundus report.</div>
        {making && <NewEvalSet onDone={(id) => { setMaking(false); if (id) setOpen(id); }} />}
        {sets.error ? <div className="panel-pad"><ErrorNotice error={sets.error} /></div> : !sets.data ? <Loading /> : !sets.data.sets.length
          ? <div className="empty">No evaluation set yet.{admin ? " Make one once doctors have reported some photographs." : ""}</div>
          : <table className="list"><thead><tr><th>Set</th><th>Role</th><th>Images</th><th>Patients</th><th>Made</th><th>State</th></tr></thead>
              <tbody>{sets.data.sets.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => setOpen(s.id)} style={s.id === chosen ? { background: "var(--action-soft)" } : undefined}>
                  <td><b>{s.name}</b>{s.notes && <div className="muted small">{s.notes}</div>}</td><td className="small">{PURPOSE[s.purpose] ?? s.purpose}</td><td>{s.images}</td><td>{s.patients}</td>
                  <td className="nowrap small">{stamp(s.createdAt)}</td>
                  <td>{s.frozenAt ? <span className="pill completed">Frozen {niceDate(s.frozenAt.slice(0, 10), true)}</span> : <span className="pill waitlist">Draft</span>}</td></tr>))}
              </tbody></table>}
      </section>
      {chosen && <EvalSetResults id={chosen} sets={sets.data?.sets ?? []} onGone={() => setOpen(null)} />}
    </div>
  );
}

function NewEvalSet({ onDone }: { onDone: (id: number | null) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [blindedOnly, setBlinded] = useState(true);
  const [excludePoor, setPoor] = useState(false);
  const [maculaOnly, setMacula] = useState(false);
  const [purpose, setPurpose] = useState<Purpose>("other");
  const [camera, setCamera] = useState<"remidio" | "topcon">("remidio");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qs = new URLSearchParams(Object.entries({ from, to, blindedOnly: String(blindedOnly), excludePoor: String(excludePoor), maculaOnly: String(maculaOnly), purpose, camera }).filter(([, v]) => v)).toString();
  const preview = useQuery({ queryKey: ["retina", "eval", "candidates", qs], queryFn: () => api<any>(`/retina-ai/eval/candidates?${qs}`) });
  const p = preview.data;
  const make = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: number }>("/retina-ai/eval/sets", { body: { name, notes, from: from || undefined, to: to || undefined, blindedOnly, excludePoor, maculaOnly, purpose, camera } });
      toast(`Draft set "${name}" made`); await qc.invalidateQueries({ queryKey: ["retina", "eval"] }); onDone(r.id);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="panel-pad stack">
      <div className="fields">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Test set 2026 Q4" maxLength={80} /></label>
        <label className="field"><span>Photographs from</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>to</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field"><span>Role</span><select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)}>
          {(Object.keys(PURPOSE) as Purpose[]).map((k) => <option key={k} value={k}>{PURPOSE[k]}</option>)}</select></label>
        <label className="field"><span>Camera</span><select value={camera} onChange={(e) => setCamera(e.target.value as "remidio" | "topcon")}>
          <option value="remidio">Remidio FOP</option><option value="topcon">Topcon Maestro2</option></select></label>
        <label className="field wide"><span>Notes (optional)</span><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></label>
      </div>
      <label className="row small"><input type="checkbox" checked={blindedOnly} onChange={(e) => setBlinded(e.target.checked)} /> Only grades the doctor gave before seeing the AI grade (recommended)</label>
      <label className="row small"><input type="checkbox" checked={excludePoor} onChange={(e) => setPoor(e.target.checked)} /> Leave out photographs Remidio marked insufficient quality</label>
      <label className="row small"><input type="checkbox" checked={maculaOnly} onChange={(e) => setMacula(e.target.checked)} /> Macula-centred photographs only (the model was trained on these)</label>
      {preview.error ? <ErrorNotice error={preview.error} /> : p && <div className="notice">
        This set would hold <b>{p.images}</b> eye images of <b>{p.patients}</b> patients: by the doctor's grade {p.byGrade.map((n: number, g: number) => `${g}: ${n}`).join(", ")}
        {p.ungradable ? `, ${p.ungradable} not gradable` : ""}; <b>{p.referable}</b> referable (grade 2 or worse).
        {(p.left.notBlinded + p.left.poorQuality + p.left.notMacula + (p.left.otherRole ?? 0)) > 0 && <> Left out by the rules: {[p.left.notBlinded && `${p.left.notBlinded} graded after seeing the AI`, p.left.poorQuality && `${p.left.poorQuality} poor quality`, p.left.notMacula && `${p.left.notMacula} not macula-centred`, p.left.otherRole && `${p.left.otherRole} of patients already in a ${purpose === "test" ? "validation" : "test"} set`].filter(Boolean).join(", ")}.</>}
        {purpose !== "other" && <div className="small" style={{ marginTop: "0.3rem" }}>Patients already in a {purpose === "test" ? "validation" : "test"} set are left out, so the two never share a patient.
          {purpose === "test" ? " Make the test set once and look at it only after the cut-offs are fixed." : " Cut-offs are chosen on it, then applied unchanged to a test set."}</div>}
      </div>}
      <ErrorNotice error={error} />
      <div className="row"><span className="grow" /><button onClick={() => onDone(null)}>Cancel</button>
        <button className="btn-primary" disabled={busy || name.trim().length < 3 || !p?.images} onClick={() => void make()}>Make draft set</button></div>
    </div>
  );
}

function EvalSetResults({ id, sets, onGone }: { id: number; sets: EvalSet[]; onGone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [validation, setValidation] = useState("");
  const validations = sets.filter((s) => s.purpose === "validation" && s.frozenAt && s.id !== id);
  const q = useQuery({ queryKey: ["retina", "eval", "results", id, validation], queryFn: () => api<{ set: EvalSet & { frozenBy: string | null; createdBy: string }; reference: { ungradable: number; notBlinded: number; byGrade: number[] }; models: any[] }>(`/retina-ai/eval/sets/${id}/results${validation ? `?validation=${validation}` : ""}`) });
  const [confirm, setConfirm] = useState<"freeze" | "discard" | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const { set, reference, models } = q.data;
  const act = async (what: "freeze" | "discard") => {
    setError(null);
    try {
      if (what === "freeze") await api(`/retina-ai/eval/sets/${id}/freeze`, { method: "POST" });
      else await api(`/retina-ai/eval/sets/${id}`, { method: "DELETE" });
      toast(what === "freeze" ? "Set frozen: it can no longer change" : "Draft discarded");
      setConfirm(null); await qc.invalidateQueries({ queryKey: ["retina", "eval"] }); if (what === "discard") onGone();
    } catch (e) { setError(e); }
  };
  return (
    <section className="panel panel-pad stack">
      <div className="row"><h2 className="grow">{set.name} <span className="muted small">{PURPOSE[set.purpose] ?? set.purpose}</span></h2>
        {set.frozenAt ? <span className="pill completed">Frozen {stamp(set.frozenAt)} by {set.frozenBy}</span> : <span className="pill waitlist">Draft: figures may change until frozen</span>}</div>
      <div className="small muted">{set.images} eye images of {set.patients} patients. Doctor's grades: {reference.byGrade.map((n, g) => `${g}: ${n}`).join(", ")}
        {reference.ungradable ? `; ${reference.ungradable} not gradable (left out)` : ""}{reference.notBlinded ? `; ${reference.notBlinded} graded after seeing the AI` : ""}. Made by {set.createdBy}, {stamp(set.createdAt)}.</div>
      {can("settings.manage") && !set.frozenAt && (confirm
        ? <div className="row"><div className="notice grow">{confirm === "freeze" ? "Freeze this set? Its photographs and reference grades will never change again." : "Discard this draft set?"}</div>
            <button onClick={() => setConfirm(null)}>Back</button>
            <button className={confirm === "freeze" ? "btn-primary" : "btn-danger"} onClick={() => void act(confirm)}>{confirm === "freeze" ? "Yes, freeze" : "Yes, discard"}</button></div>
        : <div className="row"><button className="btn-primary" onClick={() => setConfirm("freeze")}>Freeze this set</button><button className="btn-danger" onClick={() => setConfirm("discard")}>Discard draft</button></div>)}
      <ErrorNotice error={error} />
      <label className="row small">Screening cut-offs:
        <select value={validation} onChange={(e) => setValidation(e.target.value)}>
          <option value="">Starting cut-offs (chosen on public APTOS images)</option>
          {validations.map((s) => <option key={s.id} value={s.id}>Chosen on validation set "{s.name}"</option>)}
        </select>{!validations.length && <span className="muted">No frozen validation set yet.</span>}</label>
      {!models.length ? <div className="empty">No model has graded these photographs yet.</div> : models.map((m) => <ModelResult key={m.sha} setId={id} m={m} />)}
    </section>
  );
}

function ModelResult({ setId, m }: { setId: number; m: any }) {
  const e: EvalResult = m.evaluation, x = e.metrics, i = e.intervals;
  const p = (v: number | null | undefined) => pct(v ?? null);
  return (
    <div className="panel panel-pad stack" style={{ borderLeft: "4px solid var(--choroid)" }}>
      <div className="row"><h3 className="grow">{m.repo ?? "Model"} <span className="muted small">weights {String(m.sha).slice(0, 12)}…, {m.graded} graded{m.notGraded ? `, ${m.notGraded} not graded by it` : ""}</span></h3>
        <a className="btn btn-small" href={`/api/retina-ai/eval/sets/${setId}/report.md?model=${m.sha}`}>Download report</a>
        <a className="btn btn-small" href={`/api/retina-ai/eval/sets/${setId}/export.csv?model=${m.sha}`}>Download CSV (no names)</a></div>
      {e.cautions.map((c) => <div key={c} className="notice">{c}</div>)}
      {m.screening && <ScreeningBlock s={m.screening} />}
      <h4>Five-class grading (secondary)</h4>
      <div className="stat-strip">
        <div className="stat"><b>{p(x.referable.sensitivity)}</b><span>referable DR found{ciText(i.sensitivity, pct)}; {x.referable.tp} of {x.referable.positives}</span></div>
        <div className="stat"><b>{p(x.referable.specificity)}</b><span>no referable DR, AI agreed{ciText(i.specificity, pct)}; {x.referable.tn} of {x.referable.negatives}</span></div>
        <div className="stat"><b>{d3(x.auroc)}</b><span>AUROC, referable{ciText(i.auroc, d3)}</span></div>
        <div className="stat"><b>{d3(x.kappa)}</b><span>weighted kappa{ciText(i.kappa, d3)}</span></div>
        <div className="stat"><b>{d3(x.macroF1)}</b><span>macro-F1{ciText(i.macroF1, d3)}</span></div>
        <div className="stat"><b>{p(x.accuracy)}</b><span>same grade{ciText(i.accuracy, pct)}</span></div>
      </div>
      <div className="scroll-x"><table className="list compact">
        <thead><tr><th>Doctor's grade</th><th>Images</th><th>Recall</th><th>Precision</th><th>Specificity</th>{[0, 1, 2, 3, 4].map((g) => <th key={g}>AI {g}</th>)}</tr></thead>
        <tbody>{x.perClass.map((c) => (
          <tr key={c.grade}><th>{c.grade} · {GRADES[c.grade]}</th><td>{c.reference}</td><td>{p(c.recall)}<span className="muted small">{ciText(i[`recall${c.grade}`], pct)}</span></td>
            <td>{p(c.precision)}</td><td>{p(c.specificity)}</td>
            {x.confusion[c.grade].map((n, g) => <td key={g} style={g === c.grade ? { fontWeight: 700, background: "var(--action-soft)" } : undefined}>{n || ""}</td>)}</tr>))}</tbody>
      </table></div>
      <div className="muted small">Referable DR = grade 2 or worse. 95% intervals in brackets: {e.bootstrap.resamples} resamples of whole patients, seed {e.bootstrap.seed}.
        Research use only: these figures do not make the model fit for clinical use.</div>
    </div>
  );
}

/** Three-outcome screening figures of one model on a set (D-045): the primary outcome. */
function ScreeningBlock({ s }: { s: ScreeningResult }) {
  if (!s.available) return <div className="muted small">Screening: {s.why}.</div>;
  const f = s.figures, i = s.intervals;
  const severe = f.missedByGrade.filter((g) => g.grade >= 3).reduce((n, g) => n + g.missed, 0);
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <h4>Screening: does the eye need an ophthalmologist? (primary)</h4>
      {s.cautions.map((c) => <div key={c} className="notice">{c}</div>)}
      <div className="stat-strip">
        <div className="stat"><b>{pct(f.sensitivity)}</b><span>referable eyes not cleared{ciText(i.sensitivity, pct)}; {f.positives} referable</span></div>
        <div className="stat"><b style={severe ? { color: "var(--vessel)" } : undefined}>{severe}</b><span>severe NPDR / PDR eyes cleared</span></div>
        <div className="stat"><b>{pct(f.specificity)}</b><span>non-referable eyes cleared{ciText(i.specificity, pct)}</span></div>
        <div className="stat"><b>{pct(f.npv)}</b><span>NPV: cleared eyes truly non-referable{ciText(i.npv, pct)}</span></div>
        <div className="stat"><b>{pct(f.referralRate)}</b><span>seen by a person (refer + uncertain){ciText(i.referralRate, pct)}</span></div>
      </div>
      <table className="list compact"><tbody>
        <tr><th>Outcomes</th><td>{f.refer} refer · {f.uncertain} uncertain · {f.routine} routine, of {f.n} images{s.ungradablePhotos ? ` (${s.ungradablePhotos} insufficient-quality photographs are always uncertain)` : ""}</td></tr>
        <tr><th>Referable eyes cleared</th><td>{f.missedByGrade.map((g) => `${GRADES[g.grade]} ${g.missed} of ${g.eyes}`).join(" · ")}{f.missedIds.length ? `; severe/PDR images: ${f.missedIds.join(", ")}` : ""}</td></tr>
        <tr><th>Cut-offs</th><td className="small">refer at {s.refer.toPrecision(3)} or above, routine below {s.clear.toPrecision(3)} (referral score p2+p3+p4); {s.source}.
          {s.fromValidation && ` Chosen to keep ${pct(s.referSensitivity)} (refer) and ${pct(s.clearSensitivity)} (clear) of referable validation eyes.`}</td></tr>
      </tbody></table>
      <div className="muted small">Cleared = routine. Proposed acceptance before any assisted use: sensitivity at least 95% with the lower bound at least 90%, no severe NPDR or PDR cleared,
        NPV at least 98%. Intervals resample whole patients. The DR outcome alone never clears a patient.</div>
    </div>
  );
}

// ---------- the grader ----------
function SystemTab() {
  const q = useQuery({ queryKey: ["retina", "status"], refetchInterval: 30_000, queryFn: () => api<any>("/retina-ai/status") });
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const { grader: g, counts: c, graders } = q.data;
  return (
    <section className="panel panel-pad stack">
      <h3>Graders switched on (each Remidio and Maestro2 photograph is graded by every one)</h3>
      <table className="list compact">
        <thead><tr><th>Grader</th><th>Model</th><th>State</th><th>Screening cut-offs</th></tr></thead>
        <tbody>{(graders ?? []).map((x: any) => (
          <tr key={x.key}><td>{x.key}</td><td className="small">{x.modelSha256 ? `${modelName(x)} · ${x.modelSha256.slice(0, 12)}…` : "—"}</td>
            <td>{x.ready ? <span className="pill completed">Ready</span> : !x.keySet ? <span className="pill cancelled">Key not set</span>
              : !x.reachable ? <span className="pill cancelled">Not answering</span> : <span className="pill waitlist">Not ready</span>}</td>
            <td className="small">{x.cutoffs ? `refer ≥ ${x.cutoffs.refer.toPrecision(3)}, routine < ${x.cutoffs.clear.toPrecision(3)} (${x.cutoffs.source})` : "none: no outcome shown"}</td></tr>))}
        </tbody></table>
      <div className="muted small">RFM's key comes from scripts\setup-rfm.ps1; the list is the setting retina.graders. Below: the Arko007 grader (used for uploads).</div>
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
      <div className="muted small">Folder import runs on the server console: see RUNBOOK, "Retina AI".</div>
      <RemidioPanel />
      <TopconPanel />
    </section>
  );
}

const MODE_WORDS: Record<string, string> = {
  off: "Off: Sudarshan does not read Remidio's queue",
  peek: "Peek: looks at the next queue item and shows its fields; takes nothing",
  on: "On: photographs are stored here and taken off Remidio's queue",
};
function RemidioPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["retina", "remidio"], refetchInterval: 30_000, queryFn: () => api<any>("/retina-ai/remidio") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const r = q.data, admin = can("settings.manage");
  const change = async (body: object, words: string) => {
    setBusy(true); setError(null);
    try { await api("/retina-ai/remidio", { method: "PUT", body }); toast(words); await qc.invalidateQueries({ queryKey: ["retina"] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const checkNow = async () => {
    setBusy(true); setError(null);
    try { const x = await api<{ result: string }>("/retina-ai/remidio/check-now", { method: "POST" }); toast(`Remidio: ${x.result}`); await qc.invalidateQueries({ queryKey: ["retina"] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: "0.8rem" }}>
      <h2>Photographs from Remidio (site {r.site})</h2>
      {!r.ready && <div className="notice">Remidio is not set up yet: an admin runs <code>scripts\setup-remidio.ps1</code> on shichika.</div>}
      <div className="row">
        <span className="grow"><b>{MODE_WORDS[r.mode]}</b></span>
        {admin && <div className="seg" role="group" aria-label="Receiver">
          {(["off", "peek", "on"] as const).map((m) =>
            <button key={m} aria-pressed={r.mode === m} disabled={busy || !r.ready} onClick={() => void change({ mode: m }, `Receiver ${m}`)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
        </div>}
        {admin && r.mode !== "off" && <button disabled={busy} onClick={() => void checkNow()}>Check now</button>}
      </div>
      <div className="small muted">Remidio Connect &gt; Sites &gt; Integration Settings &gt; Cloud Data Queue must also be On. Sudarshan looks every minute.</div>
      {admin && <label className="row small">Photographs whose MRN is not a Yarago SPD number:
        <select value={r.unmatched} disabled={busy} onChange={(e) => void change({ unmatched: e.target.value }, "Saved")}>
          <option value="keep">keep them, unlinked</option><option value="skip">do not keep them</option></select></label>}
      <ErrorNotice error={error} />
      <table className="list compact"><tbody>
        <tr><th>Last look</th><td>{r.lastPoll.at ? `${stamp(r.lastPoll.at)}: ${r.lastPoll.result}` : r.lastPoll.result}
          {r.lastPoll.queueHttp ? <span className="muted"> (queue answered HTTP {r.lastPoll.queueHttp})</span> : null}
          {r.lastPoll.error && <div className="small" style={{ color: "var(--vessel)" }}>{r.lastPoll.error}</div>}</td></tr>
        <tr><th>Photographs kept</th><td>{r.counts.photos}{r.counts.unmatched ? `, ${r.counts.unmatched} not linked to a Yarago patient` : ""}{r.counts.toGrade ? `, ${r.counts.toGrade} waiting for the AI grade` : ""}{r.counts.lastPhotoAt ? `; last ${stamp(r.counts.lastPhotoAt)}` : ""}</td></tr>
      </tbody></table>
      {!!r.recent.length && <>
        <div className="small"><b>Latest queue items</b> (fields only, no patient details)</div>
        <table className="list compact"><tbody>{r.recent.map((x: any, i: number) => (
          <tr key={i}><td className="nowrap small">{stamp(x.at)}</td><td className="small">{x.itemType ?? "—"}</td><td className="small"><b>{x.outcome}</b></td>
            <td className="small">{x.message}{x.fields && <div className="muted">{x.fields.join(", ")}</div>}</td></tr>))}</tbody></table>
      </>}
    </div>
  );
}

// ---------- photographs from the Topcon Maestro2 (D-048) ----------
const TOPCON_MODE_WORDS: Record<string, string> = {
  off: "Off: Sudarshan does not look at IMAGEnet's exams",
  peek: "Peek: converts the next new exam and shows what it holds; keeps nothing",
  on: "On: each new exam's colour fundus photograph is kept here (IMAGEnet is only read)",
};
function TopconPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["retina", "topcon"], refetchInterval: 30_000, queryFn: () => api<any>("/retina-ai/topcon") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [since, setSince] = useState("");
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const r = q.data, admin = can("settings.manage");
  const change = async (body: object, words: string) => {
    setBusy(true); setError(null);
    try { await api("/retina-ai/topcon", { method: "PUT", body }); toast(words); await qc.invalidateQueries({ queryKey: ["retina"] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const checkNow = async () => {
    setBusy(true); setError(null);
    try { const x = await api<{ result: string }>("/retina-ai/topcon/check-now", { method: "POST" }); toast(`Maestro2: ${x.result}`); await qc.invalidateQueries({ queryKey: ["retina"] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: "0.8rem" }}>
      <h2>Photographs from the Topcon Maestro2</h2>
      {!r.ready && <div className="notice">Not set up yet: missing {r.missing.join(", ")}. An admin runs <code>scripts\setup-topcon.ps1</code> on shichika (RUNBOOK 13).</div>}
      <div className="row">
        <span className="grow"><b>{TOPCON_MODE_WORDS[r.mode]}</b></span>
        {admin && <div className="seg" role="group" aria-label="Maestro2 import">
          {(["off", "peek", "on"] as const).map((m) =>
            <button key={m} aria-pressed={r.mode === m} disabled={busy || !r.ready} onClick={() => void change({ mode: m }, `Maestro2 import ${m}`)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
        </div>}
        {admin && r.mode !== "off" && <button disabled={busy} onClick={() => void checkNow()}>Check now</button>}
      </div>
      <div className="small muted">Reads {r.share} (read only) every minute. Exams saved {r.since ? <>from <b>{stamp(r.since)}</b> on</> : "from the moment the import is first switched on"} are imported, each once it has not changed for 2 minutes; IMAGEnet keeps its own copy.</div>
      {admin && <div className="row small">
        <label className="row small">Import exams saved from <input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} /></label>
        <button disabled={busy || !since} onClick={() => void change({ since: new Date(since).toISOString() }, "Start point saved")}>Set</button>
        <span className="muted">Earlier exams are converted a few a minute; IMAGEnet holds years of them.</span>
      </div>}
      {admin && <label className="row small">Photographs whose patient ID is not a Yarago SPD number:
        <select value={r.unmatched} disabled={busy} onChange={(e) => void change({ unmatched: e.target.value }, "Saved")}>
          <option value="keep">keep them, unlinked</option><option value="skip">do not keep them</option></select></label>}
      <ErrorNotice error={error} />
      <table className="list compact"><tbody>
        <tr><th>Last look</th><td>{r.lastRun.at ? `${stamp(r.lastRun.at)}: ${r.lastRun.result}` : r.lastRun.result}
          {r.lastRun.waiting ? <span className="muted"> ({r.lastRun.waiting} exam{r.lastRun.waiting === 1 ? "" : "s"} waiting)</span> : null}
          {r.lastRun.error && <div className="small" style={{ color: "var(--vessel)" }}>{r.lastRun.error}</div>}</td></tr>
        <tr><th>Photographs kept</th><td>{r.counts.photos}{r.counts.unmatched ? `, ${r.counts.unmatched} not linked to a Yarago patient` : ""}{r.counts.toGrade ? `, ${r.counts.toGrade} waiting for the AI grade` : ""}{r.counts.lastPhotoAt ? `; last ${stamp(r.counts.lastPhotoAt)}` : ""}</td></tr>
        <tr><th>OCT / OCTA scans kept</th><td>{r.counts.scans ?? 0}{r.counts.octaScans ? ` (${r.counts.octaScans} OCTA)` : ""}{r.counts.scanBytes ? `, ${(Number(r.counts.scanBytes) / 1e9).toFixed(1)} GB` : ""}</td></tr>
      </tbody></table>
      {!!r.recent.length && <>
        <div className="small"><b>Latest exams</b> (IMAGEnet file numbers and shapes only, no patient details)</div>
        <table className="list compact"><tbody>{r.recent.map((x: any, i: number) => (
          <tr key={i}><td className="nowrap small">{stamp(x.at)}</td><td className="small">{x.fileName}</td><td className="small"><b>{x.outcome.replace("_", " ")}</b></td>
            <td className="small">{x.message}</td></tr>))}</tbody></table>
      </>}
      <div className="muted small">Maestro2 photographs are a different camera from the Remidio FOP: their AI figures are measured on their own evaluation sets (Evaluation tab, camera "Topcon Maestro2"), never mixed with Remidio's.</div>
    </div>
  );
}