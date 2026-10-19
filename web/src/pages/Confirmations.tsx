// The two confirmation rounds of the Google app (Code.js getPendingConfirmationBreakdown):
//   4-day call: every booking in the next 4 working days (Sundays skipped) not yet 4-day confirmed
//   1-day call: bookings on the next working day not yet 1-day confirmed
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Appointment } from "../api";
import { addDays, dayLabel, stamp, todayIST, weekdayName, planText } from "../format";
import { ErrorNotice, Loading, Tags, useToast } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";

/** next n working days after today, Sundays skipped (as in the Google app) */
export function nextWorkDays(n: number): string[] {
  const out: string[] = [];
  let d = todayIST();
  while (out.length < n) { d = addDays(d, 1); if (weekdayName(d) !== "Sun") out.push(d); }
  return out;
}

export function useConfirmationList() {
  const days = nextWorkDays(4);
  return useQuery({
    queryKey: ["appointments", "confirm", days[0]],
    refetchInterval: 120_000,
    queryFn: () => api<{ appointments: Appointment[] }>(`/appointments?from=${days[0]}&to=${days[3]}&status=booked,confirmed&limit=500`)
      .then((r) => {
        const list = r.appointments.filter((a) => a.slotTime).sort((a, b) => (a.date + a.slotTime).localeCompare(b.date + b.slotTime));
        return {
          oneDay: list.filter((a) => a.date === days[0] && !a.confirmed1dayAt),
          fourDay: list.filter((a) => !a.confirmed4dayAt),
          days,
        };
      }),
  });
}

function CallTable({ list, stage, onOpen, showDate }: { list: Appointment[]; stage: "4day" | "1day"; onOpen: (id: number) => void; showDate?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<number | null>(null);
  const act = async (a: Appointment, what: "confirm" | "noanswer") => {
    setBusy(a.id);
    try {
      if (what === "confirm") { await api(`/appointments/${a.id}/confirm`, { body: { stage } }); toast(`${a.patientName} confirmed`); }
      else { await api(`/appointments/${a.id}/remarks`, { body: { note: `${stage === "4day" ? "4-day" : "1-day"} call: no answer` } }); toast(`Noted: ${a.patientName} did not answer`); }
      await qc.invalidateQueries();
    } catch (e: any) { toast(e.message, "err"); } finally { setBusy(null); }
  };
  if (!list.length) return <div className="empty">Everyone in this round is confirmed.</div>;
  return (
    <table className="list">
      <thead><tr>{showDate && <th>Day</th>}<th>Time</th><th>Patient</th><th>Phone</th><th>Plan</th><th /></tr></thead>
      <tbody>{list.map((a) => (
        <tr key={a.id}>
          {showDate && <td className="nowrap">{dayLabel(a.date)}</td>}
          <td className="nowrap"><b>{a.slotTime}</b></td>
          <td><button className="btn-quiet" style={{ padding: 0, fontWeight: 700 }} onClick={() => onOpen(a.id)}>{a.patientName}</button> <span className="muted small">{a.mrd}</span>
            <div><Tags tags={a.tags} />{stage === "1day" && a.confirmed4dayAt && <span className="small muted">4-day confirmed {stamp(a.confirmed4dayAt)}</span>}</div></td>
          <td className="nowrap">{a.phone ? <a href={`tel:${a.phone}`}>{a.phone}</a> : <span className="muted">none</span>}</td>
          <td>{planText(a.planOfAction)}</td>
          <td className="right nowrap">
            <button className="btn-small" disabled={busy === a.id} onClick={() => void act(a, "noanswer")}>No answer</button>{" "}
            <button className="btn-small" onClick={() => onOpen(a.id)}>Reschedule or cancel</button>{" "}
            <button className="btn-small btn-primary" disabled={busy === a.id} onClick={() => void act(a, "confirm")}>Confirmed</button>
          </td>
        </tr>))}</tbody>
    </table>
  );
}

export function ConfirmationsPage() {
  const q = useConfirmationList();
  const [openId, setOpenId] = useState<number | null>(null);
  const days = q.data?.days ?? nextWorkDays(4);
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head"><div><h1>Confirmation calls</h1>
        <div className="muted">Call each patient, then mark the result. Your name is recorded on every call.</div></div></div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading ? <Loading /> : <>
        <section className="panel">
          <div className="panel-head"><div className="grow"><h2>Day-before call</h2><div className="muted small">{weekdayName(days[0], true)}, {dayLabel(days[0])}</div></div>
            <span className="muted">{q.data!.oneDay.length} to call</span></div>
          <CallTable list={q.data!.oneDay} stage="1day" onOpen={setOpenId} />
        </section>
        <section className="panel">
          <div className="panel-head"><div className="grow"><h2>4-day call</h2><div className="muted small">Bookings in the next 4 working days: {days.map((d) => dayLabel(d)).join(", ")}</div></div>
            <span className="muted">{q.data!.fourDay.length} to call</span></div>
          <CallTable list={q.data!.fourDay} stage="4day" onOpen={setOpenId} showDate />
        </section>
      </>}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
