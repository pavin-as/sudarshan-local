// The Books audit (D-054): how well Zoho Books is kept, from Sudarshan's read-only copy of Zoho. Basith comes once a
// week; Pavin or Dr Sameera prints his sheet every Friday ("Print Basith's sheet": the print-only part below lists what
// is due, with a box to tick). Work dated up to dueDays ago is due; newer work is "not due yet".
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuditCheck, type AuditLevel, type BooksAuditResponse } from "../api";
import { niceDate, rupees, stamp, weekdayName } from "../format";
import { useAuth } from "../auth";
import { ErrorNotice, Loading, useToast } from "../components/ui";

const EDGE: Record<AuditLevel, string> = { green: "ok", amber: "warn", red: "bad", not_measured: "" };
const WORD: Record<AuditLevel, string> = { green: "On target", amber: "Slipping", red: "Off target", not_measured: "Not measured" };
const GROUPS = ["Bank statement", "Bank lines categorised", "Daily Patients invoice", "Expenses"];
const SCOPES = "ZohoBooks.banking.READ,ZohoBooks.customerpayments.READ,ZohoBooks.settings.READ,ZohoBooks.invoices.READ,ZohoBooks.expenses.READ";
const PRINT_MAX = 150;
const scoreEdge = (s: number | null) => (s == null ? "" : s >= 80 ? "ok" : s >= 50 ? "warn" : "bad");

export function BooksAuditPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["books-audit"], queryFn: () => api<BooksAuditResponse>("/books-audit"), refetchInterval: 10 * 60_000 });
  const fetchZoho = useMutation({
    mutationFn: () => api<{ status: string; counts: Record<string, number>; message: string | null }>("/books-audit/fetch", { body: {} }),
    onSuccess: (r) => { toast(r.status === "ok" ? `Zoho read: ${r.counts.lines ?? 0} bank lines` : `Zoho fetch failed: ${r.message}`); void qc.invalidateQueries({ queryKey: ["books-audit"] }); },
  });
  const d = q.data;
  const a = d?.audit;
  return (
    <div className="stack recon-page audit-page" style={{ gap: "1rem" }}>
      <div className="page-head no-print">
        <div><h1>Books audit</h1>
          <div className="muted">How well Zoho Books is kept, from Sudarshan's read-only copy of Zoho. Basith comes once a week: work dated up to {a ? niceDate(a.dueBefore) : "a week ago"} should be done; newer work is not due yet.</div></div>
        <span className="grow" />
        <button onClick={() => fetchZoho.mutate()} disabled={fetchZoho.isPending || !d?.zohoStatus.configured}>{fetchZoho.isPending ? "Reading Zoho…" : "Fetch from Zoho"}</button>
        <button className="btn-primary" onClick={() => window.print()} disabled={!a}>Print Basith's sheet</button>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {fetchZoho.error && <ErrorNotice error={fetchZoho.error} />}
      {!d || !a ? <Loading /> : (<>
        <div className="no-print stack" style={{ gap: "1rem" }}>
          <Summary d={d} />
          {(!a.readable.invoices || !a.readable.expenses) && (
            <div className="notice warn">
              <b>{!a.readable.invoices && !a.readable.expenses ? "Invoices and expenses" : !a.readable.invoices ? "Invoices" : "Expenses"} are not measured yet.</b>{" "}
              Zoho lets Sudarshan read only the bank and customer payments. An administrator runs <code>scripts\setup-zoho.ps1</code> again with the
              scope <code className="link-text">{SCOPES}</code> (all READ: Sudarshan still cannot change anything in Zoho), then presses Fetch from Zoho.
            </div>)}
          {GROUPS.map((g) => <Group key={g} name={g} checks={a.checks.filter((c) => c.group === g)} />)}
          {can("adjustments.approve") && <Settings d={d} />}
        </div>
        <Sheet d={d} />
      </>)}
    </div>
  );
}

