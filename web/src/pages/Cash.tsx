// Cash deposits and the cash book (D-053). The cash desk (cash.deposit) records what it takes to the bank, blind: the
// server never sends it Yarago's cash, so this page cannot show it. Finance (reconciliation.read) sees the whole book:
// Yarago cash per deposit, the drawer's carry, the bank match and cash in hand against the ₹4,00,000 limit.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CashResponse, type DepositCheck } from "../api";
import { addDays, dayLabel, niceDate, rupees, stamp, todayIST } from "../format";
import { useAuth } from "../auth";
import { ErrorNotice, Loading, useToast } from "../components/ui";

const r0 = (n: number) => (n < 0 ? `−${rupees(-n)}` : rupees(n));
const BANK_EDGE: Record<DepositCheck["bank"], string> = { found: "ok", waiting: "plain", no_bank_data: "plain", uncertain: "warn", not_found: "bad" };
const CHECK_EDGE: Record<DepositCheck["check"], string> = { ok: "ok", short: "bad", excess: "bad" };
const range = (a: string, b: string) => (a === b ? niceDate(a) : `${niceDate(a)} – ${niceDate(b)}`);

export function CashPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["cash"], queryFn: () => api<CashResponse>("/cash"), refetchInterval: 5 * 60_000 });
  const d = q.data;
  return (
    <div className="stack recon-page" style={{ gap: "1rem" }}>
      <div className="page-head">
        <div><h1>Cash deposits</h1>
          <div className="muted">{d?.full ? "The cash book: every deposit checked against Yarago's cash and the bank. Cash stays in hand until a deposit covers its day."
            : "Record each cash deposit when it goes to the bank. Count the cash and write what you deposit; the check against Yarago is done by the admin."}</div></div>
        <span className="grow" />
        {d?.full && <Link className="btn" to="/reconciliation">Reconciliation</Link>}
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {!d ? <Loading /> : (<>
        <Limit d={d} />
        {can("cash.deposit") && <DepositForm d={d} />}
        {d.full && d.book ? <FullBook d={d} /> : <DeskList d={d} />}
        {d.full && can("adjustments.approve") && d.settings && <Settings d={d} />}
      </>)}
    </div>
  );
}

function Limit({ d }: { d: CashResponse }) {
  const ih = d.full && d.book ? d.book.inHand : null;
  const desk = d.desk.inHand;
  const level = ih?.level ?? desk.level;
  return (
    <div className={`cash-banner ${level === "ok" ? "" : level}`} role="status">
      {ih ? <span><b className="big fig">{rupees(ih.amount)}</b> cash not yet deposited</span> : <b className="big">{desk.levelWords}</b>}
      {ih && <b>{ih.levelWords}</b>}
      <span>{desk.lastDeposit ? <>Last deposit {niceDate(desk.lastDeposit.depositedOn)} ({desk.daysSinceLastDeposit === 0 ? "today" : `${desk.daysSinceLastDeposit} day${desk.daysSinceLastDeposit === 1 ? "" : "s"} ago`}), cash up to {niceDate(desk.lastDeposit.coversTo)}</> : "No deposit recorded yet"}</span>
      {desk.firstCashDay && <span>Oldest cash not deposited: {niceDate(desk.firstCashDay)}</span>}
      {ih && d.book && <span className="small muted">Limit {rupees(d.book.limits.limit)}; amber from {rupees(d.book.limits.warnAt)}</span>}
    </div>
  );
}

