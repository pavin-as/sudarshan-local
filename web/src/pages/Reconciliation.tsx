// Money reconciliation (D-052): Yarago revenue and payments against Zoho bank credits, with approved adjustments.
// Every figure comes from the server (services/reconcile.ts); this page only shows it. Differences are explained by
// status words ("Waiting for settlement", "Cash not yet deposited" are normal), never forced into a match.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ReconResponse, type ReconRow, type ReconStatus } from "../api";
import { addDays, dayLabel, niceDate, rupees, stamp, todayIST } from "../format";
import { useAuth } from "../auth";
import { Drawer, ErrorNotice, Loading, useToast } from "../components/ui";

export const METHOD_WORDS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", cheque: "Cheque", other: "Other", unrecorded: "Not recorded" };
const SOURCE_WORDS: Record<string, string> = { clinic_bill: "Clinic bills", pharmacy_payment: "Pharmacy and optical", pharmacy: "Pharmacy and optical",
                                               opd_refund: "Clinic refund", pharmacy_refund: "Pharmacy refund" };
const EDGE: Record<ReconStatus, string> = { matched: "ok", within_tolerance: "ok", awaiting: "plain", no_bank_data: "plain", cash_in_hand: "plain",
                                            not_tracked: "plain", nothing_due: "plain", uncertain: "warn", difference: "bad" };
/** ₹1,500 or −₹1,500 */
const r0 = (n: number) => (n < 0 ? `−${rupees(-n)}` : rupees(n));

export function StatusWord({ status, words }: { status: ReconStatus; words: string }) {
  return <span className={`recon-status ${EDGE[status]}`}>{words}</span>;
}

