import { useQuery } from "@tanstack/react-query";
import { api, type DayInfo, type DoctorDay } from "../api";
import { addDays, dayLabel, niceDate, todayIST, weekdayName } from "../format";

interface DayDetail { day: DayInfo; settings: { slotMinutes: number; dayStart: string; dayEnd: string }; slots: { time: string; appointments: { id: number; patientName: string }[] }[]; doctors: DoctorDay[] }

export function useDays(from: string, to: string) {
  return useQuery({ queryKey: ["days", from, to], queryFn: () => api<{ days: DayInfo[] }>(`/days?from=${from}&to=${to}`).then((r) => r.days) });
}

export function useDay(date: string | null) {
  return useQuery({ queryKey: ["day", date], enabled: !!date, queryFn: () => api<DayDetail>(`/days/${date}`) });
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Strip of upcoming days showing how full each is. */
export function DateStrip({ value, onChange, from, count = 21 }: { value: string; onChange: (d: string) => void; from?: string; count?: number }) {
  const start = from ?? todayIST();
  const days = useDays(start, addDays(start, count - 1));
  return (
    <div className="dates" role="group" aria-label="Choose a day">
      {(days.data ?? []).map((d) => (
        <button key={d.date} type="button" className={`date-chip ${d.open ? "" : "closed"}`} aria-pressed={d.date === value}
          title={d.closedReason ?? `${d.booked} of ${d.maxSlots} booked${d.waitlist ? `, ${d.waitlist} waiting` : ""}`}
          onClick={() => onChange(d.date)}>
          <small>{d.date === todayIST() ? "Today" : weekdayName(d.date)}</small>
          <b>{Number(d.date.slice(8, 10))}</b>
          {d.open ? <span className="fill"><i style={{ width: `${Math.min(100, (d.booked / Math.max(1, d.maxSlots)) * 100)}%` }} /></span>
                  : <small>{d.holiday ? "holiday" : "closed"}</small>}
        </button>
      ))}
    </div>
  );
}

/** Pick a slot on a day: taken slots crossed out, times outside the chosen doctor's hours dimmed. */
export function SlotPicker({ date, value, onChange, doctorId, ignoreAppointmentId }: {
  date: string; value: string | null; onChange: (t: string | null) => void; doctorId?: number | null; ignoreAppointmentId?: number;
}) {
  const day = useDay(date);
  if (day.isLoading) return <div className="muted small">Loading slots…</div>;
  if (!day.data) return null;
  const { day: info, slots, doctors } = day.data;
  const doc = doctors.find((d) => d.doctorId === doctorId);
  const inHours = (t: string) => !doc || !doc.sessions.length || doc.sessions.some((s) => toMin(t) >= toMin(s.start) && toMin(t) < toMin(s.end));
  const now = date === todayIST() ? toMin(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())) : -1;
  return (
    <div className="stack">
      <div className="row small">
        <b>{dayLabel(date)}{date !== todayIST() && ` (${weekdayName(date, true)} ${niceDate(date)})`}</b>
        {info.open ? <span className="muted">{info.booked} of {info.maxSlots} booked, {info.remaining} left{info.waitlist ? `, ${info.waitlist} on waitlist` : ""}</span>
                   : <span className="overdue">{info.closedReason}</span>}
        {doc && <span className="muted">· {doc.name}: {doc.onLeave ? "on leave" : doc.sessions.length ? doc.sessions.map((s) => `${s.start}-${s.end}`).join(", ") : "no session this weekday"}</span>}
      </div>
      <div className="slots-pick" role="group" aria-label="Time slot">
        <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} title="Book without a time">Waitlist</button>
        {slots.map((s) => {
          const taken = s.appointments.some((a) => a.id !== ignoreAppointmentId);
          const past = toMin(s.time) <= now;
          return (
            <button key={s.time} type="button" aria-pressed={value === s.time}
              className={`${taken ? "taken" : ""} ${!inHours(s.time) || past ? "off" : ""}`}
              title={taken ? s.appointments.map((a) => a.patientName).join(", ") : past ? "Already passed" : !inHours(s.time) ? "Outside the doctor's hours" : "Free"}
              onClick={() => onChange(s.time)}>{s.time}</button>
          );
        })}
      </div>
    </div>
  );
}
