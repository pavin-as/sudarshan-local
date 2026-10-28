// The Books audit (D-054): how well Zoho Books is kept, from Sudarshan's read-only copies of Zoho and Yarago's
// collections. Pure: no database, no clock. Basith comes once a week and gets a printed sheet on Friday (Pavin, 28 Oct
// 2026), so work dated up to dueDays before the check is due; newer work is counted as "not due yet" and never makes a
// check amber or red. Each check has a target, a level (green, amber, red; "not measured" when Zoho has not let
// Sudarshan read what it needs) and the items to fix, each in words Basith can act on.
import { addDays } from "../lib/time.js";
import { classify, classifyCharge, rupees, shortDate, splitRepeats, type BankLine, type BankRule } from "./reconcile.js";

export interface AuditSettings { from: string; qualityFrom: string; dueDays: number; bankBehindDays: number; invoiceTolerance: number;
                                 receiptAbove: number; vendorAbove: number; patientsCustomer: string; vagueAccounts: string[] }
export const DEFAULT_AUDIT: AuditSettings = { from: "2026-04-01", qualityFrom: "2026-10-01", dueDays: 7, bankBehindDays: 3, invoiceTolerance: 100,
  receiptAbove: 2000, vendorAbove: 1000, patientsCustomer: "Patients",
  vagueAccounts: ["Uncategorized", "Other Expenses", "Miscellaneous Expenses", "Suspense", "Ask My Accountant"] };

export interface AuditBankLine extends BankLine { type: string | null; offsetAccount: string | null }
export interface AuditInvoice { id: string; number: string | null; date: string; customer: string | null; status: string | null; total: number; balance: number; createdOn: string | null }
export interface AuditExpense { id: string; date: string; account: string | null; paidThrough: string | null; description: string | null;
                                vendor: string | null; total: number; hasAttachment: boolean }
export interface ClinicDay { date: string; collected: number; upiCard: number }   // Yarago: payments less refunds; UPI and card paid
export interface AuditInput {
  today: string; settings: AuditSettings; rules: BankRule[];
  bank: AuditBankLine[];                 // lines dated settings.from..today, as copied (repeats included)
  clinicDays: ClinicDay[];               // settings.from..today
  invoices: AuditInvoice[] | null;       // null: Zoho has not allowed Sudarshan to read invoices
  expenses: AuditExpense[] | null;
}

export type Level = "green" | "amber" | "red" | "not_measured";
export interface AuditItem { date: string; amount: number | null; what: string; todo: string }
export interface AuditCheck { key: string; group: string; title: string; target: string; level: Level; due: number; notDue: number;
                              amount: number; summary: string; items: AuditItem[] }
export interface AuditResult { today: string; dueBefore: string; score: number | null; checks: AuditCheck[]; settings: AuditSettings }

export const GROUPS = ["Bank statement", "Bank lines categorised", "Daily Patients invoice", "Expenses"] as const;
const NEEDS_SCOPE = (what: string) => `Not measured: Zoho has not let Sudarshan read ${what} yet. An administrator runs scripts\\setup-zoho.ps1 again with the scopes it lists.`;
const ITEMS_MAX = 300;
const P = (r: number) => Math.round(Number(r) * 100);
const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + P(x ?? 0), 0) / 100;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

/** green when nothing is due; amber for a few; red beyond. */
function countLevel(due: number, amberUpTo = 3): Level { return due === 0 ? "green" : due <= amberUpTo ? "amber" : "red"; }

function check(key: string, group: string, title: string, target: string, all: AuditItem[], dueBefore: string,
               words: (due: number, amount: number) => string, amberUpTo = 3): AuditCheck {
  const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date));
  const due = sorted.filter((i) => i.date <= dueBefore);
  const amount = sum(due.map((i) => i.amount));
  return { key, group, title, target, level: countLevel(due.length, amberUpTo), due: due.length, notDue: sorted.length - due.length, amount,
           summary: due.length ? words(due.length, amount) : "Nothing due", items: due.slice(0, ITEMS_MAX) };
}
function notMeasured(key: string, group: string, title: string, target: string, what: string): AuditCheck {
  return { key, group, title, target, level: "not_measured", due: 0, notDue: 0, amount: 0, summary: NEEDS_SCOPE(what), items: [] };
}

