// Today: the front desk's dashboard. What is happening in the clinic now (live from Yarago's station timer),
// the next 7 days against capacity, and the work waiting to be done. Every figure opens the screen where it is acted on.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Appointment, type DayInfo, type LiveStage } from "../api";
import { useAuth } from "../auth";
import { addDays, dayLabel, niceDate, todayIST, weekdayName } from "../format";
import { ErrorNotice, Loading, StageTrack } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { useConfirmationList } from "./Confirmations";

interface InClinic {
  visitId: number; patientId: number; patientName: string | null; mrd: string | null; checkIn: string; stage: LiveStage;
  minutesIn: number; minutesAtStage: number; appointmentId: number | null;
}
interface TodayData {
  date: string; nextWorkDay: string; inClinic: InClinic[]; inClinicCount: number; checkedOut: number; walkIns: number;
  waits: { optometry: number | null; doctor: number | null; total: number | null; totalCount: number };
  rules: { date: string; toCheck: number; notes: number }[];
}

const mins = (m: number | null | undefined) => (m == null ? "-" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function Stat({ value, label, to, tone }: { value: number | string; label: string; to?: string; tone?: "warn" | "bad" }) {
  const body = <><b>{value}</b><span>{label}</span></>;
  return to ? <Link to={to} className={`stat ${tone ?? ""}`}>{body}</Link> : <div className={`stat ${tone ?? ""}`}>{body}</div>;
}

export function TodayPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [openId, setOpenId] = useState<number | null>(null);
  const today = todayIST();

  const live = useQuery({ queryKey: ["today"], refetchInterval: 60_000, queryFn: () => api<TodayData>("/today") });
  const appts = useQuery({ queryKey: ["appointments", today], refetchInterval: 60_000,
    queryFn: () => api<{ appointments: Appointment[] }>(`/appointments?date=${today}`).then((r) => r.appointments) });
  const week = useQuery({ queryKey: ["days", today, 7], queryFn: () => api<{ days: DayInfo[] }>(`/days?from=${today}&to=${addDays(today, 6)}`).then((r) => r.days) });
  const conf = useConfirmationList();
  const fu = useQuery({ queryKey: ["followups", "to_call", "count"], enabled: can("patients.read"), staleTime: 5 * 60_000,
    queryFn: () => api<{ followups: unknown[] }>("/followups?view=to_call&limit=500").then((r) => r.followups.length) });

  const list = (appts.data ?? []).filter((a) => a.status !== "cancelled");
  const timed = list.filter((a) => a.slotTime && a.status !== "waitlist");
  const arrived = timed.filter((a) => a.liveStage && !["registered_not_arrived", "cancelled_in_yarago"].includes(a.liveStage) || ["checked_in", "completed"].includes(a.status));
  const confirmDue = conf.data ? new Set([...conf.data.oneDay, ...conf.data.fourDay].map((a) => a.id)).size : null;
  const waitDays = (week.data ?? []).filter((d) => d.waitlist > 0);
  const d = live.data;

  return (
    <>
      <div className="page-head">
        <div><h1>Today</h1><div className="muted">{weekdayName(today, true)}, {niceDate(today, true)}</div></div>
        <span className="grow" />
        <Link className="btn" to="/">Day board</Link>
        {d && <Link className="btn" to={`/huddle?date=${d.nextWorkDay}`}>Huddle sheet for {dayLabel(d.nextWorkDay).toLowerCase()}</Link>}
      </div>

      {(live.error || appts.error) && <ErrorNotice error={live.error ?? appts.error} />}

      <section className="stat-strip" aria-label="Today in numbers">
        <Stat value={timed.length} label="booked today" to="/" />
        <Stat value={arrived.length} label="arrived" />
        <Stat value={d?.inClinicCount ?? "-"} label="in the clinic now" />
        <Stat value={d?.checkedOut ?? "-"} label="checked out" />
        <Stat value={Math.max(0, timed.length - arrived.length)} label="not arrived yet" />
        <Stat value={d?.walkIns ?? "-"} label="came without a Sudarshan booking" />
      </section>

      <div className="today-grid">
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3 className="grow">In the clinic now</h3>
              <span className="muted small">longest first, from Yarago's station timer</span></div>
            {live.isLoading ? <Loading /> : !d?.inClinic.length ? <div className="empty">Nobody is checked in at the moment.</div> : (
              <table className="list">
                <thead><tr><th>Patient</th><th>Checked in</th><th>Now</th><th>In clinic</th><th>At this step</th></tr></thead>
                <tbody>{d.inClinic.map((v) => (
                  <tr key={v.visitId} className="clickable"
                      onClick={() => (v.appointmentId ? setOpenId(v.appointmentId) : nav(`/patients/${v.patientId}`))}>
                    <td><b>{v.patientName ?? "Patient"}</b> <span className="muted small">{v.mrd}</span></td>
                    <td className="nowrap">{v.checkIn}</td>
                    <td><StageTrack stage={v.stage} /></td>
                    <td className={`nowrap ${v.minutesIn >= 180 ? "overdue" : ""}`}>{mins(v.minutesIn)}</td>
                    <td className={`nowrap ${v.minutesAtStage >= 60 ? "overdue" : ""}`}>{mins(v.minutesAtStage)}</td>
                  </tr>))}</tbody>
              </table>)}
            {d && d.inClinicCount > d.inClinic.length && <div className="panel-pad muted small">and {d.inClinicCount - d.inClinic.length} more</div>}
          </div>

          <div className="panel">
            <div className="panel-head"><h3 className="grow">Next 7 days</h3><span className="muted small">booked of maximum slots</span></div>
            <div className="panel-pad stack" style={{ gap: "0.45rem" }}>
              {week.isLoading ? <Loading /> : (week.data ?? []).map((day) => (
                <Link key={day.date} to={day.date === today ? "/" : `/?date=${day.date}`} className="day-row">
                  <span className="day-name">{dayLabel(day.date)}</span>
                  {day.open ? <>
                    <span className={`meter ${day.booked >= day.maxSlots ? "full" : ""}`}><i style={{ width: `${Math.min(100, (day.booked / Math.max(1, day.maxSlots)) * 100)}%` }} /></span>
                    <span className="nowrap small">{day.booked} of {day.maxSlots}{day.booked > day.maxSlots ? " (over)" : ""}{day.waitlist > 0 && `, ${day.waitlist} waiting`}</span>
                  </> : <span className="muted small">{day.closedReason}</span>}
                </Link>))}
            </div>
          </div>
        </div>

        <aside className="stack">
          <div className="panel">
            <div className="panel-head"><h3>To do</h3></div>
            <div className="panel-pad stack todo">
              {can("appointments.write") && (
                <Link to="/confirm" className="todo-item"><b>{confirmDue ?? "-"}</b><span>confirmation calls due</span></Link>)}
              {can("patients.read") && (
                <Link to="/followups" className="todo-item"><b>{fu.data == null ? "-" : fu.data >= 500 ? "500+" : fu.data}</b><span>follow-up patients to call</span></Link>)}
              <Link to={waitDays.length ? `/?date=${waitDays[0].date}` : "/"} className="todo-item">
                <b>{waitDays.reduce((n, x) => n + x.waitlist, 0)}</b><span>on a waitlist in the next 7 days{waitDays.length ? ` (first: ${dayLabel(waitDays[0].date).toLowerCase()})` : ""}</span></Link>
              {d?.rules.map((r) => (
                <Link key={r.date} to={r.date === today ? "/" : `/?date=${r.date}`} className="todo-item">
                  <b className={r.toCheck ? "warn-text" : ""}>{r.toCheck}</b>
                  <span>scheduling rules to check {dayLabel(r.date).toLowerCase()}{r.notes ? `, ${r.notes} notes` : ""}</span></Link>))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h3 className="grow">Waiting times today</h3><span className="muted small">median</span></div>
            <div className="panel-pad stack small" style={{ gap: "0.3rem" }}>
              <div className="row"><span className="grow">Check-in to optometry</span><b>{mins(d?.waits.optometry)}</b></div>
              <div className="row"><span className="grow">Optometry to doctor</span><b>{mins(d?.waits.doctor)}</b></div>
              <div className="row"><span className="grow">Total in clinic{d?.waits.totalCount ? ` (${d.waits.totalCount} done)` : ""}</span><b>{mins(d?.waits.total)}</b></div>
              <span className="muted">Usual (last 90 days): 6 min, 40 min, 1 h 47 min. Trends: Metabase "Clinic week".</span>
            </div>
          </div>
        </aside>
      </div>

      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
