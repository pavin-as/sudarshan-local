// Today: the front desk's dashboard. What is happening in the clinic now (live from Yarago's station timer),
// the next 7 days against capacity, and the work waiting to be done. Every figure opens the screen where it is acted on.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type DayInfo, type LiveStage } from "../api";
import { useAuth } from "../auth";
import { addDays, dayLabel, niceDate, planText, todayIST, weekdayName } from "../format";
import { Drawer, ErrorNotice, Loading, StageTrack } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { useConfirmationList } from "./Confirmations";
import { useDirectCalls } from "./DirectCalls";
import { useCancelList } from "./CancelList";

/** One patient who came today (per patient, from Yarago), with their Sudarshan booking if any. */
interface Came {
  patientId: number; patientName: string | null; mrd: string | null; ageYears: number | null; phone: string | null; doctor: string | null;
  checkIn: string | null; checkOut: string | null; stage: LiveStage; minutesIn: number; minutesAtStage: number;
  totalMin: number | null; appointmentId: number | null; slotTime: string | null; planOfAction: string | null; hasBooking: boolean;
  /** false = matched by MRD or mobile + name, the booking is not linked to this Yarago patient yet */
  bookingLinked: boolean | null;
}
/** One Sudarshan booking for today with a time. */
interface Booked {
  appointmentId: number; slotTime: string; patientId: number | null; patientName: string; mrd: string | null; ageYears: number | null;
  phone: string | null; planOfAction: string | null; doctor: string | null; status: string; confirmed: boolean;
  arrival: "arrived" | "not_arrived" | "unknown"; cameId: number | null;
}
interface TodayData {
  date: string; nextWorkDay: string; came: Came[]; booked: Booked[]; inClinic: Came[];
  waits: { optometry: number | null; doctor: number | null; total: number | null; totalCount: number };
  rules: { date: string; toCheck: number; notes: number }[];
}
type ListKey = "booked" | "booked_arrived" | "booked_not" | "booked_unknown" | "came" | "came_booked" | "came_walkin" | "came_done" | "came_in";
const LIST_TITLES: Record<ListKey, string> = {
  booked: "Booked for today", booked_arrived: "Booked and arrived", booked_not: "Booked, not arrived yet",
  booked_unknown: "Booked, arrival can't be seen (not linked to a Yarago patient)",
  came: "Came to the clinic today", came_booked: "Came with a booking", came_walkin: "Came without a booking (no appointment made before today)",
  came_done: "Seen and gone", came_in: "Still in the clinic",
};

