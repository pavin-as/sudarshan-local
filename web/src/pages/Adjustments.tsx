// Reconciliation adjustments (D-052): managers and admins ask, an admin approves or rejects. A request counts in the
// reconciliation only once approved; what it changes is shown in words before it is sent and fixed from then on.
// Approved adjustments are corrected only by a reversal (optionally with a replacement), itself approved.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdjKind, type Adjustment, type AdjStatus } from "../api";
import { addDays, dayLabel, rupees, stamp, todayIST } from "../format";
import { useAuth } from "../auth";
import { Drawer, ErrorNotice, Loading, useToast } from "../components/ui";
import { METHOD_WORDS } from "./Reconciliation";

const KIND_WORDS: Record<AdjKind, string> = {
  refund_method: "Refund by another method", method_correction: "Payment method correction", amount_correction: "Amount correction",
  date_correction: "Date correction", missing_entry: "Payment missing from Yarago", payment_fee: "Payment fee or bank charge",
  bank_credit: "Classify a bank credit", reversal: "Reversal",
};
const KIND_HELP: Record<Exclude<AdjKind, "reversal">, string> = {
  refund_method: "The patient paid one way (for example UPI or card) and the refund went another way (for example cash), or Yarago shows the refund under the wrong method, or not at all. The original payment stays as collected.",
  method_correction: "Yarago shows a payment as one method but the patient paid by another (for example entered as cash, paid by UPI).",
  amount_correction: "Yarago shows the wrong amount on a bill and its payment. Give the amount Yarago shows and the correct amount (0 if the entry should not exist).",
  date_correction: "The payment was entered in Yarago on the wrong day.",
  missing_entry: "Money was received but never entered in Yarago.",
  payment_fee: "A card or UPI fee, or a bank charge, explains why less reached the bank.",
  bank_credit: "A bank credit no rule recognises: say whether it is clinic money (and for which day and method) or not. Unclassified credits are never counted.",
};
const STATUS_WORDS: Record<AdjStatus, string> = { pending: "Waiting for approval", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn", reversed: "Reversed" };
const CATS = [["consultation", "Consultation"], ["procedure", "Procedure"], ["pharmacy", "Pharmacy"], ["optical", "Optical"]];
const METHODS = ["cash", "upi", "card", "cheque", "other"];
const uuid = () => crypto.randomUUID();

export function AdjStatusPill({ a }: { a: Pick<Adjustment, "status" | "selfApproved"> }) {
  return <span className={`pill adj-${a.status}`}>{STATUS_WORDS[a.status]}{a.selfApproved ? " (self-approved)" : ""}</span>;
}

type View = "new" | "mine" | "review" | "all";
export function AdjustmentsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const view: View = (sp.get("new") ? "new" : (sp.get("view") as View)) || (can("adjustments.approve") ? "review" : "mine");
  const openId = sp.get("open") ? Number(sp.get("open")) : null;
  const go = (v: View) => setSp(v === "new" ? { new: "1" } : { view: v });
  const status = view === "review" ? "pending" : sp.get("view") === "approved" ? "approved" : undefined;
  const list = useQuery({ queryKey: ["adjustments", view, status], enabled: view !== "new",
                          queryFn: () => api<{ adjustments: Adjustment[]; pending: number }>(`/adjustments?${view === "mine" ? "mine=true" : ""}${status ? `&status=${status}` : ""}`) });
  const pending = list.data?.pending;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head">
        <div><h1>Adjustments</h1><div className="muted">Corrections the Yarago and bank records do not show. They count in the <Link to="/reconciliation">reconciliation</Link> only once an admin approves them.</div></div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Which adjustments">
          <button aria-pressed={view === "new"} onClick={() => go("new")}>New request</button>
          <button aria-pressed={view === "mine"} onClick={() => go("mine")}>My requests</button>
          {can("adjustments.approve") && <button aria-pressed={view === "review"} onClick={() => go("review")}>To approve{pending ? ` (${pending})` : ""}</button>}
          <button aria-pressed={view === "all"} onClick={() => go("all")}>All</button>
        </div>
      </div>
      {view === "new" ? <NewRequest key={sp.toString()} initial={{ kind: (sp.get("new") !== "1" ? sp.get("new") : null) as any, date: sp.get("date"), method: sp.get("method"), txn: sp.get("txn") }}
                                    onSent={(id) => setSp({ view: "mine", open: String(id) })} />
        : (<div className="panel">
            {list.error && <ErrorNotice error={list.error} />}
            {list.isLoading ? <Loading /> : !list.data?.adjustments.length ? <div className="empty">{view === "review" ? "Nothing waiting for approval." : "No requests."}</div> : (
              <div className="table-wrap"><table className="list">
                <thead><tr><th>#</th><th>Day</th><th>What</th><th className="right">Amount</th><th>Record</th><th>Asked by</th><th>Status</th></tr></thead>
                <tbody>{list.data.adjustments.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => setSp({ ...Object.fromEntries(sp), open: String(a.id) })}>
                    <td>#{a.id}</td><td className="nowrap">{dayLabel(a.onDate)}</td>
                    <td>{KIND_WORDS[a.kind]}{a.reversesId && <div className="small muted">of #{a.reversesId}</div>}{a.replacesId && <div className="small muted">replaces #{a.replacesId}</div>}</td>
                    <td className="right fig">{rupees(a.amount)}</td>
                    <td className="small">{[a.billNo && `Bill ${a.billNo}`, a.mrd, a.zohoTxnId && `Zoho ${a.zohoTxnId}`].filter(Boolean).join(" · ")}</td>
                    <td className="small">{a.submittedByName}<div className="muted">{stamp(a.submittedAt)}</div></td>
                    <td><AdjStatusPill a={a} /></td>
                  </tr>))}</tbody>
              </table></div>)}
          </div>)}
      {openId && <AdjustmentDrawer id={openId} onClose={() => { const n = Object.fromEntries(sp); delete n.open; setSp(n); }} />}
    </div>
  );
}

