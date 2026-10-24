// Patients by group: one card per team (ROP, injection, laser, ...) with a paged list and Print / Save as PDF.
// Counts and lists come from the nightly rebuild (app.patient_group); nothing loads until a card is picked.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { niceDate, stamp, todayIST } from "../format";
import { ErrorNotice, Loading } from "./ui";

const PAGE = 50;

interface Group { key: string; label: string; rule: string; count: number }
interface Row {
  patientId: number; mrd: string; name: string; ageYears: number | null; ageText: string | null; sex: string | null; mobile: string | null;
  lastVisit: string | null; lastEvent: string | null; status: string | null; what: string | null; total: number | null;
  bcvaRe: string | null; bcvaLe: string | null; bcvaDate: string | null; iopRe: number | null; iopLe: number | null; iopDate: string | null;
}

const pair = (re: unknown, le: unknown, date: string | null) => (re == null && le == null ? "-" : `RE ${re ?? "-"} / LE ${le ?? "-"}${date ? `, ${niceDate(date, true)}` : ""}`);

/** What the group-specific columns say for one patient. */
function detail(g: string, p: Row): string {
  const day = p.lastEvent ? niceDate(p.lastEvent, true) : null;
  switch (g) {
    case "rop": return `${p.status ?? ""}${day ? `, last ROP visit ${day}` : ""}`;
    case "injection": return `${p.what ?? ""}${day ? `, ${day}` : ""}${p.total ? ` (${p.total} in all)` : ""}`;
    case "laser": return `${p.what ?? ""}${day ? `, ${day}` : ""}${p.total ? ` (${p.total} in all)` : ""}`;
    case "retina": return `${p.what ?? ""}${day ? `, latest exam ${day}` : ""}`;
    case "lowvision": return p.status ?? "";
    default: return `${p.status ?? ""}${day ? `, ${day}` : ""}`;
  }
}

function ListTable({ group, rows }: { group: string; rows: Row[] }) {
  const extra = group === "lowvision" ? "Best-corrected vision" : group === "glaucoma" ? "Pressure (mmHg)" : null;
  return (
    <table className="list">
      <thead><tr><th>Patient</th><th>Age</th><th>Mobile</th><th>Last visit</th><th>{group === "rop" ? "ROP" : "Why on this list"}</th>{extra && <th>{extra}</th>}</tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.patientId}>
          <td><Link to={`/patients/${p.patientId}`}><b>{p.name}</b></Link> <span className="muted small">{p.mrd}</span></td>
          <td className="nowrap">{p.ageText ?? p.ageYears ?? "-"}{p.sex ? ` ${p.sex[0]}` : ""}</td>
          <td className="nowrap">{p.mobile ?? "-"}</td>
          <td className="nowrap">{p.lastVisit ? niceDate(p.lastVisit, true) : "-"}</td>
          <td className="small">{detail(group, p)}</td>
          {extra && <td className="small">{group === "lowvision" ? pair(p.bcvaRe, p.bcvaLe, p.bcvaDate) : pair(p.iopRe, p.iopLe, p.iopDate)}</td>}
        </tr>))}</tbody>
    </table>
  );
}

