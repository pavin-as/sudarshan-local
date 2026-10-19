import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Appointment } from "../api";
import { useAuth } from "../auth";
import { clock, dayLabel, niceDate, stamp, todayIST, planText, planEditText } from "../format";
import { Drawer, ErrorNotice, Loading, StageTrack, StatusPill, Tags, useToast } from "./ui";
import { COMMON_TAGS, useMeta } from "./BookDialog";
import { DateStrip, SlotPicker } from "./SlotPicker";
import { PatientPicker } from "./PatientPicker";
import { RuleCheckPanel, RuleNotes, useDayRules } from "./RuleNotes";

interface Event { id: number; at: string; type: string; by: string | null; from: any; to: any; note: string | null }

const EVENT_WORDS: Record<string, string> = {
  booked: "Booked", rescheduled: "Rescheduled", confirmed_4day: "4-day confirmation call", confirmed_1day: "1-day confirmation call",
  cancelled: "Cancelled", restored: "Restored", checked_in: "Checked in", completed: "Completed", no_show: "Did not come",
  remark: "Remark", tag_added: "Tag added", tag_removed: "Tag removed", moved_from_waitlist: "Given a slot from the waitlist", imported: "Imported from the Google app",
};
const where = (v: any) => (v?.date ? `${niceDate(v.date)} ${v.slot ?? "waitlist"}` : "");

function eventText(e: Event): string {
  if (["rescheduled", "restored", "moved_from_waitlist"].includes(e.type)) return `${where(e.from)} → ${where(e.to)}`;
  if (e.type === "booked") return where(e.to);
  if (e.type === "tag_added") return String(e.to);
  if (e.type === "tag_removed") return String(e.from);
  if (e.type === "imported") return "";
  return "";
}

type Mode = null | "move" | "cancel" | "edit" | "remark";