const mins = (m: number | null | undefined) => (m == null ? "-" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

/** A number in the Today boxes; clicking it lists the patients behind it. */
function Num({ n, label, onOpen }: { n: number | undefined; label: string; onOpen: () => void }) {
  return <button type="button" className="tnum" onClick={onOpen} disabled={!n} aria-label={`${n ?? 0} ${label}: show the patients`}>
    <b>{n ?? "-"}</b><span>{label}</span></button>;
}

function TodayList({ data, which, onClose, onOpenAppt }: { data: TodayData; which: ListKey; onClose: () => void; onOpenAppt: (id: number) => void }) {
  const isBooking = which.startsWith("booked");
  const b = data.booked, c = data.came;
  const rowsB = which === "booked" ? b : b.filter((x) => x.arrival === ({ booked_arrived: "arrived", booked_not: "not_arrived", booked_unknown: "unknown" } as any)[which]);
  const rowsC = which === "came" ? c : which === "came_booked" ? c.filter((x) => x.hasBooking) : which === "came_walkin" ? c.filter((x) => !x.hasBooking)
    : which === "came_done" ? c.filter((x) => x.stage === "done") : c.filter((x) => x.stage !== "done");
  const came = new Map(c.map((x) => [x.patientId, x]));
  const who = (id: number | null, name: string | null, mrd: string | null) => (
    <>{id ? <Link to={`/patients/${id}`}><b>{name ?? "Patient"}</b></Link> : <b>{name ?? "Patient"}</b>}{mrd && <div className="small muted">{mrd}</div>}</>);
  const n = isBooking ? rowsB.length : rowsC.length;
  return (
    <Drawer wide title={`${LIST_TITLES[which]} (${n})`} sub={niceDate(data.date, true)} onClose={onClose}>
      {n === 0 ? <div className="empty">Nobody.</div> : isBooking ? (
        <table className="list">
          <thead><tr><th>Slot</th><th>Patient</th><th>Age</th><th>Phone</th><th>Plan</th><th>Doctor</th><th>Arrival</th></tr></thead>
          <tbody>{rowsB.map((x) => { const v = x.cameId != null ? came.get(x.cameId) : undefined; return (
            <tr key={x.appointmentId} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) onOpenAppt(x.appointmentId); }}>
              <td className="nowrap">{x.slotTime}</td><td>{who(x.patientId, x.patientName, x.mrd)}</td><td>{x.ageYears ?? "-"}</td>
              <td className="nowrap">{x.phone ? <a href={`tel:${x.phone}`}>{x.phone}</a> : "-"}</td>
              <td className="small">{planText(x.planOfAction) || "-"}</td><td className="small">{x.doctor ?? "-"}</td>
              <td className="small nowrap">{x.arrival === "unknown" ? <span className="muted">not linked to Yarago</span>
                : v ? <>in {v.checkIn}{v.stage === "done" ? `, out ${v.checkOut ?? "(completed)"}` : ""}</>
                : <span className="muted">not yet{x.confirmed ? ", confirmed" : ""}</span>}</td>
            </tr>); })}</tbody>
        </table>
      ) : (
        <table className="list">
          <thead><tr><th>Patient</th><th>Age</th><th>Booked</th><th>Checked in</th><th>{which === "came_in" ? "Now" : "Checked out / now"}</th><th>In clinic</th><th>Doctor</th><th>Plan</th></tr></thead>
          <tbody>{rowsC.map((v) => (
            <tr key={v.patientId} className="clickable" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) return; v.appointmentId ? onOpenAppt(v.appointmentId) : undefined; }}>
              <td>{who(v.patientId, v.patientName, v.mrd)}</td><td>{v.ageYears ?? "-"}</td>
              <td className="nowrap small">{v.hasBooking ? <>{v.slotTime ?? "waitlist"}{v.bookingLinked === false && <div className="muted" title="Booked earlier as a new patient; not linked to this Yarago record yet">not linked yet</div>}</> : <span className="muted">no booking</span>}</td>
              <td className="nowrap">{v.checkIn ?? "-"}</td>
              <td>{v.stage === "done" ? <span className="nowrap">{v.checkOut ?? "completed"}</span> : <StageTrack stage={v.stage} />}</td>
              <td className={`nowrap ${v.stage !== "done" && v.minutesIn >= 180 ? "overdue" : ""}`}>{mins(v.stage === "done" ? v.totalMin : v.minutesIn)}</td>
              <td className="small">{v.doctor ?? "-"}</td><td className="small">{planText(v.planOfAction) || "-"}</td>
            </tr>))}</tbody>
        </table>)}
      <p className="small muted">From Yarago, one row per patient. Click a row with a booking to open it; the name opens the patient.</p>
    </Drawer>
  );
}