function DepositForm({ d }: { d: CashResponse }) {
  const today = todayIST();
  const qc = useQueryClient();
  const toast = useToast();
  const from = d.desk.nextCoversFrom;
  const blank = () => ({ key: crypto.randomUUID(), depositedOn: today, coversTo: addDays(today, -1) < from ? from : addDays(today, -1), amount: "", slipNo: "", note: "" });
  const [f, setF] = useState(blank);
  const [checking, setChecking] = useState(false);
  // after a deposit the next one starts later: move a default that is now covered
  useEffect(() => { setF((p) => (p.coversTo < from ? { ...p, coversTo: addDays(today, -1) < from ? from : addDays(today, -1) } : p)); }, [from, today]);
  const amount = Number(f.amount);
  const save = useMutation({
    mutationFn: () => api<{ id: number; again: boolean }>("/cash/deposits", { body: { requestKey: f.key, depositedOn: f.depositedOn, coversTo: f.coversTo, amount,
                                                                                      slipNo: f.slipNo.trim() || null, note: f.note.trim() || null } }),
    onSuccess: (r) => { toast(r.again ? "This deposit was already recorded" : `Deposit #${r.id} recorded`); setF(blank()); setChecking(false); void qc.invalidateQueries({ queryKey: ["cash"] }); void qc.invalidateQueries({ queryKey: ["recon"] }); },
    onError: () => setChecking(false),
  });
  const ok = amount > 0 && f.depositedOn <= today && f.coversTo <= f.depositedOn && f.coversTo >= from;
  if (from > today) return <section className="panel panel-pad">All cash up to today is in a recorded deposit.</section>;
  return (
    <section className="panel panel-pad stack">
      <div className="ds-title"><h2>Record a deposit</h2><span className="small muted">From the bank slip. Only the admin can cancel a wrong entry, so check it before saving.</span></div>
      <div className="fields">
        <label className="field"><span>Deposited on</span><input type="date" value={f.depositedOn} max={today} onChange={(e) => setF({ ...f, depositedOn: e.target.value })} /></label>
        <label className="field"><span>Cash up to and including</span><input type="date" value={f.coversTo} min={from} max={f.depositedOn} onChange={(e) => setF({ ...f, coversTo: e.target.value })} /></label>
        <label className="field"><span>Amount deposited (₹)</span><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="as on the slip" /></label>
        <label className="field"><span>Slip number</span><input value={f.slipNo} maxLength={40} onChange={(e) => setF({ ...f, slipNo: e.target.value })} /></label>
        <label className="field wide"><span>Note (optional)</span><input value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      </div>
      <div className="small muted">This deposit covers the cash of {range(from, f.coversTo >= from ? f.coversTo : from)}{f.coversTo < from ? <b className="bad-text"> (cash up to {niceDate(addDays(from, -1))} is in an earlier deposit)</b> : null}.</div>
      {save.error && <ErrorNotice error={save.error} />}
      {!checking
        ? <div className="row"><span className="grow" /><button className="btn-primary" disabled={!ok} onClick={() => setChecking(true)}>Record deposit</button></div>
        : <div className="notice row" style={{ alignItems: "center" }}>
            <span className="grow">Record <b>{rupees(amount)}</b> deposited on <b>{niceDate(f.depositedOn)}</b> for the cash of <b>{range(from, f.coversTo)}</b>{f.slipNo ? `, slip ${f.slipNo}` : ""}?</span>
            <button onClick={() => setChecking(false)}>Change</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Yes, record it"}</button>
          </div>}
    </section>
  );
}

function DeskList({ d }: { d: CashResponse }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Deposits</h2><span className="small muted">Newest first</span></div>
      {!d.desk.deposits.length ? <div className="empty">No deposit recorded yet.</div> : (
        <div className="table-wrap"><table className="list compact">
          <thead><tr><th>Deposited</th><th>Cash of</th><th className="right">Amount</th><th>Slip</th><th>Recorded by</th><th>Bank</th></tr></thead>
          <tbody>{d.desk.deposits.map((x) => (
            <tr key={x.id} className={`edge-${BANK_EDGE[x.bank]}`}><td className="nowrap">#{x.id} · {dayLabel(x.depositedOn)}</td><td className="small">{range(x.coversFrom, x.coversTo)}</td>
              <td className="right fig">{rupees(x.amount)}</td><td>{x.slipNo ?? ""}</td><td className="small">{x.recordedByName}<div className="muted">{stamp(x.recordedAt)}</div></td>
              <td><span className={`recon-status ${BANK_EDGE[x.bank]}`}>{x.bankWords}</span></td></tr>))}</tbody>
        </table></div>)}
      {!!d.desk.voided.length && <p className="small muted panel-pad">Cancelled by the admin: {d.desk.voided.map((v) => `#${v.id} (${rupees(v.amount)}, ${niceDate(v.depositedOn)}): ${v.voidReason}`).join("; ")}</p>}
    </section>
  );
}

