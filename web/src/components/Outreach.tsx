// WhatsApp messages and Razorpay payment links for one appointment (D-034), shown in the appointment panel.
// Every send is a person's click; test mode is said on every screen that sends.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Appointment, type Message, type OutreachMode, type Payment, type PaymentStatusInfo, type WhatsAppStatus } from "../api";
import { useAuth } from "../auth";
import { MESSAGE_WORDS, PAYMENT_WORDS, REFUND_WORDS, niceDate, rupees, stamp } from "../format";
import { ErrorNotice, useToast } from "./ui";

export function ModeBanner({ mode, what }: { mode: OutreachMode; what: "WhatsApp" | "Payments" }) {
  const text = mode === "live" ? `${what}: live. Messages and links go to patients.`
    : mode === "off" ? `${what} is switched off (Settings).`
    : what === "WhatsApp" ? "WhatsApp test mode: messages go only to the test numbers, and only for bookings named TEST. Real patients get nothing."
    : "Payments test mode: Razorpay test keys, links only for bookings named TEST. No real money moves.";
  return <div className={`mode-banner ${mode}`} role="status">{text}</div>;
}

export function MessagePill({ m }: { m: Pick<Message, "status" | "mode"> }) {
  return <><span className={`pill msg-${m.status}`}>{MESSAGE_WORDS[m.status] ?? m.status}</span>{m.mode === "test" && <> <span className="pill test">test</span></>}</>;
}
export function PaymentPill({ p }: { p: Pick<Payment, "status" | "mode"> }) {
  return <><span className={`pill pay-${p.status}`}>{PAYMENT_WORDS[p.status] ?? p.status}</span>{p.mode === "test" && <> <span className="pill test">test</span></>}</>;
}

export const useWhatsAppStatus = (enabled = true) =>
  useQuery({ queryKey: ["whatsapp-status"], enabled, queryFn: () => api<WhatsAppStatus>("/whatsapp/status"), staleTime: 60_000 });
export const usePaymentStatus = (enabled = true) =>
  useQuery({ queryKey: ["payments-status"], enabled, queryFn: () => api<PaymentStatusInfo & { clinicName?: string }>("/payments/status"), staleTime: 60_000 });

