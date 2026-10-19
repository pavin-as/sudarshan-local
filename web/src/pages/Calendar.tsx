// Clinic calendar for managers: how many patients each day takes, holidays, doctors' hours and leave.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DayInfo } from "../api";
import { addDays, niceDate, todayIST, weekdayName } from "../format";
import { Dialog, ErrorNotice, Loading, useToast } from "../components/ui";
import { useMeta } from "../components/BookDialog";

const WD = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function DaysTable() {
  const toast = useToast();
  const qc = useQueryClient();
  const [start, setStart] = useState(todayIST());
  const q = useQuery({ queryKey: ["days", start, "cal"], queryFn: () => api<{ days: DayInfo[] }>(`/days?from=${start}&to=${addDays(start, 41)}`).then((r) => r.days) });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [holiday, setHoliday] = useState<DayInfo | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);

  const saveSlots = async (d: DayInfo) => {
    const v = Number(edits[d.date]);
    try {
      await api(`/days/${d.date}/capacity`, { method: "PUT", body: { maxSlots: v } });
      toast(`${weekdayName(d.date)} ${niceDate(d.date)}: ${v} slots`);
      setEdits((e) => { const n = { ...e }; delete n[d.date]; return n; });
      await qc.invalidateQueries({ queryKey: ["days"] });
    } catch (e: any) { toast(e.message, "err"); }
  };
  const saveHoliday = async () => {
    setError(null);
    try {
      const r = await api(`/holidays/${holiday!.date}`, { method: "PUT", body: { reason } });
      toast(`Holiday set for ${niceDate(holiday!.date)}`); if (r.warning) toast(r.warning, "warn");
      setHoliday(null); setReason(""); await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  const removeHoliday = async (d: DayInfo) => {
    try { await api(`/holidays/${d.date}`, { method: "DELETE" }); toast("Holiday removed"); await qc.invalidateQueries(); }
    catch (e: any) { toast(e.message, "err"); }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="grow">Daily slots</h2>
        <button className="btn-small" onClick={() => setStart(addDays(start, -42))} disabled={start <= todayIST()}>Earlier</button>
        <button className="btn-small" onClick={() => setStart(addDays(start, 42))}>Later</button>
      </div>
      <p className="panel-pad small muted" style={{ margin: 0, paddingBottom: 0 }}>A day takes bookings only when its maximum is above 0. It cannot go below what is already booked.</p>
      {q.isLoading ? <Loading /> : (
        <table className="list">
          <thead><tr><th>Day</th><th>Maximum slots</th><th>Booked</th><th>Waitlist</th><th /></tr></thead>
          <tbody>{(q.data ?? []).map((d) => {
            const editing = edits[d.date] !== undefined;
            return (
              <tr key={d.date} style={{ background: d.weekday === 7 ? "#fafbfb" : undefined }}>
                <td className="nowrap"><b>{weekdayName(d.date)}</b> {niceDate(d.date)}</td>
                <td>{d.holiday ? <span className="overdue">Holiday: {d.holiday}</span> : (
                  <span className="row" style={{ gap: "0.3rem" }}>
                    <input type="number" min={0} max={200} style={{ width: 80 }} value={editing ? edits[d.date] : d.maxSlots}
                      aria-label={`Maximum slots ${d.date}`} onChange={(e) => setEdits({ ...edits, [d.date]: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && editing && void saveSlots(d)} />
                    {editing && <button className="btn-small btn-primary" onClick={() => void saveSlots(d)}>Save</button>}
                  </span>)}</td>
                <td>{d.booked || ""}</td><td>{d.waitlist || ""}</td>
                <td className="right">{d.holiday ? <button className="btn-small" onClick={() => void removeHoliday(d)}>Remove holiday</button>
                  : <button className="btn-small btn-quiet" onClick={() => { setError(null); setHoliday(d); }}>Mark holiday</button>}</td>
              </tr>);
          })}</tbody>
        </table>)}
      {holiday && (
        <Dialog narrow title={`Holiday on ${weekdayName(holiday.date, true)} ${niceDate(holiday.date, true)}`} onClose={() => setHoliday(null)}
          foot={<button className="btn-primary" disabled={reason.trim().length < 2} onClick={() => void saveHoliday()}>Mark holiday</button>}>
          {holiday.booked + holiday.waitlist > 0 && <div className="notice">{holiday.booked + holiday.waitlist} patients are booked that day. They stay booked; move them from the day board.</div>}
          <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Onam, Vishu, clinic closed…" autoFocus /></label>
          <ErrorNotice error={error} />
        </Dialog>
      )}
    </section>
  );
}

function DoctorPanel({ doctor }: { doctor: { id: number; name: string } }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["schedule", doctor.id], queryFn: () => api(`/doctors/${doctor.id}/schedule`) });
  const [hours, setHours] = useState<{ weekday: number; start: string; end: string }[] | null>(null);
  const [leave, setLeave] = useState<{ date: string; kind: string; start: string; end: string; reason: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const saveHours = async () => {
    setError(null);
    try { await api(`/doctors/${doctor.id}/schedule`, { method: "PUT", body: { sessions: hours } }); toast(`${doctor.name}: weekly hours saved`); setHours(null); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  const saveLeave = async () => {
    setError(null);
    try {
      const body: any = { date: leave!.date, kind: leave!.kind, reason: leave!.reason || undefined };
      if (leave!.kind !== "leave") { body.start = leave!.start; body.end = leave!.end; }
      const r = await api(`/doctors/${doctor.id}/exceptions`, { body });
      toast("Saved"); if (r.warning) toast(r.warning, "warn"); setLeave(null); await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  const removeEx = async (id: number) => {
    try { await api(`/doctors/${doctor.id}/exceptions/${id}`, { method: "DELETE" }); toast("Removed"); await qc.invalidateQueries(); }
    catch (e: any) { toast(e.message, "err"); }
  };

  const weekly: any[] = q.data?.weekly ?? [];
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">{doctor.name}</h2>
        <button className="btn-small" onClick={() => setHours(weekly.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })))}>Change weekly hours</button>
        <button className="btn-small" onClick={() => setLeave({ date: addDays(todayIST(), 1), kind: "leave", start: "09:00", end: "13:00", reason: "" })}>Add leave or change a day</button>
      </div>
      <div className="panel-pad stack small">
        {q.isLoading ? <Loading /> : <>
          <div>{[1, 2, 3, 4, 5, 6, 7].map((wd) => {
            const s = weekly.filter((w) => w.weekday === wd);
            return <div key={wd} className="row" style={{ gap: "0.8rem" }}><span style={{ width: 36 }}>{WD[wd]}</span>
              <span className={s.length ? "" : "muted"}>{s.length ? s.map((x) => `${x.start}–${x.end}`).join(", ") : "off"}</span></div>;
          })}</div>
          {(q.data?.exceptions ?? []).length > 0 && <div className="stack" style={{ gap: "0.3rem" }}>
            <b>Leave and changed days</b>
            {q.data.exceptions.map((e: any) => (
              <div key={e.id} className="row">
                <span className="grow">{weekdayName(e.date)} {niceDate(e.date)}: {e.kind === "leave" ? "on leave" : e.kind === "partial" ? `only ${e.start}–${e.end}` : `extra ${e.start}–${e.end}`}{e.reason && ` (${e.reason})`}</span>
                {e.date >= todayIST() && <button className="btn-small btn-quiet" onClick={() => void removeEx(e.id)}>Remove</button>}
              </div>))}
          </div>}
        </>}
      </div>

      {hours && (
        <Dialog title={`${doctor.name}: weekly hours`} onClose={() => setHours(null)} foot={<button className="btn-primary" onClick={() => void saveHours()}>Save hours</button>}>
          <p className="muted small">From today. Past days keep the hours they had.</p>
          {hours.map((h, i) => (
            <div key={i} className="row">
              <select value={h.weekday} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, weekday: Number(e.target.value) } : x))}>
                {[1, 2, 3, 4, 5, 6, 7].map((w) => <option key={w} value={w}>{WD[w]}</option>)}</select>
              <input type="time" value={h.start} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, start: e.target.value } : x))} />
              <input type="time" value={h.end} onChange={(e) => setHours(hours.map((x, j) => j === i ? { ...x, end: e.target.value } : x))} />
              <button className="btn-small btn-quiet" onClick={() => setHours(hours.filter((_, j) => j !== i))}>Remove</button>
            </div>))}
          <div><button className="btn-small" onClick={() => setHours([...hours, { weekday: 1, start: "09:00", end: "13:00" }])}>Add a session</button></div>
          <ErrorNotice error={error} />
        </Dialog>
      )}
      {leave && (
        <Dialog narrow title={`${doctor.name}: one day`} onClose={() => setLeave(null)} foot={<button className="btn-primary" onClick={() => void saveLeave()}>Save</button>}>
          <label className="field"><span>Date</span><input type="date" value={leave.date} min={todayIST()} onChange={(e) => setLeave({ ...leave, date: e.target.value })} /></label>
          <label className="field"><span>What</span>
            <select value={leave.kind} onChange={(e) => setLeave({ ...leave, kind: e.target.value })}>
              <option value="leave">On leave all day</option><option value="partial">Available only part of the day</option><option value="extra">Extra session</option></select></label>
          {leave.kind !== "leave" && <div className="row">
            <label className="field"><span>From</span><input type="time" value={leave.start} onChange={(e) => setLeave({ ...leave, start: e.target.value })} /></label>
            <label className="field"><span>To</span><input type="time" value={leave.end} onChange={(e) => setLeave({ ...leave, end: e.target.value })} /></label></div>}
          <label className="field"><span>Reason</span><input value={leave.reason} onChange={(e) => setLeave({ ...leave, reason: e.target.value })} placeholder="Optional" /></label>
          <ErrorNotice error={error} />
        </Dialog>
      )}
    </section>
  );
}

export function CalendarPage() {
  const meta = useMeta();
  return (
    <>
      <div className="page-head"><div><h1>Clinic calendar</h1><div className="muted">Slots per day, holidays, and when each doctor sees patients.</div></div></div>
      <div className="pgrid">
        <DaysTable />
        <div className="stack" style={{ gap: "1rem" }}>
          {(meta.data?.doctors ?? []).filter((d) => d.isActive).map((d) => <DoctorPanel key={d.id} doctor={d} />)}
        </div>
      </div>
    </>
  );
}
