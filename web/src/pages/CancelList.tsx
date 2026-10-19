// Cancel list: cancelled bookings to call back and rebook. A booking leaves the list when the patient is rebooked
// (Restore in the appointment panel) or when staff record that no rebooking is needed.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { addDays, dayLabel, niceDate, stamp, todayIST, planText } from "../format";
import { Dialog, ErrorNotice, Loading, Tags, useToast } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";

interface Cancelled {
  id: number; date: string; slotTime: string | null; patientId: number | null; mrd: string | null; patientName: string; phone: string | null;
  ageYears: number | null; planOfAction: string | null; urgency: string | null; tags: string[]; doctorName: string | null;
  cancelledAt: string | null; cancelledBy: string; cancelReason: string | null; callbackOn: string | null;
  doneAt: string | null; doneBy: string | null; doneNote: string | null; lastCallNote: string | null; lastCallAt: string | null; lastCallBy: string;
  newBookingId: number | null; newBookingDate: string | null;
}
type View = "to_call" | "all" | "done";

export function useCancelList(view: View, search = "") {
  return useQuery({
    queryKey: ["cancel-list", view, search],
    queryFn: () => api<{ appointments: Cancelled[]; counts: { toCall: number; all: number } }>(`/cancel-list?view=${view}${search ? `&q=${encodeURIComponent(search)}` : ""}`),
  });
}

const OUTCOMES = ["No answer", "Will decide and call back", "Asked to call later", "Wants to come, date to be fixed", "Number not reachable"];

