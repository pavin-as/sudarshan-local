// The huddle sheet: one day on one printable page for the morning meeting.
// Who is coming and when, what each needs, what is not yet confirmed, and what the scheduling rules say.
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type RuleFinding } from "../api";
import { dayLabel, niceDate, weekdayName, planText } from "../format";
import { ErrorNotice, Loading, Tags } from "../components/ui";
import { LEVEL_WORDS, RuleNotes } from "../components/RuleNotes";

interface HuddleRow {
  id: number; slotTime: string | null; patientName: string; mrd: string | null; ageYears: number | null; ageText?: string | null; patientType: string | null;
  planOfAction: string | null; tags: string[]; remarks: string | null; status: string; familyGroup: string | null;
  doctorName: string | null; confirmed4day: boolean; confirmed1day: boolean;
}
interface Huddle {
  date: string; appointments: HuddleRow[]; findings: RuleFinding[]; specialCases: { id: number; types: string[] }[];
  summary: Record<"booked" | "waitlist" | "newPatients" | "notConfirmed" | "dilation" | "injections" | "lasers" | "atGonio" | "hfa" | "rop", number>;
}


export function HuddlePage() {
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? "";
  const h = useQuery({ queryKey: ["huddle", date], queryFn: () => api<Huddle>(`/huddle${date ? `?date=${date}` : ""}`) });
  const data = h.data;
  const byId = new Map<number, RuleFinding[]>();
  for (const f of data?.findings ?? []) for (const id of f.ids) byId.set(id, [...(byId.get(id) ?? []), f]);
  const special = new Map((data?.specialCases ?? []).map((s) => [s.id, s.types]));
  const s = data?.summary;
  const timed = (data?.appointments ?? []).filter((a) => a.slotTime);
  const waiting = (data?.appointments ?? []).filter((a) => !a.slotTime);

  return (
    <div className="huddle">
      <div className="page-head">
        <div>
          <h1>Huddle sheet{data && `: ${dayLabel(data.date)}`}</h1>
          {data && <div className="muted">{weekdayName(data.date, true)}, {niceDate(data.date, true)}</div>}
        </div>
        <span className="grow" />
        <input className="no-print" type="date" value={data?.date ?? date} onChange={(e) => e.target.value && setParams({ date: e.target.value })} aria-label="Day" />
        <button className="btn-primary no-print" onClick={() => window.print()} disabled={!data}>Print</button>
      </div>

      {h.error && <ErrorNotice error={h.error} />}
      {h.isLoading || !data || !s ? <Loading /> : <>
        <section className="huddle-summary">
          <span><b>{s.booked}</b> booked</span>
          <span><b>{s.newPatients}</b> new patients</span>
          <span className={s.notConfirmed ? "warn-text" : ""}><b>{s.notConfirmed}</b> not confirmed (1-day call)</span>
          <span><b>{s.waitlist}</b> on the waitlist</span>
          <span><b>{s.dilation}</b> dilation</span>
          <span><b>{s.injections}</b> injections</span>
          <span><b>{s.lasers}</b> laser / YAG</span>
          <span><b>{s.atGonio}</b> AT / Gonio</span>
          <span><b>{s.hfa}</b> HFA</span>
          <span><b>{s.rop}</b> ROP</span>
        </section>

        {data.findings.some((f) => f.level !== "info") && (
          <section className="stack">
            <h3>Scheduling rules to check</h3>
            <RuleNotes findings={data.findings.filter((f) => f.level !== "info")} />
          </section>)}

        <table className="list huddle-table">
          <thead><tr><th>Time</th><th>Patient</th><th>Plan</th><th>Special</th><th>Doctor</th><th>Confirmed</th><th>Rules</th></tr></thead>
          <tbody>{timed.map((a) => {
            const fs = byId.get(a.id) ?? [];
            const worst = fs.find((f) => f.level === "error") ?? fs.find((f) => f.level === "warning") ?? fs[0];
            const extra = (special.get(a.id) ?? []).filter((t) => !a.tags.some((x) => x.toLowerCase().includes(t.toLowerCase())));
            return (
              <tr key={a.id}>
                <td className="nowrap"><b>{a.slotTime}</b></td>
                <td><b>{a.patientName}</b> <span className="muted small">{a.mrd ?? "new"}{a.ageYears != null && `, ${a.ageText ?? `${a.ageYears} y`}`}</span>
                  {a.familyGroup && <div className="small muted">family {a.familyGroup}</div>}</td>
                <td>{planText(a.planOfAction)}</td>
                <td>{(a.tags.length > 0 || extra.length > 0) && <Tags tags={[...a.tags, ...extra]} />}</td>
                <td className="small">{a.doctorName}</td>
                <td className="small nowrap">{a.confirmed1day ? "1-day" : a.confirmed4day ? "4-day" : <span className="warn-text">not yet</span>}</td>
                <td className="small">{worst && <span className={`rule-flag ${worst.level}`} title={fs.map((f) => f.message).join("\n")}>
                  {LEVEL_WORDS[worst.level]}{fs.length > 1 ? ` +${fs.length - 1}` : ""}</span>}</td>
              </tr>);
          })}</tbody>
        </table>
        {timed.length === 0 && <div className="empty">No bookings with a time on this day.</div>}

        {waiting.length > 0 && (
          <section className="stack">
            <h3>Waitlist ({waiting.length})</h3>
            <div className="small">{waiting.map((a) => `${a.patientName} (${a.mrd ?? "new"})${a.planOfAction ? `: ${planText(a.planOfAction)}` : ""}`).join(" · ")}</div>
          </section>)}
        <p className="muted small">Printed from Sudarshan. Contains patient names: keep it in the clinic and shred it after the day.</p>
      </>}
    </div>
  );
}
