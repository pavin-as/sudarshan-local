// Month view: every day of a month with its load. Read only; a day opens on the day board.
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type DayInfo } from "../api";
import { todayIST } from "../format";
import { ErrorNotice, Loading } from "../components/ui";

interface MonthDay extends DayInfo {
  newPatients: number; cancelled: number; injections: number; lasers: number; rop: number; hfa: number; atGonio: number; dilation: number;
  toCheck: number; againstRule: number;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shift = (m: string, n: number) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

export function MonthPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? todayIST().slice(0, 7);
  const today = todayIST();
  const q = useQuery({ queryKey: ["month", month], queryFn: () => api<{ month: string; days: MonthDay[] }>(`/month?month=${month}`) });
  const days = q.data?.days ?? [];
  const lead = days.length ? days[0].weekday - 1 : 0;           // empty cells before the 1st (weeks start Monday)
  const open = days.filter((d) => d.open);
  const sum = (k: keyof MonthDay) => open.reduce((n, d) => n + (d[k] as number), 0);

  return (
    <>
      <div className="page-head">
        <div><h1>{MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</h1>
          <div className="muted">Each day: booked of maximum slots, then what is planned. Click a day to open it.</div></div>
        <span className="grow" />
        <button onClick={() => setParams({ month: shift(month, -1) })}>Previous month</button>
        {month !== today.slice(0, 7) && <button onClick={() => setParams({})}>This month</button>}
        <button onClick={() => setParams({ month: shift(month, 1) })}>Next month</button>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading ? <Loading /> : <>
        <section className="huddle-summary" style={{ marginBottom: "1rem" }}>
          <span><b>{sum("booked")}</b> booked of {sum("maxSlots")} slots on {open.length} open days</span>
          <span><b>{sum("waitlist")}</b> on waitlists</span>
          <span><b>{sum("newPatients")}</b> new patients</span>
          <span><b>{sum("injections")}</b> injections</span>
          <span><b>{sum("lasers")}</b> laser / YAG</span>
          <span><b>{sum("rop")}</b> ROP</span>
          <span><b>{sum("cancelled")}</b> cancelled</span>
        </section>
        <div className="month-grid" role="grid" aria-label="Days of the month">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((w) => <div key={w} className="month-wd" role="columnheader">{w}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={`e${i}`} className="month-cell empty" aria-hidden="true" />)}
          {days.map((d) => {
            const full = d.open && d.booked >= d.maxSlots;
            const pct = d.maxSlots ? Math.min(100, (d.booked / d.maxSlots) * 100) : 0;
            const tags = [d.injections && `${d.injections} inj`, d.lasers && `${d.lasers} laser`, d.rop && `${d.rop} ROP`,
                          d.hfa && `${d.hfa} HFA`, d.atGonio && `${d.atGonio} AT/G`].filter(Boolean) as string[];
            return (
              <Link key={d.date} to={d.date === today ? "/" : `/?date=${d.date}`} role="gridcell"
                    className={`month-cell ${d.date === today ? "today" : ""} ${d.date < today ? "past" : ""} ${d.open ? "" : "closed"}`}>
                <div className="row" style={{ gap: "0.3rem" }}>
                  <b className="month-num">{Number(d.date.slice(8, 10))}</b><span className="grow" />
                  {d.againstRule > 0 && <span className="rule-flag error" title="Against a scheduling rule">{d.againstRule} against rule</span>}
                  {!d.againstRule && d.toCheck > 0 && <span className="rule-flag" title="Scheduling rules to check">{d.toCheck} to check</span>}
                </div>
                {d.holiday ? <span className="small overdue">{d.holiday}</span>
                  : !d.open ? <span className="small muted">closed</span>
                  : <>
                    <div className="small"><b>{d.booked}</b> of {d.maxSlots}{d.booked > d.maxSlots && <span className="overdue"> over</span>}</div>
                    <span className={`meter ${full ? "full" : ""}`}><i style={{ width: `${pct}%` }} /></span>
                    <div className="small muted">{[d.waitlist && `${d.waitlist} waiting`, d.newPatients && `${d.newPatients} new`].filter(Boolean).join(", ")}</div>
                    {tags.length > 0 && <div className="month-tags">{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                  </>}
              </Link>);
          })}
        </div>
      </>}
    </>
  );
}