// ---------- the request form (also used for a replacement) ----------
interface Form {
  kind: Exclude<AdjKind, "reversal"> | ""; onDate: string; otherDate: string; amount: string; recordedAmount: string; category: string;
  sourceMethod: string; recordedMethod: string; actualMethod: string; bankClass: string;
  yaragoSource: string; yaragoId: string; recordLabel: string; zohoTxnId: string; zohoAmount: number | null; reason: string; refs: string;
}
const emptyForm = (): Form => ({ kind: "", onDate: addDays(todayIST(), -1), otherDate: "", amount: "", recordedAmount: "", category: "", sourceMethod: "",
  recordedMethod: "", actualMethod: "", bankClass: "", yaragoSource: "", yaragoId: "", recordLabel: "", zohoTxnId: "", zohoAmount: null, reason: "", refs: "" });

function toBody(f: Form, requestKey: string) {
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  const s = (v: string) => (v ? v : null);
  return { requestKey, kind: f.kind, onDate: f.onDate, otherDate: s(f.otherDate), amount: f.kind === "bank_credit" && f.zohoAmount != null ? f.zohoAmount : n(f.amount) ?? 0,
           recordedAmount: n(f.recordedAmount), category: s(f.category), sourceMethod: s(f.sourceMethod), recordedMethod: s(f.recordedMethod),
           actualMethod: s(f.actualMethod), bankClass: s(f.bankClass), yaragoSource: s(f.yaragoSource), yaragoId: s(f.yaragoId), zohoTxnId: s(f.zohoTxnId),
           reason: f.reason, refs: s(f.refs) };
}
export function fromAdjustment(a: Adjustment): Form {
  return { ...emptyForm(), kind: a.kind as Form["kind"], onDate: a.onDate, otherDate: a.otherDate ?? "", amount: String(a.amount), recordedAmount: a.recordedAmount == null ? "" : String(a.recordedAmount),
           category: a.category ?? "", sourceMethod: a.sourceMethod ?? "", recordedMethod: a.recordedMethod ?? "", actualMethod: a.actualMethod ?? "", bankClass: a.bankClass ?? "",
           yaragoSource: a.yaragoSource ?? "", yaragoId: a.yaragoId ?? "", recordLabel: a.billNo ? `Bill ${a.billNo}${a.mrd ? ` · ${a.mrd}` : ""}` : a.yaragoId ?? "", zohoTxnId: a.zohoTxnId ?? "" };
}