export function AppointmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const q = useQuery({ queryKey: ["appointment", id], queryFn: () => api<{ appointment: Appointment; events: Event[] }>(`/appointments/${id}`) });
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // form state for the open action
  const [moveDate, setMoveDate] = useState("");
  const [moveSlot, setMoveSlot] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [edit, setEdit] = useState<any>({});

  const a = q.data?.appointment;
  const write = can("appointments.write");
  const dayRules = useDayRules(a && a.status !== "cancelled" ? a.date : null);
  const myRules = a ? (dayRules.data?.findings ?? []).filter((f) => f.ids.includes(a.id)) : [];

  const run = async (path: string, body: unknown, done: string, method = "POST") => {
    setBusy(true); setError(null);
    try {
      const r = await api(`/appointments/${id}${path}`, { method, body });
      toast(done);
      for (const w of r?.warnings ?? []) toast(w, "warn");
      setMode(null); setText("");
      await qc.invalidateQueries();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!a) return <Drawer title="Appointment" onClose={onClose}>{q.error ? <ErrorNotice error={q.error} /> : <Loading />}</Drawer>;

  const open = (m: Mode) => {
    setError(null); setMode(m); setText("");
    if (m === "move") { setMoveDate(a.date); setMoveSlot(a.slotTime); }
    if (m === "edit") setEdit({ planOfAction: planEditText(a.planOfAction), remarks: a.remarks ?? "", appointmentType: a.appointmentType ?? "",
                                 urgency: a.urgency ?? "", familyGroup: a.familyGroup ?? "", phone: a.phone ?? "", doctorId: a.doctorId, tags: a.tags });
  };
  const active = ["booked", "confirmed", "waitlist"].includes(a.status);

  return (
    <Drawer
      title={a.patientName}
      sub={<span className="row" style={{ gap: "0.5rem" }}>{a.mrd ?? "New patient"} <StatusPill status={a.status} />{a.liveStage && <StageTrack stage={a.liveStage} />}</span>}
      onClose={onClose}
      foot={write && !mode && (
        <>
          {a.status !== "cancelled" && active && <button className="btn-danger" onClick={() => open("cancel")}>Cancel appointment</button>}
          <span className="grow" />
          <button onClick={() => open("remark")}>Add remark</button>
          {active && <button onClick={() => open("edit")}>Edit</button>}
          {(active || a.status === "cancelled") && <button className="btn-primary" onClick={() => open("move")}>{a.status === "cancelled" ? "Restore" : a.status === "waitlist" ? "Give a slot" : "Reschedule"}</button>}
        </>
      )}>
      <dl className="facts">
        <dt>When</dt><dd><b>{dayLabel(a.date)}</b> {a.slotTime ?? "waitlist"}{a.doctorName && `, ${a.doctorName}`}</dd>
        {a.planOfAction && <><dt>Plan</dt><dd>{planText(a.planOfAction)}</dd></>}
        {(a.appointmentType || a.patientType) && <><dt>Visit</dt><dd>{[a.appointmentType, a.patientType].filter(Boolean).join(", ")}</dd></>}
        {a.phone && <><dt>Phone</dt><dd><a href={`tel:${a.phone}`}>{a.phone}</a></dd></>}
        {(a.ageYears != null || a.gender) && <><dt>Patient</dt><dd>{[a.ageYears != null && `${a.ageYears} years`, a.gender].filter(Boolean).join(", ")}</dd></>}
        {a.tags.length > 0 && <><dt>Special</dt><dd><Tags tags={a.tags} /></dd></>}
        {a.urgency && <><dt>Urgency</dt><dd>{a.urgency}</dd></>}
        {a.familyGroup && <><dt>Family</dt><dd>{a.familyGroup}</dd></>}
        {a.remarks && <><dt>Remarks</dt><dd style={{ whiteSpace: "pre-wrap" }}>{a.remarks}</dd></>}
        {a.status === "cancelled" && <><dt>Cancelled</dt><dd>{stamp(a.cancelledAt)}: {a.cancelReason}</dd></>}
        {a.checkInAt && <><dt>In clinic</dt><dd>checked in {clock(a.checkInAt)}{a.checkOutAt && `, out ${clock(a.checkOutAt)}`}</dd></>}
        <dt>Booked</dt><dd>{a.bookedBy ?? (a.source === "import" ? "in the Google app" : "unknown")}, {stamp(a.bookedAt)}</dd>
      </dl>
      {myRules.length > 0 && !mode && (
        <section className="stack"><h3>Scheduling rules</h3><RuleNotes findings={myRules} /></section>)}
      {a.patientId ? <div><Link to={`/patients/${a.patientId}`} onClick={onClose}>Open patient record</Link></div>
        : write && (
          <div className="notice stack" style={{ gap: "0.4rem" }}>
            <span>Not linked to a Yarago patient yet, so arrival is not tracked. Once registered in Yarago, link it here:</span>
            <PatientPicker onPick={(p) => void run("/link", { patientId: p.patientId }, `Linked to ${p.name} (${p.mrd})`)} />
          </div>)}

      {write && active && a.status !== "waitlist" && !mode && (
        <div className="row">
          <button className="btn-small" disabled={busy || !!a.confirmed4dayAt} onClick={() => void run("/confirm", { stage: "4day" }, "4-day confirmation saved")}>
            {a.confirmed4dayAt ? `4-day confirmed ${stamp(a.confirmed4dayAt)}` : "Confirmed (4-day call)"}</button>
          <button className="btn-small" disabled={busy || !!a.confirmed1dayAt} onClick={() => void run("/confirm", { stage: "1day" }, "1-day confirmation saved")}>
            {a.confirmed1dayAt ? `1-day confirmed ${stamp(a.confirmed1dayAt)}` : "Confirmed (1-day call)"}</button>
          {a.date <= todayIST() && <>
            <button className="btn-small" disabled={busy} onClick={() => void run("/status", { status: "checked_in" }, "Marked as arrived")}>Arrived</button>
            <button className="btn-small btn-danger" disabled={busy} onClick={() => void run("/status", { status: "no_show" }, "Marked as did not come")}>Did not come</button>
          </>}
        </div>
      )}

      {mode && (
        <section className="panel panel-pad stack">
          {mode === "move" && <>
            <h3>{a.status === "cancelled" ? "Restore to" : "Move to"}</h3>
            <DateStrip value={moveDate} onChange={(d) => { setMoveDate(d); setMoveSlot(null); }} />
            <SlotPicker date={moveDate} value={moveSlot} onChange={setMoveSlot} doctorId={a.doctorId} ignoreAppointmentId={a.id} />
            <input placeholder="Reason (optional)" value={text} onChange={(e) => setText(e.target.value)} />
            <RuleCheckPanel body={moveDate ? { date: moveDate, slotTime: moveSlot, appointmentId: a.id } : null} />
          </>}
          {mode === "cancel" && <>
            <h3>Cancel this appointment</h3>
            <input placeholder="Why? (patient asked, unwell, travelling…)" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </>}
          {mode === "remark" && <>
            <h3>Add remark</h3>
            <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </>}
          {mode === "edit" && <div className="fields">
            <label className="field wide"><span>Plan of action</span>
              <input list="plans-e" value={edit.planOfAction} onChange={(e) => setEdit({ ...edit, planOfAction: e.target.value })} />
              <datalist id="plans-e">{(meta.data?.plansOfAction ?? []).map((p) => <option key={p.name} value={p.name} />)}</datalist></label>
            <label className="field"><span>Visit type</span><input value={edit.appointmentType} onChange={(e) => setEdit({ ...edit, appointmentType: e.target.value })} /></label>
            <label className="field"><span>Doctor</span>
              <select value={edit.doctorId ?? ""} onChange={(e) => setEdit({ ...edit, doctorId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Any</option>{(meta.data?.doctors ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="field"><span>Phone</span><input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
            <label className="field"><span>Urgency</span>
              <select value={edit.urgency} onChange={(e) => setEdit({ ...edit, urgency: e.target.value })}><option value="">Routine</option><option>Urgent</option><option>Emergency</option></select></label>
            <label className="field"><span>Family group</span><input value={edit.familyGroup} onChange={(e) => setEdit({ ...edit, familyGroup: e.target.value })} /></label>
            <div className="wide row">{[...new Set([...COMMON_TAGS, ...edit.tags])].map((t: string) => (
              <label key={t} className="check"><input type="checkbox" checked={edit.tags.includes(t)}
                onChange={(e) => setEdit({ ...edit, tags: e.target.checked ? [...edit.tags, t] : edit.tags.filter((x: string) => x !== t) })} />{t}</label>))}</div>
            <label className="field wide"><span>Remarks</span><textarea value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} /></label>
          </div>}
          <ErrorNotice error={error} />
          <div className="row">
            <span className="grow" />
            <button onClick={() => setMode(null)}>Back</button>
            {mode === "move" && <button className="btn-primary" disabled={busy} onClick={() => void run("/move", { date: moveDate, slotTime: moveSlot, reason: text || null },
              `${a.status === "cancelled" ? "Restored" : "Moved"} to ${dayLabel(moveDate)} ${moveSlot ?? "waitlist"}`)}>Save new time</button>}
            {mode === "cancel" && <button className="btn-danger" disabled={busy || text.trim().length < 2} onClick={() => void run("/cancel", { reason: text }, "Appointment cancelled")}>Cancel appointment</button>}
            {mode === "remark" && <button className="btn-primary" disabled={busy || !text.trim()} onClick={() => void run("/remarks", { note: text }, "Remark added")}>Add remark</button>}
            {mode === "edit" && <button className="btn-primary" disabled={busy} onClick={() => void run("", {
              planOfAction: edit.planOfAction, remarks: edit.remarks, appointmentType: edit.appointmentType, urgency: edit.urgency,
              familyGroup: edit.familyGroup, phone: edit.phone, doctorId: edit.doctorId, tags: edit.tags }, "Changes saved", "PATCH")}>Save changes</button>}
          </div>
        </section>
      )}

      <section>
        <h3 style={{ marginBottom: "0.6rem" }}>What happened</h3>
        <ol className="story">
          {(q.data?.events ?? []).map((e) => (
            <li key={e.id} className={e.type === "cancelled" || e.type === "no_show" ? "bad" : e.type.startsWith("confirmed") || e.type === "completed" ? "good" : ""}>
              <div><b>{EVENT_WORDS[e.type] ?? e.type}</b> {eventText(e)}</div>
              {e.note && <div style={{ whiteSpace: "pre-wrap" }}>{e.note}</div>}
              {e.type === "imported" && e.to && ["RescheduleHistory", "AppointmentJourney"].filter((k) => e.to[k]).map((k) => (
                <div key={k} className="small muted" style={{ whiteSpace: "pre-wrap" }}>{k === "RescheduleHistory" ? "Reschedules: " : "Journey: "}{String(e.to[k])}</div>))}
              <time>{stamp(e.at)}{e.by && `, ${e.by}`}</time>
            </li>
          ))}
        </ol>
      </section>
    </Drawer>
  );
}
