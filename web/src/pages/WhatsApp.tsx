// WhatsApp (D-034): the day's appointment reminders, as the Google app's Broadcast page sent them. Preview first (who gets
// it and why the others do not), then a person sends. Below: what was sent, and the Google app's own sends to compare.
import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Message } from "../api";
import { useAuth } from "../auth";
import { dayLabel, stamp, weekdayName } from "../format";
import { ErrorNotice, Loading, useToast } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { MessagePill, ModeBanner, useWhatsAppStatus } from "../components/Outreach";
import { nextWorkDays } from "./Confirmations";

interface PreviewRow { appointmentId: number; patientName: string; mrd: string | null; slotTime: string | null; doctor: string | null; phone: string | null; to: string | null; send: boolean; reason: string | null }
interface Preview { template: { key: string; label: string; campaign: string; params: string[] }; mode: string; keySet: boolean; rows: PreviewRow[] }
interface Broadcast { id: number; template: string; templateLabel: string; campaign: string; forDate: string; mode: string; notSent: number; createdAt: string; finishedAt: string | null;
                      createdBy: string | null; sent: number; failed: number; queued: number; skipped: number }
interface GoogleBroadcast { id: number; campaign: string; forDate: string; sent: number; failed: number; notSent: number; createdBy: string | null; createdAt: string }

