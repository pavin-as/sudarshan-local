import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type Appointment } from "../api";
import { useAuth } from "../auth";
import { dayLabel, niceDate, todayIST, weekdayName } from "../format";
import { ErrorNotice, Loading, StageTrack, StatusPill, Tags } from "../components/ui";
import { DateStrip, useDay } from "../components/SlotPicker";
import { BookDialog, type BookPreset } from "../components/BookDialog";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { LEVEL_WORDS, RuleNotes, useDayRules } from "../components/RuleNotes";
import type { RuleLevel } from "../api";

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const nowMin = () => toMin(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()));

interface CardRules { level: RuleLevel; n: number; special: string[] }

function ApptCard({ a, onOpen, rules }: { a: Appointment; onOpen: () => void; rules?: CardRules }) {
  const extra = (rules?.special ?? []).filter((t) => !a.tags.some((x) => x.toLowerCase().includes(t.toLowerCase())));
  return (
    <button className={`appt ${a.status}`} onClick={onOpen}>
      <div style={{ minWidth: 0 }}>
        <div className="appt-name">{a.patientName} <span className="muted small" style={{ fontWeight: 400 }}>{a.mrd ?? "new"}</span></div>
        <div className="appt-sub">{[a.planOfAction, a.doctorName, a.ageYears != null ? `${a.ageYears} y` : null].filter(Boolean).join(", ") || " "}
          {(a.tags.length > 0 || extra.length > 0) && <> <Tags tags={[...a.tags, ...extra]} /></>}</div>
      </div>
      <div className="appt-side">
        {a.liveStage ? <StageTrack stage={a.liveStage} /> : <StatusPill status={a.status} />}
        {rules && rules.n > 0 && <span className={`rule-flag ${rules.level}`}>{LEVEL_WORDS[rules.level]}{rules.n > 1 ? ` +${rules.n - 1}` : ""}</span>}
        {a.remarks && <span className="small muted" title={a.remarks}>has remarks</span>}
      </div>
    </button>
  );
}