function MethodSelect({ value, onChange, label, none }: { value: string; onChange: (v: string) => void; label: string; none?: string }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">{none ?? "Choose…"}</option>{METHODS.map((m) => <option key={m} value={m}>{METHOD_WORDS[m]}</option>)}</select></label>;
}

export function RequestForm({ initial, submitLabel, onSubmit, busy }: { initial: Form; submitLabel: string; busy: boolean; onSubmit: (body: any) => void }) {
  const [f, setF] = useState<Form>(initial);
  const [key] = useState(uuid);
  const set = (p: Partial<Form>) => { setF((x) => ({ ...x, ...p })); preview.reset(); };
  const preview = useMutation({ mutationFn: () => api<{ effects: { words: string }[] }>("/adjustments/preview", { body: toBody(f, key) }) });
  const needsRecord = ["refund_method", "method_correction", "amount_correction", "date_correction"].includes(f.kind);
  const needsZoho = f.kind === "bank_credit" || f.kind === "payment_fee";
  return (
    <div className="stack" style={{ gap: "0.9rem" }}>
      <label className="field"><span>What happened</span>
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value as Form["kind"] })}>
          <option value="">Choose…</option>{(Object.keys(KIND_HELP) as (keyof typeof KIND_HELP)[]).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
        </select></label>
      {f.kind && <div className="small muted">{KIND_HELP[f.kind]}</div>}
      {f.kind && (<>
        <div className="fields">
          <label className="field"><span>{f.kind === "date_correction" ? "Day entered in Yarago" : f.kind === "bank_credit" ? "Business day the money is for" : "Business day"}</span>
            <input type="date" value={f.onDate} max={todayIST()} onChange={(e) => set({ onDate: e.target.value })} /></label>
          {f.kind === "date_correction" && <label className="field"><span>Day actually received</span><input type="date" value={f.otherDate} max={todayIST()} onChange={(e) => set({ otherDate: e.target.value })} /></label>}
        </div>
        {needsRecord && <RecordPicker f={f} set={set} />}
        {f.kind === "missing_entry" && <RecordPicker f={f} set={set} optional />}
        {needsZoho && <ZohoPicker f={f} set={set} credit={f.kind === "bank_credit"} optional={f.kind === "payment_fee"} />}
        <div className="fields">
          {f.kind === "refund_method" && (<>
            <MethodSelect label="Patient originally paid by" value={f.sourceMethod} onChange={(v) => set({ sourceMethod: v })} />
            <MethodSelect label="Yarago shows the refund as" none="Refund not in Yarago" value={f.recordedMethod} onChange={(v) => set({ recordedMethod: v })} />
            <MethodSelect label="Refund actually paid by" value={f.actualMethod} onChange={(v) => set({ actualMethod: v })} />
          </>)}
          {f.kind === "method_correction" && (<>
            <MethodSelect label="Yarago shows" value={f.recordedMethod} onChange={(v) => set({ recordedMethod: v })} />
            <MethodSelect label="Actually paid by" value={f.actualMethod} onChange={(v) => set({ actualMethod: v })} />
          </>)}
          {["amount_correction", "date_correction", "missing_entry", "payment_fee"].includes(f.kind) &&
            <MethodSelect label={f.kind === "payment_fee" ? "Fee charged on" : "Paid by"} value={f.actualMethod} onChange={(v) => set({ actualMethod: v })} />}
          {f.kind === "bank_credit" && <label className="field"><span>This credit is</span><select value={f.bankClass} onChange={(e) => set({ bankClass: e.target.value })}>
            <option value="">Choose…</option><option value="clinic">Clinic money</option><option value="not_clinic">Not clinic money</option></select></label>}
          {f.kind === "bank_credit" && f.bankClass === "clinic" && <MethodSelect label="Payment method" value={f.actualMethod} onChange={(v) => set({ actualMethod: v })} />}
          {(f.kind === "amount_correction" || f.kind === "missing_entry" || f.kind === "date_correction" || (f.kind === "refund_method" && !f.recordedMethod)) &&
            <label className="field"><span>Category{f.kind === "date_correction" ? " (optional)" : ""}</span><select value={f.category} onChange={(e) => set({ category: e.target.value })}>
              <option value="">Choose…</option>{CATS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
          {f.kind === "amount_correction" && <label className="field"><span>Amount in Yarago (₹)</span><input inputMode="decimal" value={f.recordedAmount} onChange={(e) => set({ recordedAmount: e.target.value })} /></label>}
          {f.kind !== "bank_credit" && <label className="field"><span>{f.kind === "amount_correction" ? "Correct amount (₹)" : "Amount (₹)"}</span>
            <input inputMode="decimal" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></label>}
          {f.kind === "bank_credit" && f.zohoAmount != null && <div className="field"><span><b>Amount</b></span>{rupees(f.zohoAmount)} (the whole bank line)</div>}
        </div>
        <label className="field"><span>Explanation (required)</span><textarea rows={3} maxLength={1000} value={f.reason} onChange={(e) => set({ reason: e.target.value })}
          placeholder="What happened and how you know: who paid, how the refund was given, what the bank statement shows" /></label>
        <label className="field"><span>References (optional)</span><input maxLength={500} value={f.refs} onChange={(e) => set({ refs: e.target.value })}
          placeholder="Receipt number, UPI reference, voucher number. Sudarshan does not store attachments." /></label>
        {preview.error && <ErrorNotice error={preview.error} />}
        {preview.data && <div className="notice ok"><b>When approved, this changes:</b><ul>{preview.data.effects.map((e, i) => <li key={i}>{e.words}</li>)}</ul>
          <div className="small">Nothing changes until an admin approves it. Yarago and Zoho records are not touched.</div></div>}
        <div className="row"><span className="grow" />
          <button onClick={() => preview.mutate()} disabled={preview.isPending}>Check what this changes</button>
          <button className="btn-primary" disabled={!preview.data || busy} onClick={() => onSubmit(toBody(f, key))}>{submitLabel}</button></div>
      </>)}
    </div>
  );
}

function NewRequest({ initial, onSent }: { initial: { kind: Form["kind"] | null; date: string | null; method: string | null; txn: string | null }; onSent: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: (body: any) => api<{ adjustment: Adjustment; again: boolean }>("/adjustments", { body }),
    onSuccess: (r) => { toast(r.again ? `Request #${r.adjustment.id} was already sent` : `Request #${r.adjustment.id} sent for approval`);
                        void qc.invalidateQueries({ queryKey: ["adjustments"] }); onSent(r.adjustment.id); },
  });
  const start = useMemo(() => ({ ...emptyForm(), kind: initial.kind ?? "", onDate: initial.date ?? emptyForm().onDate, zohoTxnId: initial.txn ?? "",
                                  actualMethod: initial.method ?? "", sourceMethod: initial.method ?? "" }), [initial.kind, initial.date, initial.txn, initial.method]);
  return (
    <div className="panel panel-pad stack">
      {send.error && <ErrorNotice error={send.error} />}
      <RequestForm initial={start} submitLabel="Send for approval" busy={send.isPending} onSubmit={(b) => send.mutate(b)} />
    </div>
  );
}