/** Text for WhatsApp on the PC (wa.me): staff see it in WhatsApp and press send themselves. */
function waLink(p: Payment, clinic: string): string {
  const digits = (p.phone ?? "").replace(/\D/g, "");
  const text = `Dear ${p.patientName ?? "patient"}, please pay ${rupees(p.amount)} for your appointment at ${clinic}${p.date ? ` on ${niceDate(p.date, true)}` : ""}: ${p.linkUrl}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

const REFUND_REASONS = ["Appointment cancelled by the clinic", "Patient cancelled", "Paid twice", "Wrong amount", "Other"];

function PaymentItem({ p, onChanged }: { p: Payment; onChanged: () => Promise<void> }) {
  const { can } = useAuth();
  const toast = useToast();
  const wa = useWhatsAppStatus(can("messages.send"));
  const ps = usePaymentStatus(can("payments.write"));
  const [mode, setMode] = useState<null | "cancel" | "refund">(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const open = p.status === "created" || p.status === "sent";
  const left = (p.paidAmount ?? p.amount) - p.refundedAmount - p.refunds.filter((r) => r.status === "pending" || r.status === "requested").reduce((s, r) => s + r.amount, 0);
  const linkReady = !!wa.data?.templates.find((t) => t.key === "payment_link")?.ready;

  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true); setError(null);
    try { await api(`/payments/${p.id}${path}`, { body }); toast(done); setMode(null); setReason(""); setNote(""); await onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.linkUrl ?? ""); toast("Link copied"); } catch { toast("Could not copy: select the link and copy it", "warn"); }
  };

  return (
    <div className="outreach-item stack" style={{ gap: "0.35rem" }}>
      <div className="row"><b>{rupees(p.amount)}</b> <PaymentPill p={p} /><span className="grow" />
        <span className="small muted">{p.reference} · {p.createdBy}, {stamp(p.createdAt)}</span></div>
      {p.linkUrl && open && <div className="small"><span className="link-text">{p.linkUrl}</span>{p.expiresAt && <span className="muted"> · valid until {stamp(p.expiresAt)}</span>}</div>}
      {p.sentAt && <div className="small muted">Sent {p.sentVia === "whatsapp_pc" ? "from WhatsApp on the PC" : "on WhatsApp"}, {stamp(p.sentAt)}{p.phone && ` to +${p.phone}`}</div>}
      {p.paidAt && <div className="small">Paid {rupees(p.paidAmount)} on {stamp(p.paidAt)} <span className="muted">(Razorpay {p.razorpayPaymentId})</span></div>}
      {p.needsReview && <div className="notice small">To check: {p.needsReview}</div>}
      {p.error && <div className="notice error small">{p.error}</div>}
      {p.status === "cancelled" && p.cancelReason && <div className="small muted">Cancelled {stamp(p.cancelledAt)}: {p.cancelReason}</div>}
      {p.refunds.map((r) => (
        <div key={r.id} className="small">Refund {rupees(r.amount)}: <b>{REFUND_WORDS[r.status]}</b> ({r.reason}){r.error && <span className="muted"> · {r.error}</span>}
          <span className="muted"> · {r.by}, {stamp(r.requestedAt)}</span></div>))}
      {can("payments.write") && !mode && (
        <div className="row">
          {open && p.linkUrl && <>
            <button className="btn-small" onClick={() => void copy()}>Copy link</button>
            <a className="btn-small" href={waLink(p, ps.data?.clinicName ?? "the clinic")} target="_blank" rel="noreferrer"
               onClick={() => void act("/sent", {}, "Recorded as sent from WhatsApp on this PC")}>Send from WhatsApp on this PC</a>
            {can("messages.send") && <button className="btn-small" disabled={busy || !linkReady} title={linkReady ? undefined : "The payment-link template is not approved yet (Settings)"}
              onClick={() => void act("/whatsapp", {}, "Payment link queued on WhatsApp")}>Send on WhatsApp (AiSensy)</button>}
          </>}
          {(open || p.status === "failed") && <>
            {open && <button className="btn-small" disabled={busy} onClick={() => void act("/check", {}, "Asked Razorpay")}>Check payment now</button>}
            <button className="btn-small btn-danger" onClick={() => { setMode("cancel"); setError(null); }}>Cancel link</button>
          </>}
          {can("payments.refund") && left > 0 && (p.status === "paid" || p.status === "partially_refunded") &&
            <button className="btn-small btn-danger" onClick={() => { setMode("refund"); setAmount(String(left)); setReason(REFUND_REASONS[0]); setError(null); }}>Refund</button>}
        </div>)}
      {mode === "cancel" && (
        <div className="stack">
          <input autoFocus placeholder="Why cancel the link? (paid at the desk, wrong amount…)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row"><span className="grow" /><button onClick={() => setMode(null)}>Back</button>
            <button className="btn-danger" disabled={busy || reason.trim().length < 2} onClick={() => void act("/cancel", { reason }, "Payment link cancelled")}>Cancel link</button></div>
        </div>)}
      {mode === "refund" && (
        <div className="stack">
          <div className="notice small">Refund to {p.patientName}: the money goes back to how they paid. Paid {rupees(p.paidAmount)}, already refunded {rupees(p.refundedAmount)}.
            At most {rupees(left)}.</div>
          <div className="fields">
            <label className="field"><span>Amount (₹)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></label>
            <label className="field"><span>Reason</span><select value={reason} onChange={(e) => setReason(e.target.value)}>{REFUND_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label className="field wide"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          </div>
          <div className="row"><span className="grow" /><button onClick={() => setMode(null)}>Back</button>
            <button className="btn-danger" disabled={busy || !(Number(amount) > 0)} onClick={() => void act("/refunds", { amount: Number(amount), reason, note: note || null }, `Refund of ${rupees(Number(amount))} asked`)}>
              Refund {rupees(Number(amount) || 0)}</button></div>
        </div>)}
      <ErrorNotice error={error} />
    </div>
  );
}

function NewPaymentForm({ a, onDone }: { a: Appointment; onDone: () => Promise<void> }) {
  const toast = useToast();
  const ps = usePaymentStatus();
  const [amount, setAmount] = useState<string | null>(null);
  const [phone, setPhone] = useState(a.phone ?? "");
  const [checked, setChecked] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const s = ps.data;
  if (!s) return null;
  const amt = amount ?? String(s.defaultAmount);
  const make = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ payment: Payment }>(`/appointments/${a.id}/payments`, { body: { amount: Number(amt), phone, purpose: purpose || null, phoneConfirmed: checked } });
      toast(r.payment.status === "failed" ? "Razorpay did not make the link: see why below" : `Payment link of ${rupees(r.payment.amount)} made`, r.payment.status === "failed" ? "warn" : "ok");
      await onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (s.problem) return <div className="notice small">{s.problem}</div>;
  return (
    <div className="stack">
      <div className="fields">
        <label className="field"><span>Amount (₹{s.minAmount}-{s.maxAmount})</span>
          <input inputMode="numeric" value={amt} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} /></label>
        <label className="field"><span>Patient's mobile (the link goes here)</span><input value={phone} onChange={(e) => { setPhone(e.target.value); setChecked(false); }} /></label>
        <label className="field wide"><span>Note for the clinic (not sent to Razorpay)</span><input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. advance for injection day" /></label>
        <label className="check wide"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I read this number back to the patient and it is right</label>
      </div>
      <ErrorNotice error={error} />
      <div className="row"><span className="small muted">The link is open for {s.linkMinutes} minutes; after that the patient cannot pay on it. Razorpay gets the name, this number and the appointment date, nothing else.</span>
        <span className="grow" /><button className="btn-primary" disabled={busy || !checked || !phone.trim() || !amt} onClick={() => void make()}>Make payment link {rupees(Number(amt) || 0)}</button></div>
    </div>
  );
}

export function AppointmentOutreach({ a }: { a: Appointment }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const msgs = useQuery({ queryKey: ["appointment-messages", a.id], refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === "queued") ? 4000 : false),
                          queryFn: () => api<{ messages: Message[] }>(`/appointments/${a.id}/messages`) });
  const pays = useQuery({ queryKey: ["appointment-payments", a.id], refetchInterval: (q) => (q.state.data?.payments.some((p) => p.status === "created" || p.status === "sent") ? 30_000 : false),
                          queryFn: () => api<{ payments: Payment[] }>(`/appointments/${a.id}/payments`) });
  const wa = useWhatsAppStatus(can("messages.send"));
  const ps = usePaymentStatus(can("payments.write"));
  const [again, setAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [newPay, setNewPay] = useState(false);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["appointment-messages", a.id] }); await qc.invalidateQueries({ queryKey: ["appointment-payments", a.id] }); await qc.invalidateQueries({ queryKey: ["payments"] }); };

  const remind = async () => {
    setBusy(true); setError(null);
    try { await api(`/appointments/${a.id}/messages`, { body: { template: "appointment_reminder", again } }); toast("WhatsApp reminder queued"); setAgain(false); await refresh(); }
    catch (e) { if (e instanceof ApiError && /Send again/.test(e.message)) setAgain(true); setError(e); }
    finally { setBusy(false); }
  };

  const messages = msgs.data?.messages ?? [];
  const payments = pays.data?.payments ?? [];
  const canRemind = can("messages.send") && ["booked", "confirmed"].includes(a.status) && !!a.slotTime && wa.data && wa.data.mode !== "off";
  const hasOpen = payments.some((p) => p.status === "created" || p.status === "sent");
  const canPay = can("payments.write") && ["booked", "confirmed", "waitlist"].includes(a.status) && !hasOpen && ps.data && ps.data.mode !== "off";
  if (!messages.length && !payments.length && !canRemind && !canPay) return null;

  return (
    <section className="stack">
      <h3>WhatsApp and payment</h3>
      {(wa.data?.mode === "test" || ps.data?.mode === "test") && (canRemind || canPay) && (
        <div className="mode-banner small">Test mode: only bookings named TEST get messages or links{wa.data?.mode === "test" ? ", and messages only go to the test numbers" : ""}.</div>)}
      {messages.map((m) => (
        <div key={m.id} className="outreach-item small">
          <b>{m.templateLabel}</b> <MessagePill m={m} /> to {m.to} <span className="muted">· {m.createdBy ?? "system"}, {stamp(m.sentAt ?? m.createdAt)}</span>
          {m.error && <div className="muted">{m.error}</div>}
        </div>))}
      {canRemind && (
        <div className="row">
          <button className="btn-small" disabled={busy} onClick={() => void remind()}>{again ? "Send the reminder again" : "Send WhatsApp reminder"}</button>
          {again && <button className="btn-small btn-quiet" onClick={() => { setAgain(false); setError(null); }}>Do not send</button>}
        </div>)}
      <ErrorNotice error={error} />
      {payments.map((p) => <PaymentItem key={p.id} p={p} onChanged={refresh} />)}
      {a.status === "cancelled" && payments.some((p) => p.status === "paid" || p.status === "partially_refunded") && (
        <div className="notice small">This appointment is cancelled but was paid: decide whether to refund (an admin refunds).</div>)}
      {canPay && (newPay ? <NewPaymentForm a={a} onDone={async () => { setNewPay(false); await refresh(); }} />
        : <div><button className="btn-small" onClick={() => setNewPay(true)}>Make a payment link</button></div>)}
    </section>
  );
}
