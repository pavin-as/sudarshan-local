// Optional reconciliation assistant (D-052): the LOCAL model (Ollama on shichika, setting ai.recon_model) explains the
// result on screen and suggests what to check. It reads the computed result only - no names, MRDs, phone numbers,
// bill numbers, bank descriptions or typed explanations - has no tools, and writes nothing but its own log row. Its
// text is shown only when every number in it is in what it was given, labelled "AI-generated · verify". The figures
// on the page are always reconcile()'s, never the model's.
import { one, withTx } from "../db.js";
import { niceDate } from "../lib/time.js";
import { numbersCheck } from "./summary.js";
import { METHOD_WORDS, shortDate, type ReconResult } from "./reconcile.js";

export const PROMPT_VERSION = "recon-1";
const ollama = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

const SYSTEM = `You help the accounts staff of an eye clinic understand a money reconciliation that has ALREADY been calculated.
It compares what the clinic's records say was collected (cash, UPI, card) with what reached the bank.
Use only the facts given. Do not calculate new totals, do not guess causes as facts, and never say a difference is resolved.
Every number you write must appear in the facts exactly as written there.
Explain in plain English, at most 8 short sentences or bullet points: what the overall position is, which days or methods need
looking at and why (using the status and note given), and what a person could check next (for example the Yarago bills of that
day, the bank statement, or whether a refund was paid another way). Mention that approved adjustments are already included.
"Waiting for settlement" and "Cash not yet deposited" are normal, not errors.`;

/** What the model sees: the computed result, cut down, amounts as plain numbers and days in words. */
export function modelInput(r: ReconResult, question: string | null) {
  const day = (d: string) => shortDate(d);
  return {
    period: `${day(r.from)} to ${day(r.to)}`,
    bankDataUpTo: r.zoho.bankKnownUntil ? day(r.zoho.bankKnownUntil) : "not available",
    bankDataOutOfDate: r.zoho.stale,
    totals: r.totals,
    byMethod: r.byMethod.map((m) => ({ ...m, method: METHOD_WORDS[m.method] })),
    needsLooking: r.rows.filter((x) => !["matched", "nothing_due", "cash_in_hand"].includes(x.status)).slice(0, 40)
      .map((x) => ({ day: day(x.date), method: METHOD_WORDS[x.method], expected: x.expected, deposited: x.deposited, difference: x.difference,
                     status: x.statusWords, note: x.note, possibleCredits: x.candidates.map((c) => ({ day: day(c.date), amount: c.amount })) })),
    unclassifiedBankCredits: r.unclassified.slice(0, 30).map((u) => ({ day: day(u.date), amount: u.amount })),
    approvedAdjustments: [...new Set(r.effects.map((e) => e.adjustmentId))].length,
    question: question || "Explain this reconciliation and what to check first.",
  };
}

/** Amounts as people write them ("₹18,590", "18,590.00") compared as plain numbers. */
export function checkNumbers(text: string, facts: unknown) {
  const plain = text.replace(/(\d),(?=\d)/g, "$1").replace(/(\d+)\.00\b/g, "$1");
  return numbersCheck(plain, facts);
}

export class AssistantUnavailable extends Error {}

export async function explain(me: number, r: ReconResult, question: string | null): Promise<{ id: number; text: string | null; status: "ready" | "failed"; model: string; error: string | null }> {
  const model = String((await one<{ value: unknown }>(`SELECT value FROM app.settings WHERE key = 'ai.recon_model'`))?.value ?? "qwen3.5:9b");
  const input = modelInput(r, question);
  let text: string | null = null, error: string | null = null, checked: unknown = null;
  let res: Response;
  try {
    res = await fetch(`${ollama()}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: "10m", options: { temperature: 0.1, num_ctx: 8192, num_predict: 400 },
                             messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Facts:\n${JSON.stringify(input)}` }] }),
    });
  } catch {
    throw new AssistantUnavailable("The assistant is not available: the local model (Ollama) is not running on shichika. The reconciliation itself is unaffected.");
  }
  if (res.status === 404) throw new AssistantUnavailable(`The assistant's model ${model} is not installed in Ollama on shichika.`);
  if (!res.ok) throw new AssistantUnavailable(`The local model answered with an error (${res.status}). The reconciliation itself is unaffected.`);
  const body: any = await res.json();
  const answer = String(body?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!answer) error = "The model gave no answer";
  else {
    const c = checkNumbers(answer, input);
    checked = c;
    if (c.ok) text = answer; else error = `Not shown: it used numbers that are not in the reconciliation (${c.unknown.slice(0, 5).join(", ")})`;
  }
  const status = text ? "ready" : "failed";
  const id = await withTx({ userId: me, source: "web", summary: `Reconciliation assistant asked about ${niceDate(r.from)} to ${niceDate(r.to)}` }, async (c) =>
    (await c.query(`INSERT INTO app.recon_assistant_log (asked_by, date_from, date_to, question, input, answer, model, prompt_version, status, error, checked)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
                   [me, r.from, r.to, question, JSON.stringify(input), answer || null, model, PROMPT_VERSION, status, error, JSON.stringify(checked)])).rows[0].id as number);
  return { id, text, status, model, error };
}
