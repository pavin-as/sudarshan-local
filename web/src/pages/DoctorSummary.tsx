// Doctor summary (D-026): one screen per patient for the doctor, in the layout Dr. Sameera agreed (19 Oct).
// Every fact comes from Yarago and links to its visit; only the overview is written by the local model.
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { money, niceDate, planText, stamp, todayIST } from "../format";
import { ErrorNotice, Loading } from "../components/ui";
import { VisitDrawer } from "./Patient";

type Src = { value: string; date: string | null; visitId: number | null } | null;
const SEX: Record<string, string> = { M: "male", F: "female" };
const EYE: Record<string, string> = { RE: "RE", LE: "LE", BE: "BE" };

export function DoctorSummaryPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const date = sp.get("date") ?? todayIST();
  const [visit, setVisit] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["summary", id, date], queryFn: () => api<any>(`/patients/${id}/summary?date=${date}`),
                       refetchInterval: (qr) => (qr.state.data?.overviewState === "ready" ? 5 * 60_000 : 15_000) });
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const { facts: f, overview, overviewState, note } = q.data;
  const p = f.patient, a = f.alerts;
  const go = (visitId: number | null, label: string) => (visitId
    ? <button type="button" className="link" onClick={() => setVisit(visitId)}>{label}</button> : <>{label}</>);
  const since = (d: string | null) => (d ? <span className="muted"> ({niceDate(d)})</span> : null);
  const src = (s: Src, empty: string) => (s ? <>{s.value}{s.date && <span className="muted"> ({go(s.visitId, `recorded ${niceDate(s.date)}`)})</span>}</> : <>{empty}</>);
  const ch = (c: any) => c && <>{c.from} → {c.to}{c.word === "steady" ? ", steady" : `, ${c.word} by ${c.lines} line${c.lines === 1 ? "" : "s"}`}</>;

  return (
    <div className="ds stack">
      <header className="ds-head">
        <div className="ds-id">
          <h1>{p.name ?? "Patient"}</h1>
          <div>{[p.mrd, p.ageYears != null && (p.ageText ?? `${p.ageYears} years`), SEX[p.sex] ?? p.sex, p.language,
                 `${p.visits} visit${p.visits === 1 ? "" : "s"}${p.firstVisit ? ` since ${p.firstVisit.slice(0, 4)}` : ""}`].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="ds-today">
          <div className="small">{date === todayIST() ? "Today" : "For"}, {niceDate(date, true)}</div>
          {f.today ? <>
            <div className="ds-big">{[f.today.slotTime, f.today.token && `token ${f.today.token}`, f.today.doctor].filter(Boolean).join(" · ") || "Booked"}</div>
            {f.today.plan && <div>Booked for: {planText(f.today.plan)}</div>}
          </> : <div>No booking on this day</div>}
        </div>
      </header>

      <section className="panel ds-box">
        <div className="ds-title"><h2>Overview</h2><span className="ds-ai">AI-generated · verify</span></div>
        {overview ? <p className="ds-overview">{overview.text}</p>
          : <p className="muted">{overviewState === "not_shown" ? note : "Being prepared by the local model; the facts below are complete."}</p>}
        {overview && <div className="muted small">Written {stamp(overview.generatedAt)} by {overview.model}{overview.stale ? "; Yarago data has changed since, a new overview is being prepared" : ""}.</div>}
      </section>

      <section className="ds-alerts" aria-label="Alerts">
        <div className={a.systemic ? "ds-alert red" : "ds-alert amber"}><b>Systemic:</b> {src(a.systemic, a.systemicNote ? `not ticked; note: ${a.systemicNote.value}` : "not recorded")}</div>
        <div className={a.allergies ? "ds-alert red" : "ds-alert amber"}><b>Drug allergies:</b> {src(a.allergies, "not recorded")}</div>
        <div className={a.followups.late + a.followups.missed ? "ds-alert amber" : "ds-alert"}>
          <b>Follow-up:</b> {a.followups.late + a.followups.missed === 0 ? "on time in the last year"
            : <>{a.followups.late} late, {a.followups.missed} missed in a year{a.followups.last && <> (due {niceDate(a.followups.last.due)}{a.followups.last.came ? `, came ${niceDate(a.followups.last.came)}` : ", not back"})</>}</>}
        </div>
        {a.dues && <div className="ds-alert teal"><b>Dues:</b> {money(a.dues.total)}</div>}
      </section>

      <div className="ds-grid">
        <section className="panel ds-box">
          <h2>Findings by eye</h2>
          {!f.findings ? <p className="muted">No examination findings recorded.</p> : <>
            <div className="muted small">Latest examination findings; first-seen date in brackets</div>
            <div className="scroll-x"><table className="list">
              <thead><tr><th>Part</th><th>Right eye</th><th>Left eye</th></tr></thead>
              <tbody>{f.findings.rows.map((r: any) => (
                <tr key={r.part}><th>{r.part}</th><td>{r.re ?? "—"}{r.re && since(r.reSince)}</td><td>{r.le ?? "—"}{r.le && since(r.leSince)}</td></tr>))}
              </tbody></table></div>
            <div className="small">{go(f.findings.visitId, `From the ${niceDate(f.findings.date)} visit`)}</div>
          </>}
        </section>

        <section className="panel ds-box">
          <h2>Vision and pressure</h2>
          {!f.vision.rows.length ? <p className="muted">No vision or pressure recorded.</p> : <>
            {(f.vision.change.re || f.vision.change.le) && <div>
              {f.vision.change.re && <><b>Right:</b> {ch(f.vision.change.re)}</>}{f.vision.change.re && f.vision.change.le && " · "}
              {f.vision.change.le && <><b>Left:</b> {ch(f.vision.change.le)}</>}</div>}
            <div className="scroll-x"><table className="list">
              <thead><tr><th>Visit</th><th>BCVA RE</th><th>BCVA LE</th><th>IOP RE</th><th>IOP LE</th></tr></thead>
              <tbody>{f.vision.rows.map((r: any) => (
                <tr key={r.visitId}><td>{go(r.visitId, niceDate(r.date))}</td><td>{r.bcvaRe ?? "—"}</td><td>{r.bcvaLe ?? "—"}</td>
                  <td>{r.iopRe ?? "—"}</td><td>{r.iopLe ?? "—"}</td></tr>))}</tbody></table></div>
            <div className="muted small">Last 5 visits with a reading. IOP in mmHg.</div>
          </>}
        </section>

        <section className="panel ds-box">
          <h2>Treatment</h2>
          {!f.treatment.rows.length ? <p className="muted">No injections or lasers recorded.</p> :
            <div className="scroll-x"><table className="list">
              <thead><tr><th>Date</th><th>Eye</th><th>Treatment</th><th>For this eye</th></tr></thead>
              <tbody>{f.treatment.rows.map((r: any, i: number) => (
                <tr key={i}><td>{go(r.visitId, r.date ? niceDate(r.date, true) : "—")}</td><td>{EYE[r.eye] ?? r.eye ?? "—"}</td>
                  <td>{r.kind === "injection" ? `Injection, ${r.what}` : r.what}</td><td>{r.number ? ordinal(r.number) : ""}</td></tr>))}</tbody></table></div>}
          {f.treatment.next && <div className="ds-note"><b>Next:</b> follow-up written for {niceDate(f.treatment.next.date, true)} ({go(f.treatment.next.visitId, "visit")})</div>}
        </section>

        <section className="panel ds-box">
          <div className="ds-title"><h2>Last visit</h2>{f.lastVisit && go(f.lastVisit.visitId, `${niceDate(f.lastVisit.date, true)}${f.lastVisit.doctor ? `, ${f.lastVisit.doctor}` : ""}`)}</div>
          {!f.lastVisit ? <p className="muted">No earlier completed visit.</p> :
            <dl className="ds-dl">
              <dt>Complaints</dt><dd>{f.lastVisit.complaints ?? "—"}</dd>
              <dt>Plan</dt><dd>{f.lastVisit.plan ?? "—"}</dd>
              <dt>Doctor's notes</dt><dd>{f.lastVisit.remarks ?? "—"}</dd>
              <dt>Medicines</dt><dd>{f.lastVisit.medicines ?? "—"}</dd>
              <dt>Follow-up</dt><dd>{f.lastVisit.followup ? niceDate(f.lastVisit.followup, true) : "—"}</dd>
            </dl>}
        </section>
      </div>

      <footer className="muted small">Every line comes from Yarago; dates open the visit. The overview is written by the local model on shichika
        from these facts only, and is shown only when every number in it is found in them. <Link to={`/patients/${p.patientId}`}>Full patient record</Link></footer>
      {visit && <VisitDrawer patientId={p.patientId} visitId={visit} onClose={() => setVisit(null)} />}
    </div>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