function CallDialog({ a, onClose, onRebook }: { a: Cancelled; onClose: () => void; onRebook: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [again, setAgain] = useState(addDays(todayIST(), 2));
  const [noAgain, setNoAgain] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/appointments/${a.id}/callback`, { body: { note, callbackOn: noAgain ? null : again } });
      toast(`Saved the call to ${a.patientName}`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Dialog narrow title={`Call ${a.patientName}`} onClose={onClose}
      foot={<><button onClick={onRebook}>Rebook now</button><span className="grow" />
        <button className="btn-primary" disabled={note.trim().length < 2} onClick={() => void save()}>Save call</button></>}>
      <div className="muted">{a.mrd ?? "new patient"}{a.phone && <>, <a href={`tel:${a.phone}`}>{a.phone}</a></>}</div>
      <div className="row">{OUTCOMES.map((o) => <button key={o} className="btn-small" aria-pressed={note === o} onClick={() => setNote(o)}>{o}</button>)}</div>
      <label className="field"><span>What happened</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <label className="field"><span>Call again on</span>
        <input type="date" value={again} min={todayIST()} disabled={noAgain} onChange={(e) => setAgain(e.target.value)} /></label>
      <label className="check small"><input type="checkbox" checked={noAgain} onChange={(e) => setNoAgain(e.target.checked)} />No date: keep it on the list to call any time</label>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

function OffListDialog({ a, onClose }: { a: Cancelled; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [note, setNote] = useState(a.newBookingDate ? `Already rebooked for ${niceDate(a.newBookingDate)}` : "");
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      await api(`/appointments/${a.id}/cancel-list`, { body: { onList: false, note } });
      toast(`${a.patientName} taken off the cancel list`);
      await qc.invalidateQueries();
      onClose();
    } catch (e) { setError(e); }
  };
  return (
    <Dialog narrow title={`No rebooking for ${a.patientName}?`} onClose={onClose}
      foot={<><button onClick={onClose}>Back</button><button className="btn-primary" disabled={note.trim().length < 2} onClick={() => void save()}>Take off the list</button></>}>
      <div className="row">{["Does not want to come", "Treated elsewhere", "Doctor says not needed", "Not reachable after several calls", "Moved away"].map((o) => (
        <button key={o} className="btn-small" aria-pressed={note === o} onClick={() => setNote(o)}>{o}</button>))}</div>
      <label className="field"><span>Why</span><input value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
      <ErrorNotice error={error} />
    </Dialog>
  );
}

export function CancelListPage() {
  const { can } = useAuth();
  const write = can("appointments.write");
  const [view, setView] = useState<View>("to_call");
  const [search, setSearch] = useState("");
  const [calling, setCalling] = useState<Cancelled | null>(null);
  const [offList, setOffList] = useState<Cancelled | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const list = useCancelList(view, search.trim());
  const counts = list.data?.counts;
  const backOn = async (a: Cancelled) => {
    await api(`/appointments/${a.id}/cancel-list`, { body: { onList: true } });
    toast(`${a.patientName} is back on the cancel list`);
    await qc.invalidateQueries();
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Cancel list</h1><div className="muted">Cancelled bookings to call back. Rebook the patient, or record why no rebooking is needed.</div></div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which bookings">
          <button aria-pressed={view === "to_call"} onClick={() => setView("to_call")}>To call{counts ? ` (${counts.toCall})` : ""}</button>
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>Everything on the list{counts ? ` (${counts.all})` : ""}</button>
          <button aria-pressed={view === "done"} onClick={() => setView("done")}>Taken off</button>
        </div>
        <input type="search" placeholder="Name, MRD or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cancel list" />
      </div>
      {list.error && <ErrorNotice error={list.error} />}
      <div className="panel">
        {list.isLoading ? <Loading /> : !list.data?.appointments.length ? <div className="empty">{view === "to_call" ? "Nobody to call back today." : "Nothing here."}</div> : (
          <table className="list">
            <thead><tr><th>Was booked for</th><th>Patient</th><th>Plan</th><th>Cancelled</th><th>{view === "done" ? "Taken off" : "Last call"}</th><th /></tr></thead>
            <tbody>{list.data.appointments.map((a) => (
              <tr key={a.id}>
                <td className="nowrap"><button className="btn-quiet btn-small" onClick={() => setOpenId(a.id)}>{niceDate(a.date, true)} {a.slotTime ?? ""}</button>
                  {a.doctorName && <div className="small muted">{a.doctorName}</div>}</td>
                <td>{a.patientId ? <Link to={`/patients/${a.patientId}`}><b>{a.patientName}</b></Link> : <b>{a.patientName}</b>}
                  {" "}<span className="muted small">{a.mrd ?? "new"}</span>
                  {a.phone && <div className="small"><a href={`tel:${a.phone}`}>{a.phone}</a></div>}
                  {a.newBookingId && <div className="small"><button className="btn-quiet btn-small" onClick={() => setOpenId(a.newBookingId!)}>Has a new booking: {dayLabel(a.newBookingDate!)}</button></div>}</td>
                <td className="small">{planText(a.planOfAction)}{a.tags.length > 0 && <div><Tags tags={a.tags.filter((t) => !/^call back|archived from/.test(t))} /></div>}</td>
                <td className="small">{a.cancelReason ?? <span className="muted">no reason recorded</span>}
                  <div className="muted">{[a.cancelledBy, a.cancelledAt && stamp(a.cancelledAt)].filter(Boolean).join(", ")}</div></td>
                <td className="small">{view === "done"
                  ? <>{a.doneNote}<div className="muted">{[a.doneBy, a.doneAt && stamp(a.doneAt)].filter(Boolean).join(", ")}</div></>
                  : <>{a.lastCallNote ? <>{a.lastCallNote.replace(/^Call-back call: /, "")}<div className="muted">{a.lastCallBy}, {stamp(a.lastCallAt)}</div></>
                       : <span className="muted">not called yet</span>}
                     {a.callbackOn && <div className={a.callbackOn <= todayIST() ? "overdue" : ""}>Call {a.callbackOn <= todayIST() ? "due" : "on"} {dayLabel(a.callbackOn)}</div>}</>}</td>
                <td className="right">{write && (view === "done"
                  ? <button className="btn-small" onClick={() => void backOn(a)}>Put back on the list</button>
                  : <div className="row actions">
                      <button className="btn-small" onClick={() => setOffList(a)}>No rebooking</button>
                      <button className="btn-small" onClick={() => setOpenId(a.id)}>Rebook</button>
                      <button className="btn-small btn-primary" onClick={() => setCalling(a)}>Log call</button></div>)}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      <p className="small muted" style={{ marginTop: "0.6rem" }}>Rebook opens the booking: press Restore and choose the new date. It then leaves this list.</p>

      {calling && <CallDialog a={calling} onClose={() => setCalling(null)} onRebook={() => { setOpenId(calling.id); setCalling(null); }} />}
      {offList && <OffListDialog a={offList} onClose={() => setOffList(null)} />}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