function Summary({ d }: { d: BooksAuditResponse }) {
  const a = d.audit;
  const measured = a.checks.filter((c) => c.level !== "not_measured");
  const n = (l: AuditLevel) => measured.filter((c) => c.level === l).length;
  const max = Math.max(100, ...d.trend.map((t) => t.score));
  return (
    <div className="recon-two">
      <section className="panel panel-pad stack" style={{ gap: "0.6rem" }}>
        <div className="recon-tiles">
          <div className={`recon-tile ${scoreEdge(a.score)}`}><div className="recon-tile-n">{a.score ?? "–"}<span className="small muted"> / 100</span></div>
            <div className="recon-tile-l">Books score today</div><div className="small muted">{measured.length} checks measured</div></div>
          <div className="recon-tile ok"><div className="recon-tile-n">{n("green")}</div><div className="recon-tile-l">On target</div></div>
          <div className="recon-tile warn"><div className="recon-tile-n">{n("amber")}</div><div className="recon-tile-l">Slipping</div></div>
          <div className="recon-tile bad"><div className="recon-tile-n">{n("red")}</div><div className="recon-tile-l">Off target</div></div>
        </div>
        <div className="small muted">Score: 2 points for each check on target, 1 for slipping, 0 off target. Zoho last read {d.audit.lastFetch ? stamp(d.audit.lastFetch) : "never"}{d.zohoStatus.feedRefreshedOn ? `; bank lines up to ${niceDate(d.zohoStatus.feedRefreshedOn)}` : ""}.</div>
      </section>
      <section className="panel panel-pad">
        <h2 style={{ marginTop: 0 }}>Each week</h2>
        {d.trend.length === 0 ? <p className="muted">The score is saved after each Zoho read; the weekly trend starts with this week.</p> : (
          <table className="list"><tbody>
            {d.trend.map((t) => (
              <tr key={t.weekEnding} className={`edge-${scoreEdge(t.score)}`}>
                <td className="small">Week to {weekdayName(t.weekEnding)} {niceDate(t.weekEnding)}</td>
                <td style={{ width: "50%" }}><div className="audit-bar"><span style={{ width: `${(t.score / max) * 100}%` }} className={scoreEdge(t.score)} /></div></td>
                <td className="fig"><b>{t.score}</b></td>
                <td className="small muted">{t.checks.filter((c) => c.level === "red").length} off target</td>
              </tr>))}
          </tbody></table>)}
      </section>
    </div>
  );
}

function Group({ name, checks }: { name: string; checks: AuditCheck[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!checks.length) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">{name}</h2></div>
      <div className="table-wrap"><table className="list">
        <thead><tr><th>Check</th><th>Target</th><th>Now</th><th className="num">Due</th><th className="num">Not due yet</th><th /></tr></thead>
        <tbody>
          {checks.map((c) => (
            <Fragment key={c.key}>
              <tr className={EDGE[c.level] ? `edge-${EDGE[c.level]}` : ""}>
                <td><b>{c.title}</b><br /><span className={`recon-status ${EDGE[c.level]}`}>{WORD[c.level]}</span></td>
                <td className="small">{c.target}</td>
                <td className="small">{c.summary}</td>
                <td className="num fig">{c.level === "not_measured" ? "–" : c.due}</td>
                <td className="num fig muted">{c.level === "not_measured" ? "–" : c.notDue}</td>
                <td>{c.items.length > 0 && <button className="btn-small" onClick={() => setOpen(open === c.key ? null : c.key)}>{open === c.key ? "Hide" : "Show"}</button>}</td>
              </tr>
              {open === c.key && <tr><td colSpan={6} style={{ background: "var(--bg)" }}><Items c={c} /></td></tr>}
            </Fragment>))}
        </tbody>
      </table></div>
    </section>
  );
}

function Items({ c }: { c: AuditCheck }) {
  const [all, setAll] = useState(false);
  const shown = all ? c.items : c.items.slice(0, 50);
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <table className="list"><thead><tr><th>Date</th><th className="num">Amount</th><th>What</th><th>To do</th></tr></thead>
        <tbody>{shown.map((i, n) => (
          <tr key={n}><td className="small" style={{ whiteSpace: "nowrap" }}>{niceDate(i.date)}</td><td className="num fig">{i.amount == null ? "" : rupees(i.amount)}</td>
            <td className="small">{i.what}</td><td className="small">{i.todo}</td></tr>))}</tbody></table>
      {!all && c.items.length > 50 && <button className="btn-small" onClick={() => setAll(true)}>Show all {c.items.length}</button>}
      {c.due > c.items.length && <span className="small muted">{c.due - c.items.length} more not listed: the oldest are shown first.</span>}
    </div>
  );
}