export function ReconciliationPage() {
  const { can } = useAuth();
  const today = todayIST();
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(addDays(today, -1));
  const [open, setOpen] = useState<{ date: string; method: string | null } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const data = useQuery({ queryKey: ["recon", from, to], enabled: from <= to,
                          queryFn: () => api<ReconResponse>(`/recon?from=${from}&to=${to}`) });
  const fetchZoho = useMutation({
    mutationFn: () => api<{ status: string; counts: Record<string, number>; message: string | null }>("/recon/zoho/fetch", { body: { from, to } }),
    onSuccess: (r) => { r.status === "ok" ? toast(`Zoho read: ${r.counts.lines} bank lines (${r.counts.new} new, ${r.counts.changed} changed)`) : toast(r.message ?? "Zoho fetch failed", "err");
                        void qc.invalidateQueries({ queryKey: ["recon"] }); },
    onError: (e: any) => toast(e.message, "err"),
  });
  const d = data.data, res = d?.result, t = res?.totals, zs = d?.zohoStatus;
  return (
    <div className="stack recon-page" style={{ gap: "1rem" }}>
      <div className="page-head">
        <div><h1>Reconciliation</h1><div className="muted">Yarago revenue and payments against the bank, as Zoho Books shows it. Approved adjustments are included and marked.</div></div>
        <span className="grow" />
        <label className="field"><span>From</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={() => fetchZoho.mutate()} disabled={fetchZoho.isPending || !zs?.configured || from > to}>{fetchZoho.isPending ? "Reading Zoho…" : "Fetch from Zoho"}</button>
        {can("adjustments.submit") && <Link className="btn" to="/adjustments">Adjustments{d?.pendingAdjustments ? <span className="count">{d.pendingAdjustments}</span> : null}</Link>}
      </div>

      {data.error && <ErrorNotice error={data.error} />}
      {zs && <Freshness d={d!} />}
      {data.isLoading || !res || !t ? <Loading /> : (<>
        <div className="recon-tiles">
          <Tile n={t.billedAdjusted} label="Billed" sub={t.adjustments.revenue ? `${r0(t.billed)} in Yarago, ${r0(t.adjustments.revenue)} adjusted` : "Yarago bills and sales"} />
          <Tile n={t.collected} label="Collected" sub="payments in Yarago" />
          <Tile n={t.refunds + t.adjustments.refunds} label="Refunds" sub={t.refundsUnrecorded ? `plus ${r0(t.refundsUnrecorded)} without a method` : undefined} />
          <Tile n={t.adjustments.count} label="Approved adjustments" count sub="included below, marked" to={can("adjustments.submit") ? "/adjustments?view=approved" : undefined} />
          <Tile n={t.depositsMatched} label="Reached the bank" sub="matched credits" kind="ok" />
          <Tile n={t.notYetDue} label="Not yet known" sub="waiting for settlement or bank data" />
          <Tile n={t.cashInHand} label="Cash not yet deposited" sub={t.cashDeposited ? `${r0(t.cashDeposited)} deposited` : "cash is not banked daily"} />
          <Tile n={t.uncertain} label="Uncertain" sub="more than one possible credit" kind={t.uncertain ? "warn" : undefined} />
          <Tile n={t.differenceToExplain} label="Difference to explain" sub="window closed, no matching credit" kind={t.differenceToExplain ? "bad" : "ok"} />
          <Tile n={t.unclassifiedCredits} label="Bank credits not counted" sub="no rule or classification" kind={t.unclassifiedCredits ? "warn" : undefined} />
        </div>

        <section className="panel">
          <div className="panel-head"><h2 className="grow">By payment method</h2><span className="small muted">Expected = collected − refunds ± approved adjustments − fees</span></div>
          <div className="table-wrap"><table className="list compact">
            <thead><tr><th>Method</th><th className="right">Collected</th><th className="right">Refunds</th><th className="right">Adjustments</th><th className="right">Fees</th>
              <th className="right">Expected</th><th className="right">Reached bank</th><th className="right">Not yet known</th><th className="right">Uncertain</th><th className="right">Difference</th></tr></thead>
            <tbody>{res.byMethod.map((m) => (
              <tr key={m.method}><td><b>{METHOD_WORDS[m.method]}</b>{m.method === "cash" && <div className="small muted">in hand until deposited</div>}
                {m.method !== "cash" && !res.trackedMethods.includes(m.method) && <div className="small muted">no bank rule</div>}</td>
                <td className="right fig">{r0(m.collected)}</td><td className="right fig">{r0(m.refunds)}</td><td className="right fig">{m.adjustments ? r0(m.adjustments) : ""}</td>
                <td className="right fig">{m.fees ? r0(m.fees) : ""}</td><td className="right fig">{r0(m.net - m.fees)}</td><td className="right fig">{r0(m.deposited)}</td>
                <td className="right fig">{m.notYetDue ? r0(m.notYetDue) : ""}</td><td className="right fig">{m.uncertain ? r0(m.uncertain) : ""}</td>
                <td className={`right fig ${m.difference ? "bad-text" : ""}`}>{m.difference ? r0(m.difference) : ""}</td></tr>))}</tbody>
          </table></div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2 className="grow">Day by day</h2><span className="small muted">Open a row for the Yarago records and bank lines behind it</span></div>
          {!res.rows.length ? <div className="empty">No money recorded in Yarago in this period.</div> : (
            <div className="table-wrap"><table className="list compact">
              <thead><tr><th>Day</th><th>Method</th><th className="right">Collected</th><th className="right">Refunds</th><th className="right">Adjusted</th>
                <th className="right">Expected</th><th className="right">Reached bank</th><th>Status</th><th /></tr></thead>
              <tbody>{res.rows.filter((r) => r.status !== "nothing_due" || r.collected || r.refunds).map((r) => (
                <tr key={`${r.date}-${r.method}`} className={`clickable edge-${EDGE[r.status]}`} onClick={() => setOpen({ date: r.date, method: r.method })}>
                  <td className="nowrap">{dayLabel(r.date)}</td><td>{METHOD_WORDS[r.method]}</td>
                  <td className="right fig">{r0(r.collected)}</td><td className="right fig">{r.refunds ? r0(r.refunds) : ""}</td>
                  <td className="right fig">{r.adjCollected || r.adjRefunds || r.fees ? <span title="Approved adjustments">{r0(r.adjCollected - r.adjRefunds - r.fees)} <span className="tag">adj.</span></span> : ""}</td>
                  <td className="right fig">{r0(r.expected)}</td><td className="right fig">{r.method === "cash" && !r.deposited ? "" : r0(r.deposited)}</td>
                  <td><StatusWord status={r.status} words={r.statusWords} />{r.note && <div className="small muted">{r.note}</div>}</td>
                  <td className="right"><button className="btn-small" onClick={(e) => { e.stopPropagation(); setOpen({ date: r.date, method: r.method }); }}>Open</button></td>
                </tr>))}</tbody>
            </table></div>)}
        </section>

        <div className="recon-two">
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Revenue by category</h2></div>
            <table className="list compact">
              <thead><tr><th>Category</th><th className="right">Billed in Yarago</th><th className="right">Adjusted</th><th className="right">Total</th></tr></thead>
              <tbody>{res.byCategory.map((c) => (
                <tr key={c.category}><td>{d!.words.categories[c.category]}</td><td className="right fig">{r0(c.billed)}</td>
                  <td className="right fig">{c.adjustments ? r0(c.adjustments) : ""}</td><td className="right fig"><b>{r0(c.total)}</b></td></tr>))}</tbody>
            </table>
            <p className="small muted panel-pad">Consultation = consultation and charges; procedure = investigations, injections, lasers, other procedures and other charges.
              Payments are recorded per bill, not per line, so methods are shown per source below, never split by category.</p>
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Collected by source and method</h2></div>
            <table className="list compact">
              <thead><tr><th>Source</th><th>Method</th><th className="right">Collected</th></tr></thead>
              <tbody>{res.bySourceMethod.map((s) => <tr key={`${s.source}-${s.method}`}><td>{SOURCE_WORDS[s.source] ?? s.source}</td><td>{METHOD_WORDS[s.method]}</td><td className="right fig">{r0(s.collected)}</td></tr>)}</tbody>
            </table>
            {!!res.billedVsCollected.length && <table className="list compact">
              <thead><tr><th>Source</th><th className="right">Billed</th><th className="right">Collected</th><th className="right">Unpaid, discount or advance</th></tr></thead>
              <tbody>{res.billedVsCollected.map((s) => <tr key={s.source}><td>{SOURCE_WORDS[s.source]}</td><td className="right fig">{r0(s.billed)}</td>
                <td className="right fig">{r0(s.collected)}</td><td className="right fig">{s.gap ? r0(s.gap) : ""}</td></tr>)}</tbody>
            </table>}
          </section>
        </div>

        {(!!res.unclassified.length || res.credits.some((c) => c.state === "unmatched" || c.state === "uncertain")) && (
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Bank credits to look at</h2><span className="small muted">Not counted as clinic money until a rule or an approved classification says so</span></div>
            <table className="list compact">
              <thead><tr><th>Day</th><th className="right">Amount</th><th>Bank wording</th><th>State</th><th /></tr></thead>
              <tbody>
                {res.unclassified.map((u) => <CreditRow key={u.transactionId} id={u.transactionId} date={u.date} amount={u.amount} text={u.description} state="Not classified" canAsk={can("adjustments.submit")} />)}
                {res.credits.filter((c) => c.state === "unmatched" || c.state === "uncertain").map((c) =>
                  <CreditRow key={c.transactionId} id={c.transactionId} date={c.date} amount={c.amount} text={c.description}
                             state={`${METHOD_WORDS[c.method ?? "other"]} settlement, ${c.state === "uncertain" ? "could be more than one day" : "not matched to a day"}`} canAsk={can("adjustments.submit")} />)}
              </tbody>
            </table>
          </section>)}

        {!!res.refundsUnrecordedList.length && (
          <section className="panel panel-pad">
            <h2>Refunds without a recorded method</h2>
            <p className="small muted">Yarago keeps only the amount on the pharmacy payment, so these are taken off no method and their day is the record's last change.</p>
            <ul>{res.refundsUnrecordedList.map((x) => <li key={x.refundId}>{dayLabel(x.onDate)}: {r0(x.amount)} ({SOURCE_WORDS[x.source]}{x.billNo ? `, bill ${x.billNo}` : ""})</li>)}</ul>
          </section>)}

        {!!res.effects.length && (
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Approved adjustments in this period</h2></div>
            <table className="list compact">
              <thead><tr><th>Request</th><th>Day</th><th>What it changes</th></tr></thead>
              <tbody>{res.effects.map((e, i) => (
                <tr key={i}><td className="nowrap"><Link to={`/adjustments?open=${e.adjustmentId}`}>#{e.adjustmentId}</Link>{e.selfApproved && <div><span className="tag alert">self-approved</span></div>}</td>
                  <td className="nowrap">{dayLabel(e.onDate)}</td><td className="small">{e.words}</td></tr>))}</tbody>
            </table>
          </section>)}

        <Assistant from={from} to={to} />
        <BankRules />
      </>)}
      {open && <DayDrawer date={open.date} method={open.method} onClose={() => setOpen(null)} row={res?.rows.find((r) => r.date === open.date && r.method === open.method)} />}
    </div>
  );
}

