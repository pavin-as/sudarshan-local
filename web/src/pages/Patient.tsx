import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { niceDate, money, stamp, todayIST, planText } from "../format";
import { Drawer, ErrorNotice, Loading, StatusPill } from "../components/ui";
import { PatientPicker } from "../components/PatientPicker";
import { PatientGroups } from "../components/PatientGroups";
import { TrendChart } from "../components/TrendChart";
import { BookDialog } from "../components/BookDialog";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { FollowupLogForm } from "./Followups";
import { PatientFundus } from "./FundusReports";   // fundus photographs and the doctor's report (D-041, D-042)

export function PatientsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  return (
    <div className="stack">
      <div className="no-print" style={{ maxWidth: 760 }}>
        <div className="page-head"><div><h1>Patients</h1><div className="muted">Find a patient in Yarago by MRD, phone number or name{can("clinical.read") ? ", or open a group below" : ""}.</div></div></div>
        <PatientPicker onPick={(p) => nav(`/patients/${p.patientId}`)} autoFocus />
      </div>
      {can("clinical.read") && <PatientGroups />}
    </div>
  );
}

const FOLLOWUP_WORDS: Record<string, string> = {
  called: "Called", no_answer: "No answer", will_come: "Will come", booked: "Booked", declined: "Declined",
  wrong_number: "Wrong number", not_needed: "Not needed", moved_away: "Moved away", deceased: "Deceased", note: "Note",
};

export function VisitDrawer({ patientId, visitId, onClose }: { patientId: number; visitId: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ["visit", visitId], queryFn: () => api(`/patients/${patientId}/visits/${visitId}`) });
  const v = q.data?.visit;
  const row = (label: string, re: any, le: any) => (re || le) && <tr><th>{label}</th><td>{re ?? "—"}</td><td>{le ?? "—"}</td></tr>;
  const text = (label: string, t: any) => t && <><dt>{label}</dt><dd style={{ whiteSpace: "pre-wrap" }}>{String(t)}</dd></>;
  return (
    <Drawer title={v ? `Visit ${niceDate(v.visit_date, true)}` : "Visit"} sub={v && [v.visit_type, v.doctor, v.status].filter(Boolean).join(", ")} onClose={onClose}>
      {q.error && <ErrorNotice error={q.error} />}
      {!v ? <Loading /> : <>
        <table className="list panel">
          <thead><tr><th /><th>Right eye</th><th>Left eye</th></tr></thead>
          <tbody>
            {row("Unaided vision", v.va_unaided_re, v.va_unaided_le)}
            {row("Pinhole", v.va_pinhole_re, v.va_pinhole_le)}
            {row("Best corrected", v.bcva_re, v.bcva_le)}
            {row("Near", v.near_va_re, v.near_va_le)}
            {row("IOP (mmHg)", v.iop_re, v.iop_le)}
            {row("CCT", v.cct_re, v.cct_le)}
          </tbody>
        </table>
        <dl className="facts">
          {text("Diagnosis", v.diagnosis)}
          {text("Complaints", v.complaints)}
          {text("Complaint notes", v.complaint_notes)}
          {text("Findings", (q.data.findings ?? []).map((f: any) => `${f.eye ? f.eye + ": " : ""}${f.eyePart ? f.eyePart + " - " : ""}${f.finding}`).join("\n"))}
          {text("Medicines", v.medicines)}
          {text("Instructions", v.medicine_instructions)}
          {text("Advice", v.advice)}
          {text("Doctor's remarks", v.doctor_remarks)}
          {text("Systemic illness", v.systemic_illness)}
          {text("Drug allergies", v.drug_allergies)}
          {text("Follow-up", v.followup_date && niceDate(v.followup_date, true))}
          {text("Surgery advised", v.surgery_advised)}
        </dl>
      </>}
    </Drawer>
  );
}