function RecordPicker({ f, set, optional }: { f: Form; set: (p: Partial<Form>) => void; optional?: boolean }) {
  const [q, setQ] = useState("");
  const [byDay, setByDay] = useState(true);
  const params = byDay ? `date=${f.onDate}` : `q=${encodeURIComponent(q.trim())}`;
  const r = useQuery({ queryKey: ["recon-search", params], enabled: byDay ? !!f.onDate : q.trim().length >= 2,
                       queryFn: () => api<{ payments: any[]; refunds: any[] }>(`/recon/search?${params}`) });
  const wantRefund = f.kind === "refund_method";
  const rows = [...(wantRefund ? (r.data?.refunds ?? []).map((x) => ({ ...x, isRefund: true })) : []), ...(r.data?.payments ?? [])];
  const pick = (x: any) => set({ yaragoSource: x.source, yaragoId: x.sourceId, recordLabel: `${x.isRefund ? "Refund on bill" : "Bill"} ${x.billNo ?? x.sourceId}${x.mrd ? ` · ${x.mrd}` : ""}`,
                                 onDate: f.kind === "date_correction" || !x.onDate ? f.onDate : x.onDate,
                                 ...(x.isRefund && x.methods.length === 1 ? { recordedMethod: x.methods[0].method } : {}) });
  return (
    <fieldset className="recon-pick"><legend>Yarago record{optional ? " (if there is one)" : ""}: {f.yaragoId ? <b>{f.recordLabel}</b> : <span className="muted">none chosen</span>}
      {f.yaragoId && <button className="btn-quiet btn-small" onClick={() => set({ yaragoSource: "", yaragoId: "", recordLabel: "" })}>Clear</button>}</legend>
      <div className="row">
        <div className="seg" role="group"><button aria-pressed={byDay} onClick={() => setByDay(true)}>That day's records</button><button aria-pressed={!byDay} onClick={() => setByDay(false)}>Find by bill or MRD</button></div>
        {!byDay && <input placeholder="Bill number or MRD" value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      {r.error && <ErrorNotice error={r.error} />}
      {!!rows.length && <div className="recon-pick-list"><table className="list compact"><tbody>{rows.map((x) => (
        <tr key={`${x.source}-${x.sourceId}`} className={`clickable ${f.yaragoSource === x.source && f.yaragoId === x.sourceId ? "picked" : ""}`} onClick={() => pick(x)}>
          <td className="nowrap">{dayLabel(x.onDate)}</td><td>{x.isRefund ? <b>Refund</b> : x.source === "clinic_bill" ? "Clinic bill" : "Pharmacy"} {x.billNo ?? ""}</td>
          <td className="small">{x.name ?? ""} <span className="muted">{x.mrd ?? ""}</span></td>
          <td className="small">{x.methods.map((m: any) => `${METHOD_WORDS[m.method]} ${rupees(Number(m.amount))}`).join(", ")}</td></tr>))}</tbody></table></div>}
      {r.data && !rows.length && <div className="small muted">No {wantRefund ? "refunds or payments" : "payments"} found.</div>}
    </fieldset>
  );
}

function ZohoPicker({ f, set, credit, optional }: { f: Form; set: (p: Partial<Form>) => void; credit: boolean; optional?: boolean }) {
  const from = addDays(f.onDate, -3), to = addDays(f.onDate, 7) > todayIST() ? todayIST() : addDays(f.onDate, 7);
  const r = useQuery({ queryKey: ["zoho-lines", from, to], queryFn: () => api<{ lines: any[] }>(`/recon/zoho-lines?from=${from}&to=${to}`) });
  const lines = (r.data?.lines ?? []).filter((l) => (credit ? l.side === "credit" : l.side === "debit") || l.id === f.zohoTxnId);
  const chosen = r.data?.lines.find((l) => l.id === f.zohoTxnId);
  // a line chosen elsewhere (the Classify link) brings its amount once the copy is loaded
  useEffect(() => { if (chosen && credit && f.zohoAmount !== Number(chosen.amount)) set({ zohoAmount: Number(chosen.amount) }); }, [chosen?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <fieldset className="recon-pick"><legend>Zoho bank line{optional ? " (if there is one)" : ""}: {chosen ? <b>{dayLabel(chosen.date)} {rupees(Number(chosen.amount))}</b> : f.zohoTxnId ? <b>Zoho {f.zohoTxnId}</b> : <span className="muted">none chosen</span>}</legend>
      {r.error && <ErrorNotice error={r.error} />}
      {!lines.length ? <div className="small muted">No {credit ? "credits" : "debits"} in Sudarshan's copy of Zoho from {dayLabel(from)} to {dayLabel(to)}. Fetch from Zoho on the Reconciliation page first.</div> : (
        <div className="recon-pick-list"><table className="list compact"><tbody>{lines.map((l) => (
          <tr key={l.id} className={`clickable ${l.id === f.zohoTxnId ? "picked" : ""}`} onClick={() => set({ zohoTxnId: l.id, zohoAmount: Number(l.amount), ...(credit ? {} : { amount: String(l.amount) }) })}>
            <td className="nowrap">{dayLabel(l.date)}</td><td className="right fig">{rupees(Number(l.amount))}</td><td className="small">{l.description}<div className="muted">Zoho {l.id}</div></td></tr>))}</tbody></table></div>)}
    </fieldset>
  );
}

// ---------- one request: details, trail, and what the viewer may do with it ----------
function AdjustmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { can, user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["adjustment", id], queryFn: () => api<{ adjustment: Adjustment; linked: { id: number; kind: AdjKind; status: AdjStatus }[]; trail: any[] }>(`/adjustments/${id}`) });
  const [mode, setMode] = useState<"" | "approve" | "reject" | "reverse">("");
  const [text, setText] = useState("");
  const [withReplacement, setWithReplacement] = useState(false);
  const [revKey] = useState(uuid);
  const done = (msg: string) => { toast(msg); setMode(""); setText(""); void qc.invalidateQueries({ queryKey: ["adjustments"] }); void qc.invalidateQueries({ queryKey: ["adjustment"] }); void qc.invalidateQueries({ queryKey: ["recon"] }); };
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: any }) => api<any>(`/adjustments/${id}/${path}`, { body }) });
  const a = q.data?.adjustment;
  const mine = a?.submittedBy === user?.id;
  const run = (path: string, body: any, msg: string) => act.mutate({ path, body }, { onSuccess: () => done(msg) });
  return (
    <Drawer wide title={a ? `#${a.id} ${KIND_WORDS[a.kind]}` : `#${id}`} onClose={onClose} sub={a ? <AdjStatusPill a={a} /> : undefined}>
      {q.error && <ErrorNotice error={q.error} />}
      {!a ? <Loading /> : (
        <div className="stack" style={{ gap: "1rem" }}>
          <dl className="facts">
            <dt>Business day</dt><dd>{dayLabel(a.onDate)}{a.otherDate ? ` → actually ${dayLabel(a.otherDate)}` : ""}</dd>
            <dt>Amount</dt><dd>{rupees(a.amount)}{a.recordedAmount != null ? ` (Yarago shows ${rupees(a.recordedAmount)})` : ""}</dd>
            {a.sourceMethod && <><dt>Patient paid by</dt><dd>{METHOD_WORDS[a.sourceMethod]}</dd></>}
            {(a.kind === "refund_method" || a.kind === "method_correction") && <><dt>Yarago shows</dt><dd>{a.recordedMethod ? METHOD_WORDS[a.recordedMethod] : "Not in Yarago"}</dd></>}
            {a.actualMethod && <><dt>Actually</dt><dd>{METHOD_WORDS[a.actualMethod]}</dd></>}
            {a.category && <><dt>Category</dt><dd>{a.category}</dd></>}
            {(a.yaragoId || a.billNo) && <><dt>Yarago record</dt><dd>{a.billNo ? `Bill ${a.billNo}` : a.yaragoId} {a.patientId && <Link to={`/patients/${a.patientId}`}>{a.patientName ?? "patient"}</Link>} <span className="muted small">{a.mrd ?? ""}</span></dd></>}
            {a.zohoTxnId && <><dt>Zoho bank line</dt><dd>{a.zohoTxnId}{a.bankClass ? ` · ${a.bankClass === "clinic" ? "clinic money" : "not clinic money"}` : ""}</dd></>}
            <dt>Explanation</dt><dd style={{ whiteSpace: "pre-wrap" }}>{a.reason}</dd>
            {a.refs && <><dt>References</dt><dd>{a.refs}</dd></>}
            <dt>Asked by</dt><dd>{a.submittedByName}, {stamp(a.submittedAt)}</dd>
            {a.reviewedByName && <><dt>{a.status === "rejected" ? "Rejected by" : "Approved by"}</dt><dd>{a.reviewedByName}, {stamp(a.reviewedAt)}{a.selfApproved && <> <span className="tag alert">self-approved</span></>}</dd></>}
            {a.reviewNote && <><dt>Approval note</dt><dd>{a.reviewNote}</dd></>}
            {a.rejectionReason && <><dt>Why rejected</dt><dd>{a.rejectionReason}</dd></>}
          </dl>
          <section><h3>{a.status === "approved" || a.status === "reversed" ? "What it changes in the reconciliation" : "What it would change, once approved"}</h3>
            <ul className="small">{a.effects.map((e, i) => <li key={i}>{e.words}</li>)}</ul>
            {a.status === "reversed" && <div className="small muted">Reversed by #{a.reversedBy}: the reversal's effects cancel these, and both stay in the record.</div>}</section>
          {!!q.data!.linked.length && <section><h3>Linked requests</h3><ul className="small">{q.data!.linked.map((l) =>
            <li key={l.id}><Link to={`/adjustments?open=${l.id}`}>#{l.id}</Link> {KIND_WORDS[l.kind]}: {STATUS_WORDS[l.status]}</li>)}</ul>
            {a.pairedWith && <div className="small muted">This replacement is approved or rejected together with reversal #{a.pairedWith}.</div>}</section>}
          <section><h3>Activity</h3><ul className="small">{q.data!.trail.map((t, i) => <li key={i}>{stamp(t.at)} · {t.who ?? "system"}: {t.summary}</li>)}</ul></section>

          {act.error && <ErrorNotice error={act.error} />}
          {a.status === "pending" && !a.pairedWith && (
            <div className="stack">
              {can("adjustments.approve") && !mode && <div className="row"><span className="grow" />
                <button className="btn-danger" onClick={() => setMode("reject")}>Reject</button>
                <button className="btn-primary" onClick={() => setMode("approve")}>Approve</button></div>}
              {mine && !mode && <div className="row"><span className="grow" /><button onClick={() => run("withdraw", {}, `Request #${id} withdrawn`)}>Withdraw my request</button></div>}
              {mode === "approve" && <div className="stack">
                <label className="field"><span>{mine ? "Approval note (required: you sent this request yourself)" : "Approval note (optional)"}</span>
                  <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
                <div className="row"><span className="grow" /><button onClick={() => setMode("")}>Back</button>
                  <button className="btn-primary" disabled={act.isPending || (mine && text.trim().length < 3)} onClick={() => run("approve", { note: text.trim() || null }, `Request #${id} approved`)}>
                    Yes, approve #{id}{a.kind === "reversal" && a.replacementId ? ` and #${a.replacementId}` : ""}</button></div></div>}
              {mode === "reject" && <div className="stack">
                <label className="field"><span>Why?</span><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
                <div className="row"><span className="grow" /><button onClick={() => setMode("")}>Back</button>
                  <button className="btn-danger" disabled={act.isPending || text.trim().length < 3} onClick={() => run("reject", { reason: text.trim() }, `Request #${id} rejected`)}>Reject #{id}</button></div></div>}
            </div>)}
          {a.status === "approved" && a.kind !== "reversal" && can("adjustments.submit") && (
            !mode ? <div className="row"><span className="grow" /><button onClick={() => setMode("reverse")}>Ask to reverse or correct this</button></div> : mode === "reverse" && (
              <div className="stack panel panel-pad">
                <label className="field"><span>Why is the approved adjustment wrong?</span><textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
                <label className="row small"><input type="checkbox" checked={withReplacement} onChange={(e) => setWithReplacement(e.target.checked)} /> Send a corrected version with the reversal</label>
                {withReplacement
                  ? <RequestForm initial={fromAdjustment(a)} submitLabel="Send reversal and correction for approval" busy={act.isPending}
                                 onSubmit={(rep) => run("reverse", { requestKey: revKey, reason: text, replacement: rep }, `Reversal of #${id} and correction sent for approval`)} />
                  : <div className="row"><span className="grow" /><button onClick={() => setMode("")}>Back</button>
                      <button className="btn-primary" disabled={act.isPending || text.trim().length < 10} onClick={() => run("reverse", { requestKey: revKey, reason: text }, `Reversal of #${id} sent for approval`)}>Send reversal for approval</button></div>}
              </div>))}
        </div>)}
    </Drawer>
  );
}