/** The printed sheet: only what is due, oldest first, with a box to tick. */
function Sheet({ d }: { d: BooksAuditResponse }) {
  const a = d.audit;
  const due = a.checks.filter((c) => c.due > 0 && c.items.length > 0);
  const notMeasured = a.checks.filter((c) => c.level === "not_measured").length;
  return (
    <div className="print-only audit-sheet">
      <h1>Zoho Books: work for Basith</h1>
      <p>Sheet of {weekdayName(a.today, true)} {niceDate(a.today, true)}. Everything dated up to <b>{niceDate(a.dueBefore, true)}</b> should be done before the next sheet.
        Books score {a.score ?? "–"} / 100{d.trend.length > 1 ? ` (last week ${d.trend[d.trend.length - 2].score})` : ""}.</p>
      <table className="audit-sheet-summary"><tbody>
        {a.checks.filter((c) => c.level !== "not_measured").map((c) => (
          <tr key={c.key}><td>{c.level === "green" ? "✓" : c.level === "amber" ? "!" : "✗"}</td><td>{c.title}</td><td>{c.target}</td><td>{c.summary}</td></tr>))}
      </tbody></table>
      {notMeasured > 0 && <p className="small">{notMeasured} checks (invoices, expenses) are not measured yet.</p>}
      {due.length === 0 ? <p><b>Nothing is due. Thank you.</b></p> : due.map((c) => (
        <section key={c.key} className="audit-sheet-check">
          <h2>{c.title} <span className="small">({c.due} to do{c.amount ? `, ${rupees(c.amount)}` : ""})</span></h2>
          <table><thead><tr><th>Date</th><th>Amount</th><th>What</th><th>To do</th><th>Done</th></tr></thead>
            <tbody>{c.items.slice(0, PRINT_MAX).map((i, n) => (
              <tr key={n}><td>{niceDate(i.date, true)}</td><td className="num">{i.amount == null ? "" : rupees(i.amount)}</td><td>{i.what}</td><td>{i.todo}</td><td className="audit-box" /></tr>))}</tbody></table>
          {c.due > PRINT_MAX && <p className="small">… and {c.due - PRINT_MAX} more (the oldest are above): the full list is on the Books audit page.</p>}
        </section>))}
    </div>
  );
}

function Settings({ d }: { d: BooksAuditResponse }) {
  const s = d.audit.settings;
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>({ from: s.from, qualityFrom: s.qualityFrom, dueDays: String(s.dueDays), bankBehindDays: String(s.bankBehindDays),
    invoiceTolerance: String(s.invoiceTolerance), receiptAbove: String(s.receiptAbove), vendorAbove: String(s.vendorAbove), patientsCustomer: s.patientsCustomer,
    vague: s.vagueAccounts.join("\n") });
  const num = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api("/books-audit/settings", { method: "PUT", body: {
      from: f.from, qualityFrom: f.qualityFrom, dueDays: Number(f.dueDays), bankBehindDays: Number(f.bankBehindDays), invoiceTolerance: Number(f.invoiceTolerance),
      receiptAbove: Number(f.receiptAbove), vendorAbove: Number(f.vendorAbove), patientsCustomer: f.patientsCustomer,
      vagueAccounts: f.vague.split("\n").map((x) => x.trim()).filter(Boolean) } }),
    onSuccess: () => { toast("Books audit settings saved"); setOpen(false); void qc.invalidateQueries({ queryKey: ["books-audit"] }); },
  });
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Targets</h2>
        <span className="small muted">Due after {s.dueDays} days; checked from {niceDate(s.from, true)}, expense rules from {niceDate(s.qualityFrom, true)}</span>
        <button className="btn-small" onClick={() => setOpen(!open)}>{open ? "Close" : "Change"}</button></div>
      {open && <div className="panel-pad stack">
        <div className="fields">
          <label className="field"><span>Bookkeeping checked from</span><input type="date" value={f.from} onChange={num("from")} /></label>
          <label className="field"><span>Expense rules from</span><input type="date" value={f.qualityFrom} onChange={num("qualityFrom")} /></label>
          <label className="field"><span>Work due after (days)</span><input inputMode="numeric" value={f.dueDays} onChange={num("dueDays")} /></label>
          <label className="field"><span>Bank lines at most (days behind)</span><input inputMode="numeric" value={f.bankBehindDays} onChange={num("bankBehindDays")} /></label>
          <label className="field"><span>Invoice may differ from Yarago by (₹)</span><input inputMode="numeric" value={f.invoiceTolerance} onChange={num("invoiceTolerance")} /></label>
          <label className="field"><span>Receipt needed from (₹)</span><input inputMode="numeric" value={f.receiptAbove} onChange={num("receiptAbove")} /></label>
          <label className="field"><span>Vendor needed from (₹)</span><input inputMode="numeric" value={f.vendorAbove} onChange={num("vendorAbove")} /></label>
          <label className="field"><span>Zoho customer of the daily invoice</span><input value={f.patientsCustomer} onChange={num("patientsCustomer")} /></label>
          <label className="field"><span>Accounts too vague for an expense (one a line)</span>
            <textarea rows={5} value={f.vague} onChange={(e) => setF({ ...f, vague: e.target.value })} /></label>
        </div>
        {m.error && <ErrorNotice error={m.error} />}
        <div className="row"><span className="grow" /><button className="btn-primary" disabled={m.isPending} onClick={() => m.mutate()}>Save targets</button></div>
      </div>}
    </section>
  );
}