export function BoardPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? todayIST();
  const setDate = (d: string) => setParams(d === todayIST() ? {} : { date: d });
  const [view, setView] = useState<"slots" | "list">("slots");
  const [showFree, setShowFree] = useState(true);
  const [showCancelled, setShowCancelled] = useState(false);
  const [booking, setBooking] = useState<BookPreset | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const isToday = date === todayIST();

  const day = useDay(date);
  const rules = useDayRules(date);
  const [showNotes, setShowNotes] = useState(false);
  const cardRules = useMemo(() => {
    const m = new Map<number, CardRules>(), rank: Record<RuleLevel, number> = { error: 0, warning: 1, info: 2 };
    const get = (id: number) => m.get(id) ?? (m.set(id, { level: "info", n: 0, special: [] }), m.get(id)!);
    for (const f of rules.data?.findings ?? []) {
      if (f.id == null) continue;
      const c = get(f.id);
      if (c.n === 0 || rank[f.level] < rank[c.level]) c.level = f.level;
      c.n++;
    }
    for (const sc of rules.data?.specialCases ?? []) get(sc.id).special = sc.types;
    return m;
  }, [rules.data]);
  const findings = rules.data?.findings ?? [];
  const serious = findings.filter((f) => f.level !== "info"), notes = findings.filter((f) => f.level === "info");
  const appts = useQuery({
    queryKey: ["appointments", date],
    refetchInterval: isToday ? 60_000 : false,      // live stages from Yarago refresh every minute today
    queryFn: () => api<{ appointments: Appointment[] }>(`/appointments?date=${date}`).then((r) => r.appointments),
  });

  const { bySlot, waitlist, cancelled, offGrid } = useMemo(() => {
    const list = appts.data ?? [];
    const bySlot = new Map<string, Appointment[]>();
    const grid = new Set((day.data?.slots ?? []).map((s) => s.time));
    const offGrid: Appointment[] = [];
    for (const a of list) {
      if (a.status === "cancelled" || !a.slotTime) continue;
      if (!grid.has(a.slotTime)) offGrid.push(a);
      bySlot.set(a.slotTime, [...(bySlot.get(a.slotTime) ?? []), a]);
    }
    return { bySlot, offGrid, waitlist: list.filter((a) => a.status === "waitlist"), cancelled: list.filter((a) => a.status === "cancelled") };
  }, [appts.data, day.data]);

  const info = day.data?.day;
  const doctors = day.data?.doctors ?? [];
  const sessionsCover = (t: string) => doctors.some((d) => d.sessions.some((s) => toMin(t) >= toMin(s.start) && toMin(t) < toMin(s.end)));
  const live = (appts.data ?? []).filter((a) => a.status !== "cancelled");
  const counts = {
    arrived: live.filter((a) => a.liveStage && !["registered_not_arrived", "cancelled_in_yarago"].includes(a.liveStage)).length,
    withDoctor: live.filter((a) => a.liveStage === "with_doctor").length,
    waiting: live.filter((a) => a.liveStage && ["arrived", "optometry", "waiting_for_doctor"].includes(a.liveStage)).length,
    done: live.filter((a) => a.liveStage === "done").length,
  };
  const now = isToday ? nowMin() : -1;
  const slotTimes = [...new Set([...(day.data?.slots ?? []).map((s) => s.time), ...offGrid.map((a) => a.slotTime!)])].sort();
  const canBook = can("appointments.write") && !!info?.open;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{dayLabel(date)}</h1>
          <div className="muted">{weekdayName(date, true)}, {niceDate(date, true)}{info?.holiday && `, holiday: ${info.holiday}`}</div>
        </div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === "slots"} onClick={() => setView("slots")}>Time slots</button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
        </div>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Go to date" />
        {can("appointments.write") && <button className="btn-primary" onClick={() => setBooking({ date })}>Book patient</button>}
      </div>
      <div style={{ marginBottom: "1rem" }}><DateStrip value={date} onChange={setDate} from={todayIST()} count={28} /></div>

      {appts.error && <ErrorNotice error={appts.error} />}
      <div className="board">
        <div className="stack">
          {view === "slots" ? (
            <div className="rail">
              {day.isLoading || appts.isLoading ? <Loading /> : slotTimes.map((t) => {
                const here = bySlot.get(t) ?? [];
                if (!here.length && !showFree) return null;
                const isNow = isToday && toMin(t) <= now && now < toMin(t) + (day.data?.settings.slotMinutes ?? 10);
                return (
                  <div key={t} className={`slot ${t.endsWith(":00") ? "hour" : ""} ${isNow ? "now" : ""} ${doctors.length && !sessionsCover(t) ? "outside" : ""}`}>
                    <div className="slot-time">{t}</div>
                    <div className="slot-body">
                      {here.map((a) => <ApptCard key={a.id} a={a} rules={cardRules.get(a.id)} onOpen={() => setOpenId(a.id)} />)}
                      {!here.length && canBook && toMin(t) > now && (
                        <button className="slot-free" onClick={() => setBooking({ date, slotTime: t })}>Book {t}</button>)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="panel">
              {live.filter((a) => a.slotTime).length === 0 ? <div className="empty">No bookings on this day yet.</div> : (
                <table className="list">
                  <thead><tr><th>Time</th><th>Patient</th><th>Plan</th><th>Doctor</th><th>Now</th></tr></thead>
                  <tbody>{live.filter((a) => a.slotTime && a.status !== "waitlist").map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => setOpenId(a.id)}>
                      <td className="nowrap"><b>{a.slotTime}</b></td>
                      <td><b>{a.patientName}</b> <span className="muted small">{a.mrd}</span><div><Tags tags={a.tags} /></div></td>
                      <td>{a.planOfAction}</td><td>{a.doctorName}</td>
                      <td>{a.liveStage ? <StageTrack stage={a.liveStage} /> : <StatusPill status={a.status} />}</td>
                    </tr>))}</tbody>
                </table>)}
            </div>
          )}

          <div className="panel">
            <div className="panel-head"><h3 className="grow">Waitlist</h3><span className="muted small">{waitlist.length} without a time</span></div>
            <div className="panel-pad stack">
              {waitlist.length === 0 ? <span className="muted small">Nobody waiting for a slot on this day.</span>
                : waitlist.map((a) => <ApptCard key={a.id} a={a} rules={cardRules.get(a.id)} onOpen={() => setOpenId(a.id)} />)}
            </div>
          </div>

          {cancelled.length > 0 && (
            <div className="panel">
              <div className="panel-head"><h3 className="grow">Cancelled</h3>
                <button className="btn-quiet btn-small" onClick={() => setShowCancelled(!showCancelled)}>{showCancelled ? "Hide" : `Show ${cancelled.length}`}</button></div>
              {showCancelled && <div className="panel-pad stack">{cancelled.map((a) => <ApptCard key={a.id} a={a} rules={cardRules.get(a.id)} onOpen={() => setOpenId(a.id)} />)}</div>}
            </div>
          )}
        </div>

        <aside className="side">
          <div className="panel">
            {info && (info.open ? <>
              <div className="daystat">
                <div><b>{info.booked}</b><span>booked</span></div>
                <div><b>{info.remaining}</b><span>slots left</span></div>
                <div><b>{info.waitlist}</b><span>waitlist</span></div>
              </div>
              <div className={`meter ${info.remaining === 0 ? "full" : ""}`}><i style={{ width: `${Math.min(100, (info.booked / Math.max(1, info.maxSlots)) * 100)}%` }} /></div>
            </> : <div className="panel-pad"><b>Closed for booking</b><div className="muted small">{info.closedReason}</div></div>)}
            {isToday && live.length > 0 && (
              <div className="panel-pad small stack" style={{ gap: "0.25rem", borderTop: "1px solid var(--line-soft)" }}>
                <div className="row"><span className="grow">Arrived (from Yarago)</span><b>{counts.arrived}</b></div>
                <div className="row"><span className="grow">Waiting or in optometry</span><b>{counts.waiting}</b></div>
                <div className="row"><span className="grow">With doctor</span><b>{counts.withDoctor}</b></div>
                <div className="row"><span className="grow">Done</span><b>{counts.done}</b></div>
              </div>
            )}
          </div>

          {findings.length > 0 && (
            <div className="panel">
              <div className="panel-head"><h3 className="grow">Scheduling rules</h3>
                <span className="muted small">{serious.length} to check, {notes.length} notes</span></div>
              <div className="panel-pad stack">
                <span className="muted small">Warnings only; nothing is blocked.</span>
                <RuleNotes findings={showNotes ? findings : serious} onOpen={setOpenId} />
                {notes.length > 0 && <button className="btn-quiet btn-small" onClick={() => setShowNotes(!showNotes)}>{showNotes ? "Hide notes" : `Show ${notes.length} notes`}</button>}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-head"><h3>Doctors</h3></div>
            <div className="panel-pad stack small">
              {doctors.length === 0 && <span className="muted">No doctors set up.</span>}
              {doctors.map((d) => (
                <div key={d.doctorId}>
                  <b>{d.name}</b>
                  <div className={d.onLeave ? "overdue" : "muted"}>
                    {d.onLeave ? "On leave" : d.sessions.length ? d.sessions.map((s) => `${s.start}–${s.end}`).join(", ") : "No session"}{d.note && ` (${d.note})`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {view === "slots" && <label className="check small"><input type="checkbox" checked={showFree} onChange={(e) => setShowFree(e.target.checked)} />Show free slots</label>}
        </aside>
      </div>

      {booking && <BookDialog preset={booking} onClose={() => setBooking(null)} />}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
