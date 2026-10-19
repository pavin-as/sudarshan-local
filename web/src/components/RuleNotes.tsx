// What the clinic's scheduling rules say about a booking or a day. Warnings only: staff can always go ahead.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type RuleDay, type RuleFinding, type RuleLevel } from "../api";

export const LEVEL_WORDS: Record<RuleLevel, string> = { error: "Against rule", warning: "Check", info: "Note" };

/** Every finding for a day (the board, and the appointment panel). Refreshed whenever bookings change. */
export function useDayRules(date: string | null) {
  return useQuery({ queryKey: ["rules", date], enabled: !!date, queryFn: () => api<RuleDay>(`/rules/day?date=${date}`) });
}

/** Rule findings for a booking not made yet (or an existing one being moved). Waits until typing pauses. */
export function useRuleCheck(body: Record<string, unknown> | null) {
  const key = body ? JSON.stringify(body) : null;
  const [settled, setSettled] = useState(key);
  useEffect(() => { const t = setTimeout(() => setSettled(key), 400); return () => clearTimeout(t); }, [key]);
  return useQuery({
    queryKey: ["rule-check", settled],
    enabled: !!settled,
    placeholderData: (prev) => prev,
    queryFn: () => api<{ findings: RuleFinding[] }>("/rules/check", { body: JSON.parse(settled!) }).then((r) => r.findings),
  });
}

export function RuleNotes({ findings, onOpen, empty }: { findings: RuleFinding[]; onOpen?: (id: number) => void; empty?: string }) {
  if (!findings.length) return empty ? <div className="muted small">{empty}</div> : null;
  return (
    <ul className="rule-notes">
      {findings.map((f, i) => (
        <li key={`${f.code}-${f.id}-${i}`} className={`rule-note ${f.level}`}>
          <span className="rule-level">{LEVEL_WORDS[f.level]}</span>
          <span>
            {onOpen && f.id ? <button className="link" onClick={() => onOpen(f.id!)}>{f.message}</button> : f.message}
            <span className="muted small"> {f.suggestion}. Rule {f.rule}.</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The booking dialog / reschedule block: a heading and the findings for this booking. */
export function RuleCheckPanel({ body }: { body: Record<string, unknown> | null }) {
  const r = useRuleCheck(body);
  if (!body) return null;
  const findings = r.data ?? [];
  return (
    <section className="stack" aria-live="polite">
      <h3>Clinic scheduling rules {findings.length > 0 && <span className="muted small" style={{ fontWeight: 400 }}>warnings only, you can still book</span>}</h3>
      {r.error ? <div className="muted small">Could not check the rules just now.</div>
        : <RuleNotes findings={findings} empty={r.isLoading ? "Checking…" : "Nothing against the scheduling rules for this time."} />}
    </section>
  );
}
