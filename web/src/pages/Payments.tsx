// Payment links (D-034): open links, paid, and what needs checking. Links are made from the appointment panel; Sudarshan
// asks Razorpay how each open link stands every minute (no webhook, D-017).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Payment } from "../api";
import { dayLabel, rupees, stamp } from "../format";
import { ErrorNotice, Loading } from "../components/ui";
import { AppointmentDrawer } from "../components/AppointmentDrawer";
import { ModeBanner, PaymentPill, usePaymentStatus } from "../components/Outreach";

type View = "open" | "paid" | "review" | "all";

export function PaymentsPage() {
  const [view, setView] = useState<View>("open");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const status = usePaymentStatus();
  const list = useQuery({ queryKey: ["payments", view, search], refetchInterval: 60_000,
                          queryFn: () => api<{ payments: Payment[]; counts: { open: number; review: number } }>(`/payments?view=${view}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`) });
  const c = list.data?.counts;
  const s = status.data;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head">
        <div><h1>Payments</h1><div className="muted">Razorpay payment links. Make one from the appointment panel ("Make a payment link"); open a row to send, check, cancel or refund.</div></div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which payments">
          <button aria-pressed={view === "open"} onClick={() => setView("open")}>Open links{c ? ` (${c.open})` : ""}</button>
          <button aria-pressed={view === "paid"} onClick={() => setView("paid")}>Paid</button>
          <button aria-pressed={view === "review"} onClick={() => setView("review")}>To check{c?.review ? ` (${c.review})` : ""}</button>
          <button aria-pressed={view === "all"} onClick={() => setView("all")}>All</button>
        </div>
        <input type="search" placeholder="Name, MRD or SUD-…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search payments" />
      </div>
      {s && <ModeBanner mode={s.mode} what="Payments" />}
      {s?.problem && s.mode !== "off" && <div className="notice">{s.problem}</div>}
      {s?.lastCheck && <div className="small muted">Razorpay last asked {stamp(s.lastCheck.at)}: {s.lastCheck.checked} open, {s.lastCheck.changed} changed
        {s.lastCheck.error && <span> · last problem: {s.lastCheck.error}</span>}</div>}
      {list.error && <ErrorNotice error={list.error} />}
      <div className="panel">
        {list.isLoading ? <Loading /> : !list.data?.payments.length ? <div className="empty">{view === "open" ? "No open payment links." : "Nothing here."}</div> : (
          <table className="list">
            <thead><tr><th>Made</th><th>Patient</th><th>Appointment</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.payments.map((p) => (
              <tr key={p.id}>
                <td className="nowrap small">{stamp(p.createdAt)}<div className="muted">{p.reference} · {p.createdBy}</div></td>
                <td><b>{p.patientName}</b> <span className="muted small">{p.mrd ?? ""}</span>{p.phone && <div className="small muted">+{p.phone}</div>}</td>
                <td className="nowrap">{p.date ? `${dayLabel(p.date)} ${p.slotTime ?? "waitlist"}` : ""}</td>
                <td className="nowrap">{rupees(p.amount)}{p.refundedAmount > 0 && <div className="small muted">refunded {rupees(p.refundedAmount)}</div>}</td>
                <td><PaymentPill p={p} />
                  {p.paidAt && <div className="small muted">paid {stamp(p.paidAt)}</div>}
                  {p.needsReview && <div className="small">To check: {p.needsReview}</div>}
                  {p.error && <div className="small">{p.error}</div>}
                  {p.refunds.some((r) => r.status === "failed") && <div className="small">A refund failed</div>}</td>
                <td className="right">{p.appointmentId && <button className="btn-small" onClick={() => setOpenId(p.appointmentId)}>Open</button>}</td>
              </tr>))}</tbody>
          </table>)}
      </div>
      {openId && <AppointmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
