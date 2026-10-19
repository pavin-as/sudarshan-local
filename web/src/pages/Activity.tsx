// The activity log: every change anyone made, as a sentence, newest first.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ErrorNotice, Loading } from "../components/ui";

const AREAS: [string, string][] = [["", "Everything"], ["appointments", "Appointments"], ["appointment_events", "Remarks and confirmations"],
  ["followup_actions", "Follow-up calls"], ["day_capacity", "Daily slots"], ["holidays", "Holidays"], ["doctor_exceptions", "Doctor leave"],
  ["doctor_schedule", "Doctor hours"], ["users", "Users"]];

export function ActivityPage() {
  const [entity, setEntity] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["audit", entity, search, from],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: "60" });
      if (entity) p.set("entity", entity);
      if (search) p.set("text", search);
      if (from) { p.set("from", from); p.set("to", from); }
      if (pageParam) p.set("before", String(pageParam));
      return api(`/audit?${p}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const entries = (q.data?.pages ?? []).flatMap((p) => p.entries);
  return (
    <>
      <div className="page-head">
        <div><h1>Activity log</h1><div className="muted">Who changed what, and when. Nobody can edit or delete these lines.</div></div>
      </div>
      <form className="row" style={{ marginBottom: "1rem" }} onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); }}>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Area">{AREAS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Day" />
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Patient name, MRD or words" style={{ minWidth: 260 }} />
        <button>Search</button>
        {(entity || search || from) && <button type="button" className="btn-quiet" onClick={() => { setEntity(""); setText(""); setSearch(""); setFrom(""); }}>Clear</button>}
      </form>
      {q.error && <ErrorNotice error={q.error} />}
      <div className="panel">
        {q.isLoading ? <Loading /> : entries.length === 0 ? <div className="empty">Nothing recorded for this search.</div> : (
          <ul className="feed">
            {entries.map((e: any) => (
              <li key={e.id}>
                <div className="small"><div>{e.when}</div><div className="who">{e.who}</div></div>
                <div>
                  <div>{e.summary ?? e.what}</div>
                  {e.details && <div className="details">{e.details}</div>}
                  {e.patientId && <div className="small"><Link to={`/patients/${e.patientId}`}>{e.patientName ?? "Patient"} {e.mrd}</Link></div>}
                </div>
              </li>
            ))}
          </ul>)}
      </div>
      {q.hasNextPage && <div style={{ marginTop: "0.8rem" }}><button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>Show older</button></div>}
    </>
  );
}
