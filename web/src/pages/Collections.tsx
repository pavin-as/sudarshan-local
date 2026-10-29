// Day collection (D-057): one day's money as Yarago recorded it. At a glance: the total, clinic and pharmacy, each method,
// what it was for and the hours; every part opens the payments, the lines or the bill behind it. No bank and no matching
// (that is the Reconciliation page). Finance only: it shows the day's cash, which the cash desk must not see (D-053).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type MoneySource, type SourceSplit } from "../api";
import { addDays, dayLabel, niceDate, rupees, stamp, todayIST, weekdayName } from "../format";
import { Drawer, ErrorNotice, Loading } from "../components/ui";
import { METHOD_WORDS } from "./Reconciliation";

type Method = "cash" | "upi" | "card" | "cheque" | "other";
interface Pay { paymentId: string; source: MoneySource; yaragoSource: string; sourceId: string; billNo: string | null; billKey: string | null; patientId: number | null;
                mrd: string | null; name: string | null; method: Method; amount: number; ref: string | null; at: string | null }
interface Ref { refundId: string; source: MoneySource; billNo: string | null; patientId: number | null; mrd: string | null; name: string | null; method: string;
                amount: number; dateUncertain: boolean; reason: string | null; at: string | null }
interface Line { lineId: string; source: MoneySource; sourceId: string; billNo: string | null; patientId: number | null; mrd: string | null; name: string | null;
                 serviceGroup: string; item: string | null; amount: number }
interface Bill { billKey: string; billNo: string | null; patientId: number | null; mrd: string | null; name: string | null; at: string | null; total: number; discount: number; due: number }
interface Summary {
  date: string;
  totals: { collected: number; collectedBy: SourceSplit; refunds: number; refundsBy: SourceSplit; net: number; billed: number; billedBy: SourceSplit;
            patients: number; bills: number; payments: number; firstAt: string | null; lastAt: string | null; discount: number; due: number };
  byMethod: { method: Method; amount: number; count: number; by: SourceSplit }[];
  byService: { source: MoneySource; group: string; amount: number; lines: number; items: { item: string; amount: number; lines: number }[] }[];
  byHour: { hour: number; amount: number; count: number; by: SourceSplit }[];
  billedVsCollected: { source: MoneySource; billed: number; collected: number; gap: number; notItemised: number }[];
  payments: Pay[]; refunds: Ref[]; lines: Line[]; discounts: Bill[]; dues: Bill[]; notItemised: Bill[]; untimed: number;
  lastWeek: { date: string; collected: number; byThisTime: boolean } | null;
}
interface Filter { method?: Method; source?: MoneySource; hour?: number }