function Tile({ n, label, sub, kind, count, to }: { n: number; label: string; sub?: string; kind?: "ok" | "warn" | "bad"; count?: boolean; to?: string }) {
  const body = <><div className="recon-tile-n fig">{count ? n : rupees(n)}</div><div className="recon-tile-l">{label}</div>{sub && <div className="small muted">{sub}</div>}</>;
  return to ? <Link to={to} className={`recon-tile ${kind ?? ""}`}>{body}</Link> : <div className={`recon-tile ${kind ?? ""}`}>{body}</div>;
}

function Freshness({ d }: { d: ReconResponse }) {
  const zs = d.zohoStatus;
  const z = !zs.configured ? <span><b>Zoho is not connected yet</b>: the bank side shows "Bank data not available" until an administrator runs scripts\setup-zoho.ps1 (RUNBOOK 14).</span>
    : !zs.fetchedAt ? <span><b>Zoho has not been read yet</b>: press "Fetch from Zoho".</span>
    : <span>Zoho read {stamp(zs.fetchedAt)}{zs.stale && <b> (over {zs.staleHours} hours ago: fetch again; until then nothing is called a difference)</b>}; bank feed up to {zs.feedRefreshedOn ? niceDate(zs.feedRefreshedOn) : "unknown"}.</span>;
  return (
    <div className={`notice ${!zs.configured || zs.stale || zs.lastRun?.status === "failed" ? "" : "ok"}`}>
      Yarago copied {d.yaragoSyncedAt ? stamp(d.yaragoSyncedAt) : "unknown"}. {z}
      {zs.lastRun?.status === "failed" && <div className="small">Last Zoho read failed ({stamp(zs.lastRun.startedAt)}): {zs.lastRun.message}</div>}
    </div>
  );
}