export function PatientPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["patient", id], queryFn: () => api(`/patients/${id}`) });
  const [visitId, setVisitId] = useState<number | null>(null);
  const [apptId, setApptId] = useState<number | null>(null);
  const [booking, setBooking] = useState(false);
  const [logging, setLogging] = useState(false);
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data, p = d.patient;
  const upcoming = d.appointments.filter((a: any) => a.date >= todayIST() && ["booked", "confirmed", "waitlist"].includes(a.status));
  const trend = (d.trend ?? []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{p.name}</h1>
          <div className="muted">{p.mrd}, {[p.ageYears != null && (p.ageText ?? `${p.ageYears} years`), p.sex, p.language].filter(Boolean).join(", ")}
            {p.mobile && <>, <a href={`tel:${p.mobile}`}>{p.mobile}</a></>}{p.vipCategory && <span className="tag vip" style={{ marginLeft: 6 }}>{p.vipCategory}</span>}</div>
        </div>
        <span className="grow" />
        {can("clinical.read") && <Link className="btn" to={`/patients/${p.patientId}/summary`}>Doctor summary</Link>}
        {can("followups.write") && <button onClick={() => setLogging(true)}>Log a call</button>}
        {can("appointments.write") && <button className="btn-primary" onClick={() => setBooking(true)}>Book appointment</button>}
      </div>

      <div className="pgrid">
        <div className="stack" style={{ gap: "1rem" }}>
          {d.clinicalAccess && trend.length > 1 && (
            <section className="panel panel-pad stack">
              <TrendChart title="Best corrected vision (logMAR)" unit="logMAR" invert
                points={trend.map((t: any) => ({ date: t.date, re: t.logmarRe, le: t.logmarLe, reText: t.bcvaRe, leText: t.bcvaLe }))} />
              <TrendChart title="Eye pressure (IOP)" unit="mmHg"
                points={trend.map((t: any) => ({ date: t.date, re: t.iopRe != null ? Number(t.iopRe) : null, le: t.iopLe != null ? Number(t.iopLe) : null }))} />
            </section>
          )}

          {can("clinical.read") && <PatientFundus patientId={p.patientId} />}

          <section className="panel">
            <div className="panel-head"><h2 className="grow">Visits</h2><span className="muted small">{d.visits.length} shown, newest first</span></div>
            {d.visits.length === 0 ? <div className="empty">No visits in Yarago yet.</div> : (
              <table className="list">
                <thead><tr><th>Date</th><th>Visit</th>{d.clinicalAccess && <><th>BCVA R / L</th><th>IOP R / L</th><th>Diagnosis</th></>}<th>Follow-up</th></tr></thead>
                <tbody>{d.visits.map((v: any) => (
                  <tr key={v.visitId} className={d.clinicalAccess ? "clickable" : ""} onClick={() => d.clinicalAccess && setVisitId(v.visitId)}>
                    <td className="nowrap"><b>{niceDate(v.date, true)}</b></td>
                    <td>{v.visitType}<div className="muted small">{v.doctor}</div></td>
                    {d.clinicalAccess && <>
                      <td className="nowrap">{v.bcvaRe ?? "—"} / {v.bcvaLe ?? "—"}</td>
                      <td className="nowrap">{v.iopRe ?? "—"} / {v.iopLe ?? "—"}</td>
                      <td style={{ maxWidth: 260 }}>{v.diagnosis}</td></>}
                    <td className="nowrap">{v.followupDate ? niceDate(v.followupDate, true) : ""}</td>
                  </tr>))}</tbody>
              </table>)}
          </section>

          {d.clinicalAccess && (d.injections?.length > 0 || d.lasers?.length > 0) && (
            <section className="panel">
              <div className="panel-head"><h2>Injections and laser</h2></div>
              <table className="list">
                <thead><tr><th>Date</th><th>Treatment</th><th>Eye</th><th>Notes</th></tr></thead>
                <tbody>
                  {d.injections.map((i: any) => (
                    <tr key={"i" + i.injectionId}><td className="nowrap">{niceDate(i.date, true)}</td>
                      <td>{i.drug ?? i.procedure ?? "Injection"}{i.numberForEye && <span className="muted small"> (no. {i.numberForEye} in this eye)</span>}{!i.given && <span className="tag alert">advised, not given</span>}</td>
                      <td>{i.eye}</td><td className="small">{i.remarks}</td></tr>))}
                  {d.lasers.map((l: any) => (
                    <tr key={"l" + l.laserId}><td className="nowrap">{niceDate(l.date, true)}</td><td>Laser{!l.done && <span className="tag alert">advised</span>}</td><td>{l.eye}</td><td className="small">{l.remarks}</td></tr>))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        <div className="stack" style={{ gap: "1rem" }}>
          {d.due && (d.due.dueTotal > 0 || d.due.clinicOwesPatient > 0) && (
            <section className="panel panel-pad">
              {d.due.dueTotal > 0 && <><div className="muted small">Patient owes the clinic</div><div className="big-due">{money(d.due.dueTotal)}</div>
                <div className="small muted">{[["OPD", d.due.dueOpd], ["Pharmacy", d.due.duePharmacy], ["Optical", d.due.dueOptical], ["IPD", d.due.dueIpd]].filter(([, v]) => v > 0).map(([k, v]) => `${k} ${money(v as number)}`).join(", ")}</div></>}
              {d.due.clinicOwesPatient > 0 && <div className="small">Clinic holds {money(d.due.clinicOwesPatient)} for the patient</div>}
            </section>
          )}

          <section className="panel">
            <div className="panel-head"><h2>Appointments</h2></div>
            <div className="panel-pad stack small">
              {upcoming.length === 0 && <span className="muted">No upcoming appointment.</span>}
              {d.appointments.slice(0, 12).map((a: any) => (
                <button key={a.id} className="appt" onClick={() => setApptId(a.id)} style={{ opacity: a.date < todayIST() ? 0.75 : 1 }}>
                  <div><b>{niceDate(a.date, true)}</b> {a.slotTime ?? "waitlist"}<div className="appt-sub">{[planText(a.planOfAction), a.doctorName].filter(Boolean).join(", ")}</div></div>
                  <StatusPill status={a.status} />
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Follow-up</h2></div>
            <div className="panel-pad stack small">
              {d.followup ? <div>
                Due <b>{niceDate(d.followup.dueDate, true)}</b>{" "}
                {d.followup.cameBack ? <span className="pill completed">came back</span>
                  : d.followup.daysOverdue > 0 ? <span className="overdue">{d.followup.daysOverdue} days overdue</span> : <span className="muted">upcoming</span>}
                {d.followup.comments && <div className="muted">{d.followup.comments}</div>}
              </div> : <span className="muted">No follow-up set in Yarago.</span>}
              {d.followupActions.map((f: any, i: number) => (
                <div key={i}><b>{FOLLOWUP_WORDS[f.action] ?? f.action}</b>{f.note && `: ${f.note}`}{f.nextCallOn && <span className="muted">, call again {niceDate(f.nextCallOn)}</span>}
                  <div className="muted">{stamp(f.at)}{f.by && `, ${f.by}`}</div></div>
              ))}
            </div>
          </section>
          <div className="small muted">Patient details and clinical data come from Yarago. Change them in Yarago. <Link to="/patients">Find another patient</Link></div>
        </div>
      </div>

      {visitId && <VisitDrawer patientId={p.patientId} visitId={visitId} onClose={() => setVisitId(null)} />}
      {apptId && <AppointmentDrawer id={apptId} onClose={() => setApptId(null)} />}
      {booking && <BookDialog preset={{ date: todayIST(), patient: { patientId: p.patientId, mrd: p.mrd, name: p.name, ageYears: p.ageYears, sex: p.sex, mobile: p.mobile, lastVisit: null } }} onClose={() => setBooking(false)} />}
      {logging && <FollowupLogForm patient={{ patientId: p.patientId, name: p.name, mrd: p.mrd, mobile: p.mobile }} onClose={() => setLogging(false)} />}
    </>
  );
}