export function TodayPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [openId, setOpenId] = useState<number | null>(null);
  const [listing, setListing] = useState<ListKey | null>(null);
  const today = todayIST();

  const live = useQuery({ queryKey: ["today"], refetchInterval: 60_000, queryFn: () => api<TodayData>("/today") });
  const week = useQuery({ queryKey: ["days", today, 7], queryFn: () => api<{ days: DayInfo[] }>(`/days?from=${today}&to=${addDays(today, 6)}`).then((r) => r.days) });
  const conf = useConfirmationList();
  const fu = useQuery({ queryKey: ["followups", "to_call", "count"], enabled: can("patients.read"), staleTime: 5 * 60_000,
    queryFn: () => api<{ followups: unknown[] }>("/followups?view=to_call&limit=500").then((r) => r.followups.length) });

  const calls = useDirectCalls("open").data?.counts.open;
  const callBacks = useCancelList("to_call").data?.counts.toCall;
  const confirmDue = conf.data ? new Set([...conf.data.oneDay, ...conf.data.fourDay].map((a) => a.id)).size : null;
  const waitDays = (week.data ?? []).filter((d) => d.waitlist > 0);
  const d = live.data;
  const cnt = d && {
    booked: d.booked.length, bArrived: d.booked.filter((b) => b.arrival === "arrived").length,
    bNot: d.booked.filter((b) => b.arrival === "not_arrived").length, bUnknown: d.booked.filter((b) => b.arrival === "unknown").length,
    came: d.came.length, cBooked: d.came.filter((v) => v.hasBooking).length, cWalkin: d.came.filter((v) => !v.hasBooking).length,
    cDone: d.came.filter((v) => v.stage === "done").length, cIn: d.came.filter((v) => v.stage !== "done").length,
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Today</h1><div className="muted">{weekdayName(today, true)}, {niceDate(today, true)}</div></div>
        <span className="grow" />
        <Link className="btn" to="/">Day board</Link>
        {d && <Link className="btn" to={`/huddle?date=${d.nextWorkDay}`}>Huddle sheet for {dayLabel(d.nextWorkDay).toLowerCase()}</Link>}
      </div>

      {live.error && <ErrorNotice error={live.error} />}

      <div className="today-boxes">
        <section className="tbox" aria-label="Booked for today">
          <h2>Booked for today</h2>
          <div className="tsum"><Num n={cnt?.booked} label="booked" onOpen={() => setListing("booked")} /><span className="op">=</span>
            <Num n={cnt?.bArrived} label="arrived" onOpen={() => setListing("booked_arrived")} /><span className="op">+</span>
            <Num n={cnt?.bNot} label="not arrived yet" onOpen={() => setListing("booked_not")} />
            {!!cnt?.bUnknown && <><span className="op">+</span>
              <span title="These bookings are not linked to a Yarago patient yet (usually a new patient without an MRD), so Sudarshan cannot see whether they came.">
                <Num n={cnt.bUnknown} label="can't tell ⓘ" onOpen={() => setListing("booked_unknown")} /></span></>}
          </div>
        </section>
        <section className="tbox" aria-label="Came to the clinic today">
          <h2>Came to the clinic today</h2>
          <div className="tsum"><Num n={cnt?.came} label="came" onOpen={() => setListing("came")} /><span className="op">=</span>
            <Num n={cnt?.cBooked} label="with a booking" onOpen={() => setListing("came_booked")} /><span className="op">+</span>
            <span title="Patients with no appointment made before today. A new patient who booked earlier counts as booked."><Num n={cnt?.cWalkin} label="without a booking ⓘ" onOpen={() => setListing("came_walkin")} /></span>
          </div>
          <div className="tsum"><span className="tnum ghost" aria-hidden="true"><b>{cnt?.came ?? "-"}</b><span>came</span></span><span className="op">=</span>
            <Num n={cnt?.cDone} label="seen and gone" onOpen={() => setListing("came_done")} /><span className="op">+</span>
            <Num n={cnt?.cIn} label="still in the clinic" onOpen={() => setListing("came_in")} />
          </div>
        </section>
      </div>

      <div className="today-grid">
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3 className="grow">In the clinic now</h3>
              <span className="muted small">longest first, from Yarago</span></div>
            {live.isLoading ? <Loading /> : !d?.inClinic.length ? <div className="empty">Nobody is checked in at the moment.</div> : (
              <table className="list">
                <thead><tr><th>Patient</th><th>Checked in</th><th>Now</th><th>In clinic</th><th>At this step</th></tr></thead>
                <tbody>{d.inClinic.slice(0, 12).map((v) => (
                  <tr key={v.patientId} className="clickable"
                      onClick={() => (v.appointmentId ? setOpenId(v.appointmentId) : nav(`/patients/${v.patientId}`))}>
                    <td><b>{v.patientName ?? "Patient"}</b> <span className="muted small">{v.mrd}</span></td>
                    <td className="nowrap">{v.checkIn ?? "-"}</td>
                    <td><StageTrack stage={v.stage} /></td>
                    <td className={`nowrap ${v.minutesIn >= 180 ? "overdue" : ""}`}>{mins(v.minutesIn)}</td>
                    <td className={`nowrap ${v.minutesAtStage >= 60 ? "overdue" : ""}`}>{mins(v.minutesAtStage)}</td>
                  </tr>))}</tbody>
              </table>)}
            {d && d.inClinic.length > 12 && <button className="link panel-pad small" onClick={() => setListing("came_in")}>and {d.inClinic.length - 12} more: show all</button>}
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
              <Link to="/calls" className="todo-item"><b>{calls ?? "-"}</b><span>direct calls waiting for a booking or an answer</span></Link>
              <Link to="/cancelled" className="todo-item"><b>{callBacks ?? "-"}</b><span>cancelled patients to call back</span></Link>
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

      {listing && d && <TodayList data={d} which={listing} onClose={() => setListing(null)} onOpenAppt={(id) => setOpenId(id)} />}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