const SRC: Record<MoneySource, string> = { clinic: "Clinic", pharmacy: "Pharmacy & optical" };
const r0 = (n: number) => (n < 0 ? `−${rupees(-n)}` : rupees(n));
const hhmm = (at: string | null) => (at ? at.slice(11, 16) : "");
const hourWords = (h: number) => `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
const sumOf = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

export function CollectionsPage() {
  const today = todayIST();
  const [date, setDate] = useState(today);
  const [filter, setFilter] = useState<Filter>({});
  const [search, setSearch] = useState("");
  const [bill, setBill] = useState<{ source: MoneySource; key: string } | null>(null);
  const [item, setItem] = useState<{ source: MoneySource; group: string; item?: string } | null>(null);
  const q = useQuery({ queryKey: ["collections", date], refetchInterval: date === today ? 60_000 : false,
                       queryFn: () => api<{ summary: Summary; today: string; yaragoSyncedAt: string | null }>(`/collections/day?date=${date}`) });
  const s = q.data?.summary, t = s?.totals;
  const pick = (f: Filter) => { setFilter(f); setSearch(""); document.getElementById("day-payments")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const go = (d: string) => { setDate(d); setFilter({}); setSearch(""); };

  return (
    <div className="stack collect-page" style={{ gap: "1rem" }}>
      <div className="page-head no-print">
        <div><h1>Day collection</h1><div className="muted">What Yarago recorded as taken, how and for what. No bank and no matching here: that is the <Link to="/reconciliation">Reconciliation</Link>.</div></div>
        <span className="grow" />
        <button onClick={() => go(addDays(date, -1))} aria-label="Day before">‹</button>
        <label className="field"><span>Day</span><input type="date" value={date} max={today} onChange={(e) => e.target.value && go(e.target.value)} /></label>
        <button onClick={() => go(addDays(date, 1))} disabled={date >= today} aria-label="Day after">›</button>
        {date !== today && <button onClick={() => go(today)}>Today</button>}
        <button className="btn-primary" disabled={!s} onClick={() => { setFilter({}); setSearch(""); setTimeout(() => window.print(), 100); }}>Print day sheet</button>
      </div>
      <div className="print-only"><h1>Day collection, {weekdayName(date, true)} {niceDate(date, true)}</h1></div>

      {q.error && <ErrorNotice error={q.error} />}
      {!s || !t ? (q.isLoading ? <Loading /> : null) : (<>
        <div className="small muted">
          {date === today ? "Today so far" : dayLabel(date)}: Yarago copied {q.data!.yaragoSyncedAt ? stamp(q.data!.yaragoSyncedAt) : "unknown"}
          {date === today && ", refreshed every minute"}.
        </div>

        {/* the headline */}
        <section className="panel panel-pad collect-hero">
          <div>
            <div className="collect-hero-n fig">{rupees(t.collected)}</div>
            <div className="collect-hero-l">collected{t.refunds ? <>, {r0(t.net)} after {r0(t.refunds)} refunded</> : null}</div>
            <div className="small muted">{t.patients} patients · {t.bills} bills · {t.payments} payments{t.firstAt && ` · ${hhmm(t.firstAt)} to ${hhmm(t.lastAt)}`}</div>
            {s.lastWeek && <div className="small muted">{weekdayName(s.lastWeek.date)} {niceDate(s.lastWeek.date)}: {rupees(s.lastWeek.collected)}{s.lastWeek.byThisTime ? " by this time" : ""}</div>}
          </div>
          <div className="collect-sources">
            {(["clinic", "pharmacy"] as const).map((src) => (
              <button key={src} className={`collect-src ${src}`} onClick={() => pick({ source: src })} title={`Open the ${SRC[src].toLowerCase()} payments`}>
                <span className="collect-key" /><span>{SRC[src]}</span><b className="fig">{rupees(t.collectedBy[src])}</b>
                <span className="small muted">{t.collected ? Math.round((t.collectedBy[src] / t.collected) * 100) : 0}%</span>
              </button>))}
          </div>
        </section>

        {!t.payments && !s.lines.length && !s.refunds.length ? <div className="empty">No money recorded in Yarago on this day{date === today ? " yet" : ""}.</div> : (<>
        {/* each method */}
        {!!s.byMethod.length && (
          <div className="recon-tiles">
            {s.byMethod.map((m) => (
              <button key={m.method} className={`recon-tile collect-tile ${filter.method === m.method ? "picked" : ""}`} onClick={() => pick({ method: m.method })}>
                <div className="recon-tile-n fig">{rupees(m.amount)}</div>
                <div className="recon-tile-l">{METHOD_WORDS[m.method]} <span className="small muted">· {m.count} payment{m.count === 1 ? "" : "s"}</span></div>
                <SplitBar by={m.by} />
                <div className="small muted">clinic {rupees(m.by.clinic)} · pharmacy {rupees(m.by.pharmacy)}</div>
              </button>))}
            {!!t.refunds && <button className="recon-tile collect-tile warn" onClick={() => document.getElementById("day-refunds")?.scrollIntoView({ behavior: "smooth" })}>
              <div className="recon-tile-n fig">{r0(t.refunds)}</div><div className="recon-tile-l">Refunded</div>
              <div className="small muted">clinic {rupees(t.refundsBy.clinic)} · pharmacy {rupees(t.refundsBy.pharmacy)}</div></button>}
          </div>)}

        <div className="recon-two">
          <section className="panel">
            <div className="panel-head"><h2 className="grow">What it was for</h2><span className="small muted">Billed that day; open one for its items and patients</span></div>
            <ServiceBars s={s} onPick={setItem} />
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="grow">Through the day</h2><Legend /></div>
            <HourBars s={s} picked={filter.hour} onPick={(h) => pick({ hour: h })} />
          </section>
        </div>

        <Attention s={s} onBill={setBill} />

        <Payments s={s} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} onBill={setBill} />
        </>)}
      </>)}
      {item && s && <LinesDrawer s={s} pick={item} onClose={() => setItem(null)} onBill={(b) => { setItem(null); setBill(b); }} />}
      {bill && <BillDrawer source={bill.source} billKey={bill.key} onClose={() => setBill(null)} />}
    </div>
  );
}

function Legend() {
  return <span className="collect-legend small">{(["clinic", "pharmacy"] as const).map((src) => <span key={src}><i className={`collect-key ${src}`} />{SRC[src]}</span>)}</span>;
}

/** a thin bar split clinic | pharmacy, for a method tile */
function SplitBar({ by }: { by: SourceSplit }) {
  const all = by.clinic + by.pharmacy;
  if (!all) return null;
  return <div className="collect-split" aria-hidden="true">{(["clinic", "pharmacy"] as const).filter((x) => by[x] > 0).map((x) =>
    <i key={x} className={x} style={{ flexGrow: by[x] }} />)}</div>;
}

function ServiceBars({ s, onPick }: { s: Summary; onPick: (p: { source: MoneySource; group: string; item?: string }) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...s.byService.map((g) => g.amount));
  if (!s.byService.length) return <div className="empty">Nothing billed in Yarago on this day.</div>;
  return (
    <div className="collect-bars">
      {(["clinic", "pharmacy"] as const).map((src) => {
        const gs = s.byService.filter((g) => g.source === src);
        return !gs.length ? null : (
          <div key={src} className="stack" style={{ gap: "0.15rem" }}>
            <div className="collect-bars-head"><b>{SRC[src]}</b><span className="fig">{rupees(s.totals.billedBy[src])}</span></div>
            {gs.map((g) => {
              const k = `${src}|${g.group}`;
              return (
                <div key={k}>
                  <button className="collect-bar-row" onClick={() => setOpen(open === k ? null : k)} aria-expanded={open === k}
                          title={`${g.group}: ${rupees(g.amount)}, ${g.lines} line${g.lines === 1 ? "" : "s"}`}>
                    <span className="collect-bar-label">{open === k ? "▾" : "▸"} {g.group}</span>
                    <span className="collect-bar-track"><i className={src} style={{ width: `${(g.amount / max) * 100}%` }} /></span>
                    <span className="fig collect-bar-n">{rupees(g.amount)}</span>
                  </button>
                  {open === k && <table className="list compact collect-items"><tbody>
                    {g.items.map((it) => <tr key={it.item} className="clickable" onClick={() => onPick({ source: src, group: g.group, item: it.item })}>
                      <td>{it.item}</td><td className="small muted">{it.lines} × </td><td className="right fig">{rupees(it.amount)}</td></tr>)}
                    <tr className="clickable" onClick={() => onPick({ source: src, group: g.group })}><td colSpan={3} className="small"><b>All {g.lines} lines, by patient</b></td></tr>
                  </tbody></table>}
                </div>);
            })}
          </div>);
      })}
    </div>
  );
}

function HourBars({ s, picked, onPick }: { s: Summary; picked?: number; onPick: (h: number) => void }) {
  if (!s.byHour.length) return <div className="empty">No payment times recorded.</div>;
  const max = Math.max(1, ...s.byHour.map((h) => h.amount));
  return (
    <div className="panel-pad">
      <div className="collect-hours" role="list">
        {s.byHour.map((h) => (
          <button key={h.hour} role="listitem" className={`collect-hour ${picked === h.hour ? "picked" : ""}`} onClick={() => onPick(h.hour)} disabled={!h.count}
                  title={`${hourWords(h.hour)}: ${rupees(h.amount)} in ${h.count} payment${h.count === 1 ? "" : "s"} (clinic ${rupees(h.by.clinic)}, pharmacy ${rupees(h.by.pharmacy)})`}>
            <span className="collect-hour-col">
              {(["pharmacy", "clinic"] as const).filter((x) => h.by[x] > 0).map((x) => <i key={x} className={x} style={{ height: `${(h.by[x] / max) * 100}%` }} />)}
            </span>
            <span className="collect-hour-l">{h.hour}</span>
          </button>))}
      </div>
      <div className="small muted" style={{ marginTop: "0.4rem" }}>
        Busiest: {(() => { const b = [...s.byHour].sort((a, c) => c.amount - a.amount)[0]; return `${hourWords(b.hour)}, ${rupees(b.amount)}`; })()}.
        {s.untimed ? ` ${s.untimed} payment(s) have no time in Yarago and are not in the hours.` : ""} Open an hour for its payments.
      </div>
    </div>
  );
}

function Attention({ s, onBill }: { s: Summary; onBill: (b: { source: MoneySource; key: string }) => void }) {
  const gaps = s.billedVsCollected.filter((x) => Math.abs(x.gap) >= 1);
  if (!s.refunds.length && !s.discounts.length && !s.dues.length && !gaps.length && !s.notItemised.length) return null;
  const who = (x: { name: string | null; mrd: string | null; patientId: number | null }) =>
    x.patientId ? <Link to={`/patients/${x.patientId}`} onClick={(e) => e.stopPropagation()}>{x.name ?? "Patient"}</Link> : "-";
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Worth a look</h2><span className="small muted">Refunds, discounts, money still due, billed against collected, bills without items</span></div>
      <div className="collect-attn">
        {!!s.refunds.length && <div id="day-refunds"><h3>Refunded <span className="fig">{rupees(s.totals.refunds)}</span></h3>
          <table className="list compact"><tbody>{s.refunds.map((r) => <tr key={r.refundId}><td className="nowrap">{hhmm(r.at)}</td><td>{who(r)} <span className="small muted">{r.mrd ?? ""}</span></td>
            <td className="small">{SRC[r.source]}{r.billNo ? `, bill ${r.billNo}` : ""}<div className="muted">{r.method === "unrecorded" ? "method not recorded" : METHOD_WORDS[r.method]}{r.reason ? ` · ${r.reason}` : ""}</div></td>
            <td className="right fig">{rupees(r.amount)}</td></tr>)}</tbody></table></div>}
        {!!s.discounts.length && <div><h3>Discounts on clinic bills <span className="fig">{rupees(s.totals.discount)}</span></h3>
          <table className="list compact"><tbody>{s.discounts.map((b) => <tr key={b.billKey} className="clickable" onClick={() => onBill({ source: "clinic", key: b.billKey })}>
            <td>{who(b)} <span className="small muted">{b.mrd ?? ""}</span></td><td className="small">bill {b.billNo}</td><td className="right fig">{rupees(b.discount)}</td></tr>)}</tbody></table></div>}
        {!!s.dues.length && <div><h3>Left due on clinic bills <span className="fig">{rupees(s.totals.due)}</span></h3>
          <table className="list compact"><tbody>{s.dues.map((b) => <tr key={b.billKey} className="clickable" onClick={() => onBill({ source: "clinic", key: b.billKey })}>
            <td>{who(b)} <span className="small muted">{b.mrd ?? ""}</span></td><td className="small">bill {b.billNo}</td><td className="right fig">{rupees(b.due)}</td></tr>)}</tbody></table></div>}
        {!!gaps.length && <div><h3>Billed against collected</h3>
          <table className="list compact"><thead><tr><th /><th className="right">Billed</th><th className="right">Collected</th><th className="right">Gap</th></tr></thead>
            <tbody>{gaps.map((x) => <tr key={x.source}><td>{SRC[x.source]}</td><td className="right fig">{rupees(x.billed)}</td><td className="right fig">{rupees(x.collected)}</td><td className="right fig">{r0(x.gap)}</td></tr>)}</tbody></table>
          <p className="small muted">A gap is a discount, money left due, an advance paid for later (spectacles) or a balance paid for an earlier day.
            {gaps.some((x) => x.notItemised) && <> Bills whose items are not copied yet count as not billed until they are.</>}</p></div>}
        {!!s.notItemised.length && <div><h3>Bills without items yet <span className="fig">{rupees(sumOf(s.notItemised, (b) => b.total))}</span></h3>
          <p className="small muted">{s.notItemised.length} clinic bill{s.notItemised.length === 1 ? "" : "s"} in Yarago with no lines in Sudarshan's copy yet.
            The lines come with the next copy, within a few minutes; until then billed is short by about this much.</p>
          <table className="list compact"><tbody>{s.notItemised.map((b) => <tr key={b.billKey} className="clickable" onClick={() => onBill({ source: "clinic", key: b.billKey })}>
            <td className="nowrap">{hhmm(b.at)}</td><td>{who(b)} <span className="small muted">{b.mrd ?? ""}</span></td><td className="small">bill {b.billNo}</td><td className="right fig">{rupees(b.total)}</td></tr>)}</tbody></table></div>}
      </div>
    </section>
  );
}

function Payments({ s, filter, setFilter, search, setSearch, onBill }: { s: Summary; filter: Filter; setFilter: (f: Filter) => void; search: string; setSearch: (v: string) => void;
                                                                       onBill: (b: { source: MoneySource; key: string }) => void }) {
  const rows = useMemo(() => {
    const w = search.trim().toLowerCase();
    return s.payments.filter((p) => (!filter.method || p.method === filter.method) && (!filter.source || p.source === filter.source)
      && (filter.hour == null || (p.at != null && Number(p.at.slice(11, 13)) === filter.hour))
      && (!w || [p.name, p.mrd, p.billNo, p.ref].some((v) => v?.toLowerCase().includes(w))));
  }, [s.payments, filter, search]);
  const chips = [filter.method && METHOD_WORDS[filter.method], filter.source && SRC[filter.source], filter.hour != null && hourWords(filter.hour)].filter(Boolean);
  const by = (src: MoneySource) => sumOf(rows.filter((p) => p.source === src), (p) => p.amount);
  return (
    <section className="panel" id="day-payments">
      <div className="panel-head">
        <h2 className="grow">Payments{chips.length ? `: ${chips.join(", ")}` : ""}</h2>
        {!!chips.length && <button className="btn-small no-print" onClick={() => setFilter({})}>Show all</button>}
        <input className="no-print" style={{ width: "13rem" }} placeholder="Patient, MRD, bill or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!rows.length ? <div className="empty">No payments{chips.length || search ? " match" : ""}.</div> : (
        <div className="table-wrap"><table className="list compact">
          <thead><tr><th>Time</th><th>Patient</th><th>Bill</th><th>Where</th><th>Method</th><th className="right">Amount</th><th>Reference</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.paymentId} className="clickable" onClick={() => p.billKey && onBill({ source: p.source, key: p.billKey })}>
              <td className="nowrap">{hhmm(p.at)}</td>
              <td>{p.patientId ? <Link to={`/patients/${p.patientId}`} onClick={(e) => e.stopPropagation()}>{p.name ?? "Patient"}</Link> : "-"} <span className="small muted">{p.mrd ?? ""}</span></td>
              <td className="nowrap">{p.billNo ?? "-"}</td>
              <td><i className={`collect-key ${p.source}`} /> <span className="small">{SRC[p.source]}</span></td>
              <td>{METHOD_WORDS[p.method]}</td><td className="right fig">{rupees(p.amount)}</td><td className="small">{p.ref ?? ""}</td>
            </tr>))}</tbody>
          <tfoot>
            {(["clinic", "pharmacy"] as const).filter((src) => by(src)).map((src) =>
              <tr key={src} className="subtotal"><td colSpan={5}>{SRC[src]}</td><td className="right fig">{rupees(by(src))}</td><td /></tr>)}
            <tr className="total"><td colSpan={5}>{rows.length} payment{rows.length === 1 ? "" : "s"}</td><td className="right fig"><b>{rupees(sumOf(rows, (p) => p.amount))}</b></td><td /></tr>
          </tfoot>
        </table></div>)}
    </section>
  );
}

function LinesDrawer({ s, pick, onClose, onBill }: { s: Summary; pick: { source: MoneySource; group: string; item?: string }; onClose: () => void;
                                                     onBill: (b: { source: MoneySource; key: string }) => void }) {
  const lines = s.lines.filter((l) => l.source === pick.source && l.serviceGroup === pick.group && (!pick.item || (l.item?.trim() || "Not named") === pick.item));
  return (
    <Drawer wide title={pick.item ?? pick.group} sub={<>{SRC[pick.source]} · {pick.group} · {lines.length} line{lines.length === 1 ? "" : "s"}, {rupees(sumOf(lines, (l) => l.amount))}</>} onClose={onClose}>
      <table className="list compact">
        <thead><tr><th>Patient</th><th>Bill</th>{!pick.item && <th>Item</th>}<th className="right">Amount</th></tr></thead>
        <tbody>{lines.map((l) => <tr key={l.lineId} className="clickable" onClick={() => onBill({ source: l.source, key: l.sourceId })}>
          <td>{l.patientId ? <Link to={`/patients/${l.patientId}`} onClick={(e) => e.stopPropagation()}>{l.name ?? "Patient"}</Link> : "-"} <span className="small muted">{l.mrd ?? ""}</span></td>
          <td className="nowrap">{l.billNo ?? "-"}</td>{!pick.item && <td className="small">{l.item}</td>}<td className="right fig">{rupees(l.amount)}</td></tr>)}</tbody>
      </table>
      <p className="small muted">Open a line for its whole bill.</p>
    </Drawer>
  );
}

function BillDrawer({ source, billKey, onClose }: { source: MoneySource; billKey: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["collections-bill", source, billKey], queryFn: () => api<{ bill: any }>(`/collections/bill?source=${source}&key=${billKey}`) });
  const b = q.data?.bill;
  const paid = b ? sumOf(b.payments as any[], (p) => Number(p.amount)) : 0;
  return (
    <Drawer wide onClose={onClose} title={b ? `${source === "clinic" ? "Bill" : "Pharmacy order"} ${b.billNo ?? b.key}` : "Bill"}
            sub={b ? <>{b.patientId ? <Link to={`/patients/${b.patientId}`}>{b.name ?? "Patient"}</Link> : "No patient"} {b.mrd ? `· ${b.mrd}` : ""} · {SRC[source]} · {dayLabel(b.onDate)} {hhmm(b.at)}</> : undefined}>
      {q.error && <ErrorNotice error={q.error} />}
      {!b ? <Loading /> : (
        <div className="stack" style={{ gap: "1rem" }}>
          <section><h3>What was billed</h3>
            <table className="list compact">
              <thead><tr><th>Item</th><th className="right">Qty</th><th className="right">Amount</th></tr></thead>
              <tbody>{!b.lines.length && <tr><td colSpan={3} className="small muted">No lines in Sudarshan's copy of Yarago yet: they come with the next copy, within a few minutes.</td></tr>}
                {(b.lines as any[]).map((l, i) => <tr key={i}><td>{l.item ?? l.group}{l.item && (l.kind ?? l.group) !== l.item && <div className="small muted">{l.kind ?? l.group}</div>}</td><td className="right fig">{l.qty || ""}</td><td className="right fig">{rupees(l.amount)}</td></tr>)}</tbody>
              <tfoot>
                {source === "clinic" && <tr className="subtotal"><td colSpan={2}>Bill total in Yarago</td><td className="right fig">{rupees(b.total)}</td></tr>}
                {!!b.discount && <tr><td colSpan={2}>Discount</td><td className="right fig">{r0(-b.discount)}</td></tr>}
                {source === "pharmacy" && <tr className="subtotal"><td colSpan={2}>Order total after cancellations</td><td className="right fig">{rupees(b.total)}</td></tr>}
                {b.due != null && b.due > 0 && <tr><td colSpan={2}><b>Left due</b></td><td className="right fig bad-text">{rupees(b.due)}</td></tr>}
              </tfoot>
            </table></section>
          <section><h3>Paid</h3>
            {!b.payments.length ? <div className="small muted">No payment recorded.</div> : <table className="list compact">
              <thead><tr><th>When</th><th>Method</th><th className="right">Amount</th><th>Reference</th></tr></thead>
              <tbody>{(b.payments as any[]).map((p) => <tr key={p.id}><td className="nowrap">{dayLabel(p.onDate)} {hhmm(p.at)}</td><td>{METHOD_WORDS[p.method]}</td>
                <td className="right fig">{rupees(p.amount)}</td><td className="small">{p.ref ?? ""}</td></tr>)}</tbody>
              <tfoot><tr className="total"><td colSpan={2}>Paid in all</td><td className="right fig"><b>{rupees(paid)}</b></td><td /></tr></tfoot>
            </table>}</section>
          {!!b.refunds.length && <section><h3>Refunded</h3><table className="list compact"><tbody>{(b.refunds as any[]).map((r) =>
            <tr key={r.id}><td className="nowrap">{dayLabel(r.onDate)} {hhmm(r.at)}</td><td>{r.method === "unrecorded" ? "Method not recorded" : METHOD_WORDS[r.method]}{r.reason ? <div className="small muted">{r.reason}</div> : null}</td>
              <td className="right fig">{rupees(r.amount)}</td></tr>)}</tbody></table></section>}
        </div>)}
    </Drawer>
  );
}