export function PatientGroups() {
  const [group, setGroup] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [limit, setLimit] = useState(PAGE);
  const [printRows, setPrintRows] = useState<Row[] | null>(null);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const cards = useQuery({ queryKey: ["patient-groups"], queryFn: () => api<{ groups: Group[]; builtAt: string | null }>("/patient-groups"), staleTime: 5 * 60_000 });
  const list = useQuery({
    queryKey: ["patient-group", group, search, sort, limit],
    queryFn: () => api<{ patients: Row[]; total: number }>(`/patient-groups/${group}?q=${encodeURIComponent(search)}&sort=${sort}&limit=${limit}`),
    enabled: !!group,
    placeholderData: (prev) => prev,
  });

  useEffect(() => { const h = setTimeout(() => { setSearch(text.trim()); setLimit(PAGE); }, 300); return () => clearTimeout(h); }, [text]);

  // print the whole list, not only the rows shown: fetch everything, then open the print window
  useEffect(() => {
    if (!printRows) return;
    const h = setTimeout(() => window.print(), 300);
    const done = () => setPrintRows(null);
    window.addEventListener("afterprint", done);
    return () => { clearTimeout(h); window.removeEventListener("afterprint", done); };
  }, [printRows]);
  const print = async () => {
    setPrinting(true); setError(null);
    try { setPrintRows((await api<{ patients: Row[] }>(`/patient-groups/${group}?q=${encodeURIComponent(search)}&sort=${sort}&limit=5000&print=1`)).patients); }
    catch (e) { setError(e); }
    finally { setPrinting(false); }
  };

  if (cards.error) return <ErrorNotice error={cards.error} />;
  if (!cards.data) return null;
  const current = cards.data.groups.find((g) => g.key === group);
  const rows = list.data?.patients ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="fu-print">
      <div className="no-print">
        <h2 style={{ margin: "0.4rem 0" }}>Patients by group</h2>
        <div className="fu-tiers" role="group" aria-label="Group">
          {cards.data.groups.map((g) => (
            <button key={g.key} className={`fu-tier g-${g.key}`} aria-pressed={group === g.key} title={g.rule}
              onClick={() => { setGroup(group === g.key ? null : g.key); setLimit(PAGE); setText(""); setSearch(""); }}>
              <span className="fu-n">{g.count}</span><span>{g.label}</span>
            </button>))}
        </div>
        <p className="small muted" style={{ margin: "0 0 0.8rem" }}>
          A patient can be on more than one card, so the cards do not add up. Hover a card to see its rule.
          Lists are rebuilt every night{cards.data.builtAt ? ` (last ${stamp(cards.data.builtAt)})` : ""}, so today's entries appear tomorrow.</p>
      </div>

      {group && current && (
        <>
          <div className="print-only fu-print-head">
            <h1>Patients: {current.label}</h1>
            <div>{current.rule}. Printed {niceDate(todayIST(), true)}{search && `, name or MRD containing "${search}"`}. {printRows?.length ?? 0} patient{printRows?.length === 1 ? "" : "s"}.</div>
          </div>
          <div className="no-print">
            <div className="row" style={{ marginBottom: "0.6rem", flexWrap: "wrap" }}>
              <h3 className="grow" style={{ margin: 0 }}>{current.label} <span className="muted small">{list.data ? `${total} patient${total === 1 ? "" : "s"}${search ? " found" : ""}` : ""}</span></h3>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find in this list: name or MRD" aria-label="Find in this list" style={{ minWidth: 240 }} />
              <select value={sort} onChange={(e) => { setSort(e.target.value as "recent" | "name"); setLimit(PAGE); }} aria-label="Order">
                <option value="recent">Most recent first</option><option value="name">By name</option></select>
              <button onClick={() => void print()} disabled={printing || !total} title="Prints the whole list, or choose Save as PDF in the print window">{printing ? "Preparing..." : "Print"}</button>
            </div>
            <ErrorNotice error={error ?? list.error} />
            <div className="panel">
              {!list.data ? <Loading /> : rows.length === 0 ? <div className="empty">{search ? "Nobody in this list matches." : "Nobody on this list yet."}</div> : <ListTable group={group} rows={rows} />}
            </div>
            {rows.length < total && (
              <div style={{ textAlign: "center", marginTop: "0.6rem" }}>
                <button onClick={() => setLimit(limit + PAGE)} disabled={list.isFetching}>{list.isFetching ? "Loading..." : `Show ${Math.min(PAGE, total - rows.length)} more`}</button>
                <span className="muted small"> {rows.length} of {total} shown</span>
              </div>)}
          </div>
          {printRows && <div className="print-only"><ListTable group={group} rows={printRows} /></div>}
        </>
      )}
    </div>
  );
}
