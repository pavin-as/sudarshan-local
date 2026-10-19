// Direct calls: patients who phone the clinic. Log the call, then book it or close it with a reason.
// Open calls are listed emergencies first, then the longest waiting.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { addDays, dayLabel, stamp, todayIST } from "../format";
import { Dialog, ErrorNotice, Loading, useToast } from "../components/ui";
import { BookDialog, useMeta } from "../components/BookDialog";
import { PatientPicker, type PickedPatient } from "../components/PatientPicker";
import { AppointmentDrawer } from "../components/AppointmentDrawer";

export interface DirectCall {
  id: number; patientId: number | null; mrd: string | null; patientName: string; phone: string | null; ageYears: number | null; gender: string | null;
  patientType: string | null; callType: string | null; caseType: string | null; urgency: string | null; remarks: string | null; status: string;
  doctorId: number | null; doctorName: string | null; createdAt: string; createdBy: string; closedAt: string | null; closedBy: string | null;
  closeReason: string | null; appointmentId: number | null; appointmentDate: string | null; appointmentTime: string | null; appointmentStatus: string | null;
}
type View = "open" | "booked" | "closed";

export function useDirectCalls(view: View, search = "") {
  return useQuery({
    queryKey: ["direct-calls", view, search],
    refetchInterval: view === "open" ? 60_000 : false,
    queryFn: () => api<{ calls: DirectCall[]; counts: Record<string, number> }>(`/direct-calls?view=${view}${search ? `&q=${encodeURIComponent(search)}` : ""}`),
  });
}

function UrgencyTag({ u }: { u: string | null }) {
  if (!u || u === "Non-urgent") return <span className="muted small nowrap">Not urgent</span>;
  return <span className={`tag ${u === "Emergency" ? "alert" : "vip"}`}>{u}</span>;
}