function CreditRow({ id, date, amount, text, state, canAsk }: { id: string; date: string; amount: number; text: string | null; state: string; canAsk: boolean }) {
  return (
    <tr><td className="nowrap">{dayLabel(date)}</td><td className="right fig">{rupees(amount)}</td><td className="small">{text ?? ""}<div className="muted">Zoho {id}</div></td>
      <td className="small">{state}</td>
      <td className="right">{canAsk && <Link className="btn btn-small" to={`/adjustments?new=bank_credit&txn=${encodeURIComponent(id)}&date=${date}`}>Classify</Link>}</td></tr>
  );
}

function DayDrawer({ date, method, onClose, row }: { date: string; method: string | null; onClose: () => void; row?: ReconRow }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["recon-detail", date, method], queryFn: () => api<any>(`/recon/detail?date=${date}${method ? `&method=${method}` : ""}`) });
  const d = q.data;
  const matched = new Set(row?.matches.map((m) => m.transactionId));
  const cand = new Set(row?.candidates.map((m) => m.transactionId));
  return (
    <Drawer wide title={`${dayLabel(date)}${method ? ` · ${METHOD_WORDS[method]}` : ""}`} onClose={onClose}
            sub={row ? <>Expected {rupees(row.expected)}, reached the bank {rupees(row.deposited)} · <StatusWord status={row.status} words={row.statusWords} /></> : undefined}
            foot={can("adjustments.submit") ? <button className="btn-primary" onClick={() => nav(`/adjustments?new=1&date=${date}${method ? `&method=${method}` : ""}`)}>Ask for an adjustment for this day</button> : undefined}>
      {q.error && <ErrorNotice error={q.error} />}
      {!d ? <Loading /> : (
        <div className="stack" style={{ gap: "1rem" }}>
          {row?.note && <div className="notice">{row.note}</div>}
          <section><h3>Payments in Yarago</h3>
            {!d.payments.length ? <div className="muted small">None.</div> : <table className="list compact">
              <thead><tr><th>Patient</th><th>Bill</th><th>Source</th><th>Method</th><th className="right">Amount</th><th>Reference</th></tr></thead>
              <tbody>{d.payments.map((p: any) => <tr key={p.id}><td>{p.patientId ? <Link to={`/patients/${p.patientId}`}>{p.name ?? "Patient"}</Link> : "-"} <span className="small muted">{p.mrd ?? ""}</span></td>
                <td className="nowrap">{p.billNo ?? "-"}</td><td className="small">{SOURCE_WORDS[p.source]}</td><td>{METHOD_WORDS[p.method]}</td><td className="right fig">{rupees(p.amount)}</td><td className="small">{p.ref ?? ""}</td></tr>)}</tbody>
            </table>}</section>
          <section><h3>Refunds in Yarago</h3>
            {!d.refunds.length ? <div className="muted small">None.</div> : <table className="list compact">
              <thead><tr><th>Patient</th><th>Bill</th><th>Recorded as</th><th className="right">Amount</th></tr></thead>
              <tbody>{d.refunds.map((r: any) => <tr key={r.id}><td>{r.patientId ? <Link to={`/patients/${r.patientId}`}>{r.name ?? "Patient"}</Link> : "-"} <span className="small muted">{r.mrd ?? ""}</span></td>
                <td>{r.billNo ?? "-"}</td><td>{METHOD_WORDS[r.method]}{r.dateUncertain && <div className="small muted">day not recorded</div>}</td><td className="right fig">{rupees(r.amount)}</td></tr>)}</tbody>
            </table>}</section>
          {!!d.lines.length && <section><h3>Billed that day</h3><table className="list compact"><tbody>{d.lines.map((l: any) =>
            <tr key={l.serviceGroup + l.source}><td>{l.serviceGroup}</td><td className="small muted">{l.lines} lines</td><td className="right fig">{rupees(l.amount)}</td></tr>)}</tbody></table></section>}
          {!!d.adjustments.length && <section><h3>Adjustments for this day</h3><ul className="small">{d.adjustments.map((a: any) =>
            <li key={a.id}><Link to={`/adjustments?open=${a.id}`}>#{a.id}</Link> {a.status}{a.selfApproved ? " (self-approved)" : ""}: {rupees(a.amount)}{a.billNo ? `, bill ${a.billNo}` : ""}. {a.reason}</li>)}</ul></section>}
          <section><h3>Zoho bank lines, {dayLabel(date)} to {dayLabel(addDays(date, d.windowDays))}</h3>
            {!d.bank.length ? <div className="muted small">None in Sudarshan's copy of Zoho.</div> : <table className="list compact">
              <thead><tr><th>Day</th><th className="right">Amount</th><th>Bank wording</th><th /></tr></thead>
              <tbody>{d.bank.map((b: any) => <tr key={b.id}><td className="nowrap">{dayLabel(b.date)}</td>
                <td className="right fig">{b.side === "debit" ? "−" : ""}{rupees(b.amount)}</td><td className="small">{b.description}<div className="muted">Zoho {b.id} · {b.status}{b.missing ? " · no longer in Zoho" : ""}</div></td>
                <td className="small">{matched.has(b.id) ? <b>matched to this row</b> : cand.has(b.id) ? "possible" : ""}</td></tr>)}</tbody>
            </table>}</section>
          {!!d.zohoPayments.length && <section><h3>What the bookkeeper recorded in Zoho</h3><p className="small muted">A cross-check only: never counted as money in the bank.</p>
            <table className="list compact"><tbody>{d.zohoPayments.map((p: any) => <tr key={p.id}><td className="nowrap">{dayLabel(p.date)}</td><td>{p.mode}</td>
              <td className="right fig">{rupees(p.amount)}</td><td className="small">{p.accountName}{p.invoiceNumbers ? ` · ${p.invoiceNumbers}` : ""}</td></tr>)}</tbody></table></section>}
        </div>)}
    </Drawer>
  );
}

function Assistant({ from, to }: { from: string; to: string }) {
  const [question, setQuestion] = useState("");
  const ask = useMutation({ mutationFn: () => api<{ text: string | null; status: string; model: string; error: string | null }>("/recon/assistant", { body: { from, to, question: question.trim() || null } }) });
  return (
    <section className="panel panel-pad stack">
      <div className="ds-title"><h2>Ask the assistant</h2><span className="small muted">Optional. A local model on shichika explains the figures above; it does not calculate, change or approve anything.</span></div>
      <div className="row">
        <input className="grow" style={{ minWidth: "14rem" }} maxLength={300} placeholder="For example: why is UPI different on Tuesday?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button onClick={() => ask.mutate()} disabled={ask.isPending}>{ask.isPending ? "Thinking… (up to a minute)" : "Ask"}</button>
      </div>
      {ask.error && <div className="notice">{(ask.error as any).message}</div>}
      {ask.data && (ask.data.text
        ? <div className="recon-ai"><span className="ds-ai">AI-generated · verify</span><div style={{ whiteSpace: "pre-wrap" }}>{ask.data.text}</div><div className="small muted">{ask.data.model}. The figures on this page are the reconciliation's, not the model's.</div></div>
        : <div className="notice">{ask.data.error}</div>)}
    </section>
  );
}

const CLASS_WORDS: Record<string, string> = { upi_settlement: "UPI settlement", card_settlement: "Card settlement", cash_deposit: "Cash deposit",
                                              online_settlement: "Online payments settlement", not_clinic: "Not clinic money" };
function BankRules() {
  const { can } = useAuth();
  const admin = can("adjustments.approve");
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["recon-rules"], queryFn: () => api<{ rules: any[]; settings: { tolerance: Record<string, number> } }>("/recon/bank-rules") });
  const save = useMutation({
    mutationFn: (r: any) => api(`/recon/bank-rules${r.id ? `/${r.id}` : ""}`, { method: r.id ? "PUT" : "POST",
      body: { position: r.position, pattern: r.pattern, class: r.class, method: r.class === "not_clinic" ? null : r.method, windowDays: Number(r.windowDays), isActive: r.isActive, note: r.note ?? null } }),
    onSuccess: () => { toast("Bank rule saved"); void qc.invalidateQueries({ queryKey: ["recon-rules"] }); void qc.invalidateQueries({ queryKey: ["recon"] }); },
    onError: (e: any) => toast(e.message, "err"),
  });
  const [draft, setDraft] = useState<any | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Bank rules</h2><span className="small muted">Which bank credits count as clinic money, by their wording{admin ? "" : " (admin changes these)"}</span>
        {admin && <button className="btn-small" onClick={() => setDraft({ position: 100, pattern: "", class: "upi_settlement", method: "upi", windowDays: 3, isActive: false })}>Add a rule</button>}</div>
      {!q.data ? <Loading /> : <table className="list compact">
        <thead><tr><th>Order</th><th>Bank wording (pattern)</th><th>Counts as</th><th>Window</th><th>On</th><th /></tr></thead>
        <tbody>{q.data.rules.map((r) => <tr key={r.id}><td>{r.position}</td><td><code>{r.pattern}</code>{r.note && <div className="small muted">{r.note}</div>}</td>
          <td>{CLASS_WORDS[r.class]}{r.method && r.class !== "not_clinic" ? ` (${METHOD_WORDS[r.method]})` : ""}</td><td>{r.windowDays} days</td><td>{r.isActive ? "On" : "Off"}</td>
          <td className="right">{admin && <button className="btn-small" onClick={() => setDraft({ ...r })}>Change</button>}</td></tr>)}</tbody>
      </table>}
      {draft && admin && (
        <div className="panel-pad stack">
          <div className="fields">
            <label className="field"><span>Order</span><input type="number" value={draft.position} onChange={(e) => setDraft({ ...draft, position: Number(e.target.value) })} /></label>
            <label className="field wide"><span>Bank wording (regular expression, any case)</span><input value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} /></label>
            <label className="field"><span>Counts as</span><select value={draft.class} onChange={(e) => setDraft({ ...draft, class: e.target.value })}>
              {Object.entries(CLASS_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {draft.class !== "not_clinic" && <label className="field"><span>Method</span><select value={draft.method ?? ""} onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
              {["upi", "card", "cash", "cheque", "other"].map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</select></label>}
            <label className="field"><span>Settlement window (days)</span><input type="number" min={0} max={10} value={draft.windowDays} onChange={(e) => setDraft({ ...draft, windowDays: e.target.value })} /></label>
            <label className="field"><span>On</span><select value={draft.isActive ? "1" : "0"} onChange={(e) => setDraft({ ...draft, isActive: e.target.value === "1" })}><option value="1">On</option><option value="0">Off</option></select></label>
          </div>
          <div className="row"><span className="grow" /><button onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => setDraft(null) })}>Save rule</button></div>
        </div>)}
    </section>
  );
}