function BroadcastMessages({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  const q = useQuery({ queryKey: ["broadcast", id], refetchInterval: (x) => (x.state.data?.messages.some((m) => m.status === "queued") ? 3000 : false),
                       queryFn: () => api<{ messages: Message[] }>(`/whatsapp/broadcasts/${id}`) });
  if (!q.data) return <Loading />;
  return (
    <table className="list compact"><tbody>{q.data.messages.map((m) => (
      <tr key={m.id}><td className="nowrap">{m.slotTime}</td>
        <td><button className="btn-quiet btn-small" onClick={() => m.appointmentId && onOpen(m.appointmentId)}>{m.patientName}</button> <span className="muted small">{m.mrd}</span></td>
        <td className="nowrap">{m.to}</td><td><MessagePill m={m} />{m.error && <div className="small muted">{m.error}</div>}</td></tr>))}</tbody></table>
  );
}

export function WhatsAppPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useWhatsAppStatus();
  const [date, setDate] = useState(nextWorkDays(1)[0]);
  const [template, setTemplate] = useState("appointment_reminder");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openBroadcast, setOpenBroadcast] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const broadcaster = can("messages.broadcast");
  const preview = useQuery({ queryKey: ["whatsapp-preview", date, template], enabled: broadcaster && !!date,
                             queryFn: () => api<Preview>(`/whatsapp/preview?date=${date}&template=${template}`) });
  const history = useQuery({ queryKey: ["whatsapp-broadcasts"], refetchInterval: 10_000,
                             queryFn: () => api<{ broadcasts: Broadcast[]; googleApp: GoogleBroadcast[] }>("/whatsapp/broadcasts") });
  const failed = useQuery({ queryKey: ["whatsapp-failed"], queryFn: () => api<{ messages: Message[] }>("/whatsapp/messages?status=failed") });

  const rows = preview.data?.rows ?? [];
  const go = rows.filter((r) => r.send);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ broadcastId: number; queued: number }>("/whatsapp/broadcasts", { body: { date, template, appointmentIds: go.map((x) => x.appointmentId) } });
      toast(`${r.queued} WhatsApp message${r.queued === 1 ? "" : "s"} queued for ${dayLabel(date)}`);
      setConfirming(false); setOpenBroadcast(r.broadcastId);
      await qc.invalidateQueries();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const templates = (status.data?.templates ?? []).filter((t) => t.kind === "appointment");

  return (
    <div className="stack wa-page" style={{ gap: "1rem" }}>
      <div className="page-head"><div><h1>WhatsApp</h1>
        <div className="muted">Appointment reminders through AiSensy, sent by a person: look at the list, then send. Your name is recorded on every send.</div></div></div>
      {status.data && <ModeBanner mode={status.data.mode} what="WhatsApp" />}
      {status.data && !status.data.keySet && <div className="notice">AiSensy is not set up yet: an admin puts the new AiSensy key in .env on shichika (AISENSY_API_KEY). Until then nothing can be sent.</div>}
      {status.data?.mode === "test" && status.data.testNumbers === 0 && <div className="notice">No test numbers yet: add staff phone numbers on Settings, WhatsApp.</div>}

      {broadcaster && (
        <section className="panel">
          <div className="panel-head"><h2 className="grow">Send the day's reminders</h2>
            <label className="row small">Day <input type="date" value={date} onChange={(e) => { setDate(e.target.value); setConfirming(false); }} /></label>
            {templates.length > 1 && <select value={template} onChange={(e) => { setTemplate(e.target.value); setConfirming(false); }} aria-label="Template">
              {templates.map((t) => <option key={t.key} value={t.key} disabled={!t.ready}>{t.label}{t.ready ? "" : " (not approved yet)"}</option>)}</select>}
          </div>
          {preview.error ? <div className="panel-pad"><ErrorNotice error={preview.error} /></div> : !preview.data ? <Loading /> : <>
            <div className="panel-pad row">
              <div className="grow"><b>{weekdayName(date, true)}, {dayLabel(date)}</b>: {go.length} of {rows.length} booked patients will get "{preview.data.template.label}"
                <div className="small muted">AiSensy campaign {preview.data.template.campaign}, filled with {preview.data.template.params.join(", ")}. Waiting-list patients (no time) are not on this list.</div></div>
              {!confirming && <button className="btn-primary" disabled={!go.length || !preview.data.keySet} onClick={() => { setConfirming(true); setError(null); }}>Send to {go.length} patient{go.length === 1 ? "" : "s"}</button>}
            </div>
            {confirming && (
              <div className="panel-pad row" style={{ paddingTop: 0 }}>
                <div className="notice grow">Send {go.length} WhatsApp message{go.length === 1 ? "" : "s"} now{preview.data.mode === "test" ? " (test mode: test numbers only)" : " to patients"}? This cannot be called back.</div>
                <button onClick={() => setConfirming(false)}>Back</button>
                <button className="btn-primary" disabled={busy} onClick={() => void send()}>Yes, send {go.length}</button>
              </div>)}
            <div className="panel-pad" style={{ paddingTop: 0 }}><ErrorNotice error={error} /></div>
            {rows.length === 0 ? <div className="empty">Nobody is booked with a time on this day.</div> : (
              <table className="list">
                <thead><tr><th>Time</th><th>Patient</th><th>Phone</th><th>Gets the message?</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.appointmentId} className={r.send ? "" : "not-sent"}>
                    <td className="nowrap"><b>{r.slotTime}</b></td>
                    <td><button className="btn-quiet btn-small" style={{ fontWeight: 700 }} onClick={() => setOpenId(r.appointmentId)}>{r.patientName}</button> <span className="muted small">{r.mrd ?? "new"}</span>
                      {r.doctor && <div className="small muted">{r.doctor}</div>}</td>
                    <td className="nowrap">{r.to ?? r.phone ?? <span className="muted">none</span>}</td>
                    <td>{r.send ? "Yes" : <span className="small">No: {r.reason}</span>}</td>
                  </tr>))}</tbody>
              </table>)}
          </>}
        </section>)}

      <section className="panel">
        <div className="panel-head"><h2 className="grow">Sent from Sudarshan</h2></div>
        {history.isLoading ? <Loading /> : !history.data?.broadcasts.length ? <div className="empty">Nothing sent yet.</div> : (
          <table className="list">
            <thead><tr><th>When</th><th>For</th><th>Template</th><th>Sent</th><th>Not delivered</th><th>Waiting</th><th>Not sent</th><th>By</th></tr></thead>
            <tbody>{history.data.broadcasts.map((b) => (<Fragment key={b.id}>
              <tr>
                <td className="nowrap"><button className="btn-quiet btn-small" aria-expanded={openBroadcast === b.id} onClick={() => setOpenBroadcast(openBroadcast === b.id ? null : b.id)}>{stamp(b.createdAt)}</button></td>
                <td className="nowrap">{dayLabel(b.forDate)}</td>
                <td>{b.templateLabel}{b.mode === "test" && <> <span className="pill test">test</span></>}</td>
                <td>{b.sent}</td><td>{b.failed || ""}</td><td>{b.queued || ""}</td><td className="muted">{b.notSent + b.skipped || ""}</td><td>{b.createdBy}</td>
              </tr>
              {openBroadcast === b.id && <tr><td colSpan={8}><BroadcastMessages id={b.id} onOpen={setOpenId} /></td></tr>}
            </Fragment>))}</tbody>
          </table>)}
      </section>

      {!!failed.data?.messages.length && (
        <section className="panel">
          <div className="panel-head"><h2 className="grow">Not delivered</h2><span className="muted small">call these patients instead</span></div>
          <table className="list compact"><tbody>{failed.data.messages.slice(0, 50).map((m) => (
            <tr key={m.id}><td className="nowrap">{stamp(m.createdAt)}</td>
              <td><button className="btn-quiet btn-small" onClick={() => m.appointmentId && setOpenId(m.appointmentId)}>{m.patientName}</button></td>
              <td>{m.templateLabel}</td><td className="nowrap">{m.to}</td><td className="small">{m.error}</td></tr>))}</tbody></table>
        </section>)}

      {!!history.data?.googleApp.length && (
        <section className="panel">
          <div className="panel-head"><h2 className="grow">Sent from the Google app</h2><span className="muted small">copied with the trial refresh, for comparison</span></div>
          <table className="list compact">
            <thead><tr><th>When</th><th>For</th><th>Campaign</th><th>Sent</th><th>Failed</th><th>Skipped</th><th>By</th></tr></thead>
            <tbody>{history.data.googleApp.map((g) => (
              <tr key={g.id}><td className="nowrap">{stamp(g.createdAt)}</td><td className="nowrap">{g.forDate && g.forDate !== "None" ? dayLabel(g.forDate) : ""}</td>
                <td>{g.campaign}</td><td>{g.sent}</td><td>{g.failed || ""}</td><td>{g.notSent || ""}</td><td>{g.createdBy}</td></tr>))}</tbody>
          </table>
        </section>)}
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