function LogCallDialog({ call, onClose }: { call?: DirectCall; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [isNew, setIsNew] = useState(!!call && !call.patientId);
  const [f, setF] = useState({
    patientName: call?.patientName ?? "", phone: call?.phone ?? "", age: call?.ageYears != null ? String(call.ageYears) : "", gender: call?.gender ?? "",
    callType: call?.callType ?? "Appointment", caseType: call?.caseType ?? "Non referral", urgency: call?.urgency ?? "Non-urgent",
    doctorId: call?.doctorId ?? null as number | null, remarks: call?.remarks ?? "",
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null); setBusy(true);
    try {
      const common = { callType: f.callType, caseType: f.caseType || null, urgency: f.urgency, remarks: f.remarks.trim() || null, doctorId: f.doctorId };
      if (call) {
        await api(`/direct-calls/${call.id}`, { method: "PATCH", body: { ...common,
          ...(call.patientId ? {} : { patientName: f.patientName.trim(), phone: f.phone.trim() || null, ageYears: f.age ? Number(f.age) : null, gender: f.gender || null }) } });
        toast(`Saved the call from ${call.patientName}`);
      } else {
        if (!patient && !(isNew && f.patientName.trim())) throw new Error("Choose the patient from Yarago, or enter a new patient's name");
        await api("/direct-calls", { body: { ...common, ...(patient ? { patientId: patient.patientId }
          : { patientName: f.patientName.trim(), phone: f.phone.trim() || null, ageYears: f.age ? Number(f.age) : null, gender: f.gender || null }) } });
        toast(`Call logged: ${patient?.name ?? f.patientName.trim()}`);
      }
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const seg = (key: "callType" | "caseType" | "urgency", options: string[], label: string) => (
    <div className="field"><span>{label}</span>
      <div className="seg" role="group" aria-label={label}>{options.map((o) => (
        <button key={o} type="button" aria-pressed={f[key] === o} onClick={() => setF({ ...f, [key]: o })}>{o}</button>))}</div></div>);
  return (
    <Dialog title={call ? `Call from ${call.patientName}` : "Log a direct call"} onClose={onClose}
      foot={<><button onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={() => void save()}>{call ? "Save" : "Log call"}</button></>}>
      <section className="stack">
        <h3>Patient</h3>
        {call ? (call.patientId
          ? <div className="chosen"><b>{call.patientName}</b> <span className="muted">{call.mrd}{call.phone && `, ${call.phone}`}</span></div>
          : null)
          : patient ? (
            <div className="chosen"><div className="grow"><b>{patient.name}</b> <span className="muted">{patient.mrd}{patient.mobile && `, ${patient.mobile}`}</span></div>
              <button className="btn-small" onClick={() => setPatient(null)}>Change</button></div>
          ) : !isNew ? (
            <><PatientPicker onPick={setPatient} autoFocus />
              <div><button className="btn-quiet" onClick={() => setIsNew(true)}>New patient, not in Yarago yet</button></div></>
          ) : null}
        {(isNew || (call && !call.patientId)) && (
          <div className="fields">
            <label className="field wide"><span>Name</span><input value={f.patientName} autoFocus onChange={(e) => setF({ ...f, patientName: e.target.value })} /></label>
            <label className="field"><span>Phone</span><input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            <label className="field"><span>Age</span><input value={f.age} inputMode="numeric" onChange={(e) => setF({ ...f, age: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="field"><span>Gender</span>
              <select value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}><option value="" /><option>Female</option><option>Male</option><option>Other</option></select></label>
            {!call && <div className="wide"><button className="btn-quiet" onClick={() => setIsNew(false)}>Search Yarago instead</button></div>}
          </div>)}
      </section>
      <section className="fields">
        {seg("callType", ["Appointment", "Enquiry"], "The patient wants")}
        {seg("caseType", ["Non referral", "Referral"], "Referred by a doctor?")}
        {seg("urgency", ["Non-urgent", "Urgent", "Emergency"], "Urgency")}
        <label className="field"><span>Doctor (if asked for)</span>
          <select value={f.doctorId ?? ""} onChange={(e) => setF({ ...f, doctorId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Any</option>{(meta.data?.doctors ?? []).filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="field wide"><span>What the caller said</span><textarea value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} placeholder="Complaint, referral details, preferred day..." /></label>
      </section>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

function CloseDialog({ call, onClose }: { call: DirectCall; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<"answered" | "not_booked">(call.callType === "Enquiry" ? "answered" : "not_booked");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/direct-calls/${call.id}/close`, { body: { outcome, reason } });
      toast(`Closed the call from ${call.patientName}`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Dialog narrow title={`Close the call from ${call.patientName}`} onClose={onClose}
      foot={<><button onClick={onClose}>Back</button><button className="btn-primary" disabled={reason.trim().length < 2} onClick={() => void save()}>Close call</button></>}>
      <div className="stack">
        <label className="check"><input type="radio" checked={outcome === "answered"} onChange={() => setOutcome("answered")} />Enquiry answered, no appointment needed</label>
        <label className="check"><input type="radio" checked={outcome === "not_booked"} onChange={() => setOutcome("not_booked")} />Patient did not want an appointment</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (e.g. asked about fees; will come later; went elsewhere)" autoFocus />
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}

export function DirectCallsPage() {
  const { can } = useAuth();
  const write = can("appointments.write");
  const [view, setView] = useState<View>("open");
  const [search, setSearch] = useState("");
  const [logging, setLogging] = useState<DirectCall | "new" | null>(null);
  const [closing, setClosing] = useState<DirectCall | null>(null);
  const [booking, setBooking] = useState<DirectCall | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const list = useDirectCalls(view, search.trim());
  const counts = list.data?.counts ?? {};

  const reopen = async (c: DirectCall) => {
    await api(`/direct-calls/${c.id}/reopen`, { body: {} });
    toast(`Opened the call from ${c.patientName} again`);
    await qc.invalidateQueries();
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Direct calls</h1><div className="muted">Patients who phoned. Book them, or close the call with a reason.</div></div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which calls">
          <button aria-pressed={view === "open"} onClick={() => setView("open")}>Open{counts.open ? ` (${counts.open})` : ""}</button>
          <button aria-pressed={view === "booked"} onClick={() => setView("booked")}>Booked</button>
          <button aria-pressed={view === "closed"} onClick={() => setView("closed")}>Closed</button>
        </div>
        <input type="search" placeholder="Name, MRD or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search calls" />
        {write && <button className="btn-primary" onClick={() => setLogging("new")}>Log a call</button>}
      </div>
      {list.error && <ErrorNotice error={list.error} />}
      <div className="panel">
        {list.isLoading ? <Loading /> : !list.data?.calls.length ? <div className="empty">{view === "open" ? "No open calls." : "Nothing here."}</div> : (
          <table className="list">
            <thead><tr><th>Received</th><th>Patient</th><th>Wants</th><th>Urgency</th><th>What they said</th>
              <th>{view === "booked" ? "Booked for" : view === "closed" ? "Closed" : ""}</th></tr></thead>
            <tbody>{list.data.calls.map((c) => (
              <tr key={c.id}>
                <td className="nowrap small">{stamp(c.createdAt)}{c.createdBy && <div className="muted">{c.createdBy}</div>}</td>
                <td>{c.patientId ? <Link to={`/patients/${c.patientId}`}><b>{c.patientName}</b></Link> : <b>{c.patientName}</b>}
                  {" "}<span className="muted small">{c.mrd ?? "new patient"}</span>
                  <div className="small">{c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>}{[c.ageYears != null && `${c.ageYears} y`, c.gender].filter(Boolean).map((x) => `, ${x}`)}</div></td>
                <td className="small">{c.callType}{c.caseType === "Referral" && <div className="muted">referral</div>}{c.doctorName && <div className="muted">{c.doctorName}</div>}</td>
                <td><UrgencyTag u={c.urgency} /></td>
                <td className="small">{c.remarks}</td>
                <td className="right">
                  {view === "open" && write && <div className="row actions">
                    <button className="btn-small" onClick={() => setLogging(c)}>Edit</button>
                    <button className="btn-small" onClick={() => setClosing(c)}>Close</button>
                    <button className="btn-small btn-primary" onClick={() => setBooking(c)}>Book</button></div>}
                  {view === "booked" && c.appointmentId && <button className="btn-quiet btn-small" onClick={() => setOpenId(c.appointmentId!)}>
                    {c.appointmentDate ? `${dayLabel(c.appointmentDate)} ${c.appointmentTime ?? "waitlist"}` : "Open booking"}</button>}
                  {view === "closed" && <div className="small" style={{ textAlign: "left" }}>
                    <b>{c.status === "archived" ? "Answered" : "Not booked"}</b>{c.closeReason && `: ${c.closeReason}`}
                    <div className="muted">{c.closedBy}{c.closedAt && `, ${stamp(c.closedAt)}`}</div>
                    {write && <button className="btn-quiet btn-small" onClick={() => void reopen(c)}>Open again</button>}</div>}
                </td>
              </tr>))}</tbody>
          </table>)}
      </div>

      {logging && <LogCallDialog call={logging === "new" ? undefined : logging} onClose={() => setLogging(null)} />}
      {closing && <CloseDialog call={closing} onClose={() => setClosing(null)} />}
      {booking && <BookDialog onClose={() => setBooking(null)}
        preset={{ date: addDays(todayIST(), 1), source: "direct_call", sourceRef: String(booking.id), remarks: booking.remarks ?? undefined,
                  urgency: booking.urgency && booking.urgency !== "Non-urgent" ? booking.urgency : undefined, doctorId: booking.doctorId,
                  ...(booking.patientId
                    ? { patient: { patientId: booking.patientId, mrd: booking.mrd ?? "", name: booking.patientName, mobile: booking.phone, ageYears: booking.ageYears, sex: booking.gender, lastVisit: null } }
                    : { newPatient: { name: booking.patientName, phone: booking.phone, ageYears: booking.ageYears, gender: booking.gender } }) }} />}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