// A narration that is only the bank's own text, or too short to say what the money was for
const BANK_WORDING = /^(NEFT|RTGS|IMPS|UPI|ME DC|POS |ACH|NACH|ATM|CHQ|CLG|MMT|BIL\/|INF\/|TPT|SERVICE CH|.*\(REF# )/i;
export function weakNarration(d: string | null): boolean {
  const t = (d ?? "").trim();
  return t.length < 8 || BANK_WORDING.test(t);
}

export function booksAudit(inp: AuditInput): AuditResult {
  const s = inp.settings;
  const dueBefore = addDays(inp.today, -s.dueDays);
  const checks: AuditCheck[] = [];
  const { lines, repeats } = splitRepeats(inp.bank.filter((b) => b.date >= s.from && b.date <= inp.today));
  const live = lines.filter((b) => !b.missing);
  const lastLine = live.map((b) => b.date).sort().pop() ?? null;

  // ---------- bank statement ----------
  {
    const behind = lastLine ? daysBetween(lastLine, inp.today) : null;
    const level: Level = behind == null ? "red" : behind <= s.bankBehindDays ? "green" : behind <= Math.max(s.bankBehindDays, 7) ? "amber" : "red";
    const items: AuditItem[] = level === "green" ? [] : [{ date: lastLine ? addDays(lastLine, 1) : inp.today, amount: null,
      what: lastLine ? `Zoho has bank lines only up to ${shortDate(lastLine)}` : "Zoho has no bank lines",
      todo: `Import HDFC's statement from ${lastLine ? shortDate(addDays(lastLine, 1)) : "the start"} (Banking > Import statement) if the automatic feed has not brought it` }];
    checks.push({ key: "bank_current", group: GROUPS[0], title: "Bank lines in Zoho are up to date",
                  target: `The last bank line is at most ${plural(s.bankBehindDays, "day")} old`, level, due: items.length, notDue: 0, amount: 0,
                  summary: behind == null ? "No bank lines" : behind === 0 ? "Up to today" : `Up to ${shortDate(lastLine!)}: ${plural(behind, "day")} behind`, items });
  }
  {
    // UPI and card collected on a clinic day reach the bank the next day, Sundays included (HDFC, Oct 2026): no line at all
    // on either of the next two days means the statement for those days is missing from Zoho
    const dated = new Set(live.map((b) => b.date));
    const items = inp.clinicDays.filter((d) => d.upiCard > 0 && d.date >= s.from && lastLine != null && addDays(d.date, 2) <= lastLine
                                               && !dated.has(addDays(d.date, 1)) && !dated.has(addDays(d.date, 2)))
      .map((d) => ({ date: addDays(d.date, 1), amount: null,
                     what: `No bank line on ${shortDate(addDays(d.date, 1))} or ${shortDate(addDays(d.date, 2))}, although ${shortDate(d.date)} had ${rupees(d.upiCard)} by UPI and card`,
                     todo: "Check these days of HDFC's statement are in Zoho; import them if not" }));
    checks.push(check("bank_gaps", GROUPS[0], "No days missing from the bank statement", "Every settlement day has its bank lines", items, dueBefore,
                      (n) => `${plural(n, "day")} with no bank line`));
  }
  checks.push(check("repeats", GROUPS[0], "No bank line imported twice", "Each bank line is in Zoho once",
    repeats.map(({ kept, copy }) => ({ date: copy.date, amount: copy.amount,
      what: `${copy.debitOrCredit === "credit" ? "Received" : "Paid"} ${rupees(copy.amount)}: "${(copy.description ?? "").replace(/\s+/g, " ").slice(0, 70)}" is in Zoho twice`,
      todo: `Exclude the ${copy.zohoStatus === "uncategorized" ? "uncategorised" : "second"} copy${kept.zohoStatus !== "uncategorized" ? " (the other is categorised already)" : ""}` })),
    dueBefore, (n, a) => `${plural(n, "line")} twice, ${rupees(a)}`, 0));

  // ---------- categorisation ----------
  const uncategorised = live.filter((b) => b.zohoStatus === "uncategorized");
  const inWords = (b: AuditBankLine) => {
    const r = classify(b, inp.rules);
    const prev = shortDate(addDays(b.date, -1));
    if (r?.class === "upi_settlement") return `Customer payment by UPI against the Patients invoice of ${prev} (or the days it settles)`;
    if (r?.class === "card_settlement") return `Customer payment by card against the Patients invoice of ${prev}; the bank kept its fee: book the shortfall as Bank Fees and Charges`;
    if (r?.class === "cash_deposit") return "Transfer from Petty Cash (cash collected, now banked)";
    return "Categorise it: say who paid and what for";
  };
  checks.push(check("uncat_in", GROUPS[1], "Money received is categorised", `Nothing older than ${plural(s.dueDays, "day")} left uncategorised`,
    uncategorised.filter((b) => b.debitOrCredit === "credit").map((b) => ({ date: b.date, amount: b.amount,
      what: `Received ${rupees(b.amount)}: ${(b.description ?? "").replace(/\s+/g, " ").slice(0, 70)}`, todo: inWords(b) })),
    dueBefore, (n, a) => `${plural(n, "line")}, ${rupees(a)}`));
  checks.push(check("uncat_out", GROUPS[1], "Money spent is categorised", `Nothing older than ${plural(s.dueDays, "day")} left uncategorised`,
    uncategorised.filter((b) => b.debitOrCredit === "debit").map((b) => ({ date: b.date, amount: b.amount,
      what: `Paid ${rupees(b.amount)}: ${(b.description ?? "").replace(/\s+/g, " ").slice(0, 70)}`,
      todo: classifyCharge(b, inp.rules) ? "Expense: Bank Fees and Charges (card terminal)" : "Categorise it: expense, vendor payment or transfer, with what it was for and who was paid" })),
    dueBefore, (n, a) => `${plural(n, "line")}, ${rupees(a)}`));
  {
    const items: AuditItem[] = [];
    for (const b of live) {
      if (b.zohoStatus === "uncategorized" || b.debitOrCredit !== "credit") continue;
      const r = classify(b, inp.rules);
      const t = b.type ?? "";
      if ((r?.class === "upi_settlement" || r?.class === "card_settlement") && t !== "customer_payment")
        items.push({ date: b.date, amount: b.amount, what: `${r.class === "upi_settlement" ? "UPI" : "Card"} settlement ${rupees(b.amount)} booked as ${t.replace(/_/g, " ") || "something else"}${b.offsetAccount ? ` (${b.offsetAccount})` : ""}`,
                     todo: "Re-categorise as a customer payment against the Patients invoice" });
      else if (r?.class === "cash_deposit" && t !== "transfer_fund")
        items.push({ date: b.date, amount: b.amount, what: `Cash deposit ${rupees(b.amount)} booked as ${t.replace(/_/g, " ") || "something else"}${b.offsetAccount ? ` (${b.offsetAccount})` : ""}`,
                     todo: "Re-categorise as a transfer from Petty Cash (the cash was already counted as the day's payments)" });
    }
    checks.push(check("wrong_type", GROUPS[1], "Clinic money booked as the right kind", "Settlements are customer payments; cash deposits are transfers from Petty Cash",
                      items, dueBefore, (n, a) => `${plural(n, "line")}, ${rupees(a)}`, 0));
  }

  // ---------- the daily Patients invoice ----------
  if (inp.invoices == null) {
    for (const [k, t, g] of [["invoice_missing", "Every clinic day has its Patients invoice", "One invoice per clinic day, by the next visit"],
                             ["invoice_amount", "Patients invoice matches Yarago", `Within ${rupees(s.invoiceTolerance)} of the day's Yarago collection`],
                             ["invoice_unpaid", "Patients invoices fully paid", "The day's payments recorded; no balance left"],
                             ["invoice_lag", "Invoices entered within the week", `Entered within ${plural(s.dueDays, "day")} of the clinic day, on average`]])
      checks.push(notMeasured(k, GROUPS[2], t, g, "invoices"));
  } else {
    const pts = inp.invoices.filter((i) => (i.customer ?? "").trim().toLowerCase() === s.patientsCustomer.trim().toLowerCase()
                                           && i.status !== "void" && i.date >= s.from && i.date <= inp.today);
    const byDay = new Map<string, AuditInvoice[]>();
    for (const i of pts) byDay.set(i.date, [...(byDay.get(i.date) ?? []), i]);
    const days = new Map(inp.clinicDays.filter((d) => d.date >= s.from).map((d) => [d.date, d]));
    checks.push(check("invoice_missing", GROUPS[2], "Every clinic day has its Patients invoice", "One invoice per clinic day, by the next visit",
      [...days.values()].filter((d) => d.collected > 0 && !byDay.has(d.date)).map((d) => ({ date: d.date, amount: d.collected,
        what: `No Patients invoice for ${shortDate(d.date)}`, todo: `Enter the Patients invoice for ${shortDate(d.date)}: Yarago collected ${rupees(d.collected)} that day` })),
      dueBefore, (n, a) => `${plural(n, "clinic day")}, ${rupees(a)} collected`));
    const amountItems: AuditItem[] = [];
    for (const [date, invs] of byDay) {
      const total = sum(invs.map((i) => i.total));
      const yarago = days.get(date)?.collected ?? 0;
      const diff = Math.round((total - yarago) * 100) / 100;
      if (Math.abs(diff) <= s.invoiceTolerance) continue;
      amountItems.push({ date, amount: Math.abs(diff),
        what: `${invs.map((i) => i.number ?? "Invoice").join(", ")} ${shortDate(date)}: ${rupees(total)} in Zoho, ${rupees(yarago)} collected in Yarago (${diff > 0 ? "more" : "less"} by ${rupees(Math.abs(diff))})`,
        todo: invs.length > 1 ? "Two invoices for one day: keep one, and check it against the day's Yarago collection report" : "Check the invoice against the day's Yarago collection report" });
    }
    checks.push(check("invoice_amount", GROUPS[2], "Patients invoice matches Yarago", `Within ${rupees(s.invoiceTolerance)} of the day's Yarago collection`,
      amountItems, dueBefore, (n, a) => `${plural(n, "day")} differ, ${rupees(a)} in all`));
    checks.push(check("invoice_unpaid", GROUPS[2], "Patients invoices fully paid", "The day's payments recorded; no balance left",
      pts.filter((i) => i.balance > 0).map((i) => ({ date: i.date, amount: i.balance,
        what: `${i.number ?? "Invoice"} ${shortDate(i.date)}: ${rupees(i.balance)} of ${rupees(i.total)} unpaid`,
        todo: i.balance < i.total ? "Record the rest of the day's payments; if only the card fee is left, record it as Bank Fees and Charges" : "Record the day's payments (cash, UPI, card) against it" })),
      dueBefore, (n, a) => `${plural(n, "invoice")}, ${rupees(a)} unpaid`));
    // how late invoices are entered: those for the last four weeks' clinic days
    const recent = pts.filter((i) => i.createdOn && i.date > addDays(inp.today, -35));
    const lags = recent.map((i) => daysBetween(i.date, i.createdOn!));
    const avg = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;
    const lastInv = pts.map((i) => i.date).sort().pop() ?? null;
    // nothing entered lately is off target only when clinic days after the last invoice are due
    const waiting = [...days.values()].some((d) => d.collected > 0 && d.date <= dueBefore && (lastInv == null || d.date > lastInv));
    const level: Level = avg == null ? (waiting ? "red" : "green") : avg <= s.dueDays ? "green" : avg <= 2 * s.dueDays ? "amber" : "red";
    checks.push({ key: "invoice_lag", group: GROUPS[2], title: "Invoices entered within the week", target: `Entered within ${plural(s.dueDays, "day")} of the clinic day, on average`,
                  level, due: 0, notDue: 0, amount: 0, items: [],
                  summary: `${avg == null ? "No invoice entered in the last five weeks" : `${plural(avg, "day")} late on average (${plural(lags.length, "invoice")})`}${lastInv ? `; the last is for ${shortDate(lastInv)}` : ""}` });
  }

  // ---------- expenses (rules from qualityFrom) ----------
  if (inp.expenses == null) {
    for (const [k, t, g] of [["exp_narration", "Expenses say what they were for", "A narration of your own on every expense"],
                             ["exp_vendor", "Expenses name who was paid", `A vendor on every expense from ${rupees(s.vendorAbove)}`],
                             ["exp_receipt", "Expenses have the bill attached", `A receipt on every expense from ${rupees(s.receiptAbove)}`],
                             ["exp_account", "Expenses in a clear account", "Not in a catch-all account"],
                             ["exp_petty", "No expenses paid from Petty Cash", "All clinic cash is banked, so Petty Cash pays nothing"]])
      checks.push(notMeasured(k, GROUPS[3], t, g, "expenses"));
  } else {
    const ex = inp.expenses.filter((e) => e.date >= s.qualityFrom && e.date <= inp.today);
    const name = (e: AuditExpense) => `${rupees(e.total)} ${e.account ?? ""}${e.description ? `: ${e.description.replace(/\s+/g, " ").slice(0, 60)}` : ""}`;
    const vague = new Set(s.vagueAccounts.map((a) => a.trim().toLowerCase()));
    checks.push(check("exp_narration", GROUPS[3], "Expenses say what they were for", "A narration of your own on every expense",
      ex.filter((e) => weakNarration(e.description)).map((e) => ({ date: e.date, amount: e.total, what: name(e),
        todo: "Write what it was for, and for whom: the bank's text is not a narration" })), dueBefore, (n, a) => `${plural(n, "expense")}, ${rupees(a)}`));
    checks.push(check("exp_vendor", GROUPS[3], "Expenses name who was paid", `A vendor on every expense from ${rupees(s.vendorAbove)}`,
      ex.filter((e) => !e.vendor && e.total >= s.vendorAbove).map((e) => ({ date: e.date, amount: e.total, what: name(e), todo: "Choose the vendor (who was paid)" })),
      dueBefore, (n, a) => `${plural(n, "expense")}, ${rupees(a)}`));
    checks.push(check("exp_receipt", GROUPS[3], "Expenses have the bill attached", `A receipt on every expense from ${rupees(s.receiptAbove)}`,
      ex.filter((e) => !e.hasAttachment && e.total >= s.receiptAbove).map((e) => ({ date: e.date, amount: e.total, what: name(e), todo: "Attach the bill or receipt" })),
      dueBefore, (n, a) => `${plural(n, "expense")}, ${rupees(a)}`));
    checks.push(check("exp_account", GROUPS[3], "Expenses in a clear account", "Not in a catch-all account",
      ex.filter((e) => vague.has((e.account ?? "").trim().toLowerCase())).map((e) => ({ date: e.date, amount: e.total, what: name(e),
        todo: "Choose the account that says what it was for" })), dueBefore, (n, a) => `${plural(n, "expense")}, ${rupees(a)}`, 0));
    checks.push(check("exp_petty", GROUPS[3], "No expenses paid from Petty Cash", "All clinic cash is banked, so Petty Cash pays nothing",
      ex.filter((e) => /petty\s*cash/i.test(e.paidThrough ?? "")).map((e) => ({ date: e.date, amount: e.total, what: name(e),
        todo: "Ask who paid it (all clinic cash goes to the bank) and book it as paid by them, not from Petty Cash" })),
      dueBefore, (n, a) => `${plural(n, "expense")}, ${rupees(a)}`, 0));
  }

  const measured = checks.filter((c) => c.level !== "not_measured");
  const points = measured.reduce((p, c) => p + (c.level === "green" ? 2 : c.level === "amber" ? 1 : 0), 0);
  const score = measured.length ? Math.round((points / (2 * measured.length)) * 100) : null;
  return { today: inp.today, dueBefore, score, checks, settings: s };
}