function FullBook({ d }: { d: CashResponse }) {
  const b = d.book!;
  const { can } = useAuth();
  const [voiding, setVoiding] = useState<number | null>(null);
  const [showDays, setShowDays] = useState(false);
  return (<>
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Deposits, checked</h2>
        <span className="small muted">Yarago cash of the days + carried in − deposited = carried forward; up to ±{rupees(b.limits.carryBand)} is rounding</span></div>
      {!b.deposits.length ? <div className="empty">No deposit since the cash book started ({niceDate(b.start)}).</div> : (
        <div className="table-wrap"><table className="list compact">
          <thead><tr><th>Deposit</th><th>Cash of</th><th className="right">Yarago cash</th><th className="right">Carried in</th><th className="right">Deposited</th>
            <th className="right">Carried forward</th><th>Check</th><th>Bank</th><th /></tr></thead>
          <tbody>{[...b.deposits].reverse().map((x) => (
            <tr key={x.id} className={`edge-${x.check !== "ok" ? "bad" : BANK_EDGE[x.bank]}`}>
              <td className="nowrap">#{x.id} · {dayLabel(x.depositedOn)}<div className="small muted">{x.recordedByName}{x.slipNo ? `, slip ${x.slipNo}` : ""}</div></td>
              <td className="small">{range(x.coversFrom, x.coversTo)}</td>
              <td className="right fig">{rupees(x.yaragoCash)}</td><td className="right fig">{x.carryIn ? r0(x.carryIn) : ""}</td>
              <td className="right fig"><b>{rupees(x.amount)}</b></td><td className="right fig">{r0(x.carryOut)}</td>
              <td><span className={`recon-status ${CHECK_EDGE[x.check]}`}>{x.check === "ok" ? "OK" : x.check === "short" ? "Short" : "Excess"}</span><div className="small muted">{x.checkWords}</div></td>
              <td><span className={`recon-status ${BANK_EDGE[x.bank]}`}>{x.bank === "found" ? "In the bank" : x.bank === "not_found" ? "Not found" : x.bank === "uncertain" ? "Uncertain" : "Not known yet"}</span>
                <div className="small muted">{x.bankWords}</div></td>
              <td className="right">{can("adjustments.approve") && <button className="btn-small" onClick={() => setVoiding(x.id)}>Void</button>}</td>
            </tr>))}</tbody>
        </table></div>)}
      {voiding && <VoidForm id={voiding} onDone={() => setVoiding(null)} />}
    </section>

    {!!b.unrecorded.length && (
      <section className="panel">
        <div className="panel-head"><h2 className="grow">Cash deposits in the bank not recorded here</h2><span className="small muted">Ask the cash desk to record them (or the admin to correct a wrong amount)</span></div>
        <table className="list compact"><tbody>{b.unrecorded.map((u) => <tr key={u.transactionId} className="edge-warn"><td className="nowrap">{dayLabel(u.date)}</td>
          <td className="right fig">{rupees(u.amount)}</td><td className="small">{u.description}<div className="muted">Zoho {u.transactionId}</div></td></tr>)}</tbody></table>
      </section>)}

    <section className="panel">
      <div className="panel-head"><h2 className="grow">Cash by day</h2><span className="small muted">Yarago cash: collected − refunds ± approved adjustments</span>
        <button className="btn-small" onClick={() => setShowDays(!showDays)}>{showDays ? "Hide" : `Show ${b.days.length} days`}</button></div>
      {showDays && <div className="table-wrap"><table className="list compact">
        <thead><tr><th>Day</th><th className="right">Cash</th><th>Status</th></tr></thead>
        <tbody>{[...b.days].reverse().map((x) => <tr key={x.date} className={x.depositId ? "edge-ok" : "edge-cash"}><td className="nowrap">{dayLabel(x.date)}</td><td className="right fig">{r0(x.net)}</td>
          <td>{x.depositId ? <span className="recon-status ok">In deposit #{x.depositId}</span> : <span className="recon-status cash">Not yet deposited</span>}</td></tr>)}</tbody>
      </table></div>}
      {!!b.voided.length && <p className="small muted panel-pad">Voided: {b.voided.map((v) => `#${v.id} (${rupees(v.amount)}, ${niceDate(v.depositedOn)}) by ${v.voidedByName}: ${v.voidReason}`).join("; ")}</p>}
      {!!b.beforeStart.length && <p className="small muted panel-pad">{b.beforeStart.length} deposit(s) for days before the cash book's start are not checked.</p>}
    </section>
  </>);
}

function VoidForm({ id, onDone }: { id: number; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api(`/cash/deposits/${id}/void`, { body: { reason: reason.trim() } }),
    onSuccess: () => { toast(`Deposit #${id} voided`); void qc.invalidateQueries({ queryKey: ["cash"] }); void qc.invalidateQueries({ queryKey: ["recon"] }); onDone(); },
  });
  return (
    <div className="panel-pad stack">
      <label className="field wide"><span>Why is deposit #{id} wrong? (kept in the record; the cash desk then records it again)</span>
        <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
      {m.error && <ErrorNotice error={m.error} />}
      <div className="row"><span className="grow" /><button onClick={onDone}>Cancel</button>
        <button className="btn-danger" disabled={reason.trim().length < 5 || m.isPending} onClick={() => m.mutate()}>Void deposit #{id}</button></div>
    </div>
  );
}

function Settings({ d }: { d: CashResponse }) {
  const s = d.settings!;
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ start: s.start, opening: String(s.opening), bankFrom: s.bankFrom, warnAt: String(s.limits.warnAt), limit: String(s.limits.limit), carryBand: String(s.limits.carryBand) });
  const m = useMutation({
    mutationFn: () => api("/cash/settings", { method: "PUT", body: { start: f.start, opening: Number(f.opening), bankFrom: f.bankFrom, warnAt: Number(f.warnAt), limit: Number(f.limit), carryBand: Number(f.carryBand) } }),
    onSuccess: () => { toast("Cash book settings saved"); setOpen(false); void qc.invalidateQueries({ queryKey: ["cash"] }); void qc.invalidateQueries({ queryKey: ["recon"] }); },
  });
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Cash book settings</h2>
        <span className="small muted">Starts with the cash of {niceDate(s.start)} ({rupees(s.opening)} in hand before it); limit {rupees(s.limits.limit)}</span>
        <button className="btn-small" onClick={() => setOpen(!open)}>{open ? "Close" : "Change"}</button></div>
      {open && <div className="panel-pad stack">
        <div className="fields">
          <label className="field"><span>First collection day counted</span><input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
          <label className="field"><span>Cash in hand before it (₹)</span><input inputMode="decimal" value={f.opening} onChange={(e) => setF({ ...f, opening: e.target.value })} /></label>
          <label className="field"><span>Bank deposits counted from</span><input type="date" value={f.bankFrom} onChange={(e) => setF({ ...f, bankFrom: e.target.value })} /></label>
          <label className="field"><span>Amber from (₹)</span><input inputMode="numeric" value={f.warnAt} onChange={(e) => setF({ ...f, warnAt: e.target.value })} /></label>
          <label className="field"><span>Limit (₹)</span><input inputMode="numeric" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></label>
          <label className="field"><span>Rounding allowed (₹)</span><input inputMode="numeric" value={f.carryBand} onChange={(e) => setF({ ...f, carryBand: e.target.value })} /></label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>"Bank deposits counted from" keeps earlier bank deposits (for cash before the book's start, such as 17 Oct for 1–10 Oct) out of "not recorded here".</p>
        {m.error && <ErrorNotice error={m.error} />}
        <div className="row"><span className="grow" /><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Save settings</button></div>
      </div>}
    </section>
  );
}
