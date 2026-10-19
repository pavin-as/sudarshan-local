// Settings for managers and admins: scheduling rules, the booking grid, visit / patient type lists, plans of action.
// Every change is written to the activity log. Secrets are not settings: they live in .env on shichika.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { ErrorNotice, Loading, useToast } from "../components/ui";

interface Plan { name: string; eye: string | null; prepMin: number | null; consultMin: number | null; priority: number | null; isActive: boolean }
interface SettingsData {
  booking: { slotMinutes: number; dayStart: string; dayEnd: string };
  rules: { switches: { key: string; label: string; on: boolean }[]; fields: { key: string; label: string; kind: string; value: string; defaultValue: string }[] };
  lists: { id: string; label: string; items: string[] }[];
  plans: Plan[];
  reservedSlots: { name: string; entries: string[] }[];
}

function RulesSection({ data }: { data: SettingsData["rules"] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [sw, setSw] = useState<Record<string, boolean>>({});
  const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const changed = Object.keys(sw).length + Object.keys(vals).length;
  const save = async () => {
    setError(null);
    try {
      await api("/settings/rules", { method: "PUT", body: { switches: sw, values: vals } });
      toast("Scheduling rules saved"); setSw({}); setVals({});
      await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Scheduling rules</h2><span className="muted small">all warnings only (D-022)</span></div>
      <div className="panel-pad settings-cols">
        <div className="stack" style={{ gap: "0.35rem" }}>
          <h3>Which rules are checked</h3>
          {data.switches.map((s) => {
            const on = sw[s.key] ?? s.on;
            return <label key={s.key} className="check"><input type="checkbox" checked={on}
              onChange={(e) => setSw((x) => { const n = { ...x }; if (e.target.checked === s.on) delete n[s.key]; else n[s.key] = e.target.checked; return n; })} />{s.label}</label>;
          })}
        </div>
        <div className="stack" style={{ gap: "0.35rem" }}>
          <h3>The numbers</h3>
          <table className="list compact"><tbody>{data.fields.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              <td><input className="narrow-input" value={vals[f.key] ?? f.value} placeholder={f.kind === "time" ? "HH:MM" : undefined}
                inputMode={f.kind === "number" ? "numeric" : undefined} aria-label={f.label}
                onChange={(e) => setVals((x) => { const n = { ...x }; if (e.target.value === f.value) delete n[f.key]; else n[f.key] = e.target.value; return n; })} /></td>
              <td className="small muted">{f.value !== f.defaultValue ? `Google app default: ${f.defaultValue}` : ""}</td>
            </tr>))}</tbody></table>
          <p className="small muted">Times as 24-hour HH:MM (16:00). Days as MON, TUE, WED, THU, FRI, SAT, SUN; laser days separated by commas (TUE,FRI).</p>
        </div>
      </div>
      <div className="panel-pad row" style={{ paddingTop: 0 }}>
        <ErrorNotice error={error} /><span className="grow" />
        {changed > 0 && <button onClick={() => { setSw({}); setVals({}); }}>Undo changes</button>}
        <button className="btn-primary" disabled={!changed} onClick={() => void save()}>Save rules{changed ? ` (${changed} changed)` : ""}</button>
      </div>
    </section>
  );
}

function BookingSection({ data }: { data: SettingsData["booking"] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ slotMinutes: String(data.slotMinutes), dayStart: data.dayStart, dayEnd: data.dayEnd });
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setF({ slotMinutes: String(data.slotMinutes), dayStart: data.dayStart, dayEnd: data.dayEnd }), [data]);
  const dirty = f.slotMinutes !== String(data.slotMinutes) || f.dayStart !== data.dayStart || f.dayEnd !== data.dayEnd;
  const save = async () => {
    setError(null);
    try {
      const r = await api("/settings/booking", { method: "PUT", body: { slotMinutes: Number(f.slotMinutes), dayStart: f.dayStart, dayEnd: f.dayEnd } });
      toast("Booking grid saved"); if (r.warning) toast(r.warning, "warn");
      await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Booking grid</h2></div>
      <div className="panel-pad stack">
        <div className="row">
          <label className="field"><span>Minutes per slot</span><input className="narrow-input" inputMode="numeric" value={f.slotMinutes} onChange={(e) => setF({ ...f, slotMinutes: e.target.value.replace(/\D/g, "") })} /></label>
          <label className="field"><span>First slot (HH:MM)</span><input className="narrow-input" value={f.dayStart} placeholder="09:00" onChange={(e) => setF({ ...f, dayStart: e.target.value })} /></label>
          <label className="field"><span>Last slot ends (HH:MM)</span><input className="narrow-input" value={f.dayEnd} placeholder="18:00" onChange={(e) => setF({ ...f, dayEnd: e.target.value })} /></label>
        </div>
        <p className="small muted">Bookings already made stay at their time. Daily maximums, holidays and doctors' hours are on the Clinic calendar page.</p>
        <div className="row"><ErrorNotice error={error} /><span className="grow" />
          <button className="btn-primary" disabled={!dirty} onClick={() => void save()}>Save grid</button></div>
      </div>
    </section>
  );
}

function ListSection({ list }: { list: SettingsData["lists"][number] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState(list.items.join("\n"));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setText(list.items.join("\n")), [list]);
  const items = text.split("\n").map((x) => x.trim()).filter(Boolean);
  const dirty = items.join("|") !== list.items.join("|");
  const save = async () => {
    setError(null);
    try { await api(`/settings/lists/${list.id}`, { method: "PUT", body: { items } }); toast(`${list.label} saved`); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  return (
    <div className="stack">
      <h3>{list.label}</h3>
      <textarea rows={Math.min(14, Math.max(5, list.items.length + 1))} value={text} onChange={(e) => setText(e.target.value)} aria-label={list.label} />
      <div className="row"><span className="small muted grow">One per line. Offered as choices in the booking dialog.</span>
        <button className="btn-small btn-primary" disabled={!dirty} onClick={() => void save()}>Save</button></div>
      <ErrorNotice error={error} />
    </div>
  );
}

function PlanRow({ p }: { p: Plan }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ prepMin: p.prepMin?.toString() ?? "", consultMin: p.consultMin?.toString() ?? "", priority: p.priority?.toString() ?? "" });
  const num = (v: string) => (v === "" ? null : Number(v));
  const dirty = f.prepMin !== (p.prepMin?.toString() ?? "") || f.consultMin !== (p.consultMin?.toString() ?? "") || f.priority !== (p.priority?.toString() ?? "");
  const patch = async (body: unknown, done: string) => {
    try { await api(`/plans/${encodeURIComponent(p.name)}`, { method: "PATCH", body }); toast(done); await qc.invalidateQueries(); }
    catch (e: any) { toast(e.message, "err"); }
  };
  const field = (k: keyof typeof f) => (
    <input className="narrow-input" inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, "") })} aria-label={`${p.name} ${k}`} />);
  return (
    <tr style={{ opacity: p.isActive ? 1 : 0.55 }}>
      <td><b>{p.name}</b></td>
      <td className="small">{p.eye === "Yes" ? "per eye" : ""}</td>
      <td>{field("prepMin")}</td><td>{field("consultMin")}</td><td>{field("priority")}</td>
      <td className="right"><div className="row actions">
        {dirty && <button className="btn-small btn-primary" onClick={() => void patch({ prepMin: num(f.prepMin), consultMin: num(f.consultMin), priority: num(f.priority) }, `${p.name} saved`)}>Save</button>}
        <button className="btn-small" onClick={() => void patch({ isActive: !p.isActive }, `${p.name} ${p.isActive ? "hidden" : "shown again"}`)}>{p.isActive ? "Hide" : "Show"}</button></div></td>
    </tr>
  );
}

function PlansSection({ plans }: { plans: Plan[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const add = async () => {
    try { await api("/plans", { body: { name: name.trim(), eye: "No", prepMin: 0, consultMin: 10, priority: 2 } }); toast(`${name.trim()} added`); setName(""); await qc.invalidateQueries(); }
    catch (e: any) { toast(e.message, "err"); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Plans of action</h2>
        <span className="muted small">preparation minutes set when the consultation starts (slot + longest preparation)</span></div>
      <table className="list compact">
        <thead><tr><th>Plan</th><th /><th>Preparation (min)</th><th>Consultation (min)</th><th>Priority</th><th /></tr></thead>
        <tbody>{plans.map((p) => <PlanRow key={p.name} p={p} />)}</tbody>
      </table>
      <div className="panel-pad row">
        <input placeholder="New plan of action" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-small" disabled={name.trim().length < 2} onClick={() => void add()}>Add</button>
        <span className="small muted">Hidden plans are no longer offered when booking; old bookings keep them.</span>
      </div>
    </section>
  );
}

// Follow-up call scripts, one per risk tier; {name}, {doctor}, {due}, {treatment} and {clinic} are filled in per patient
function ScriptsSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["followup-scripts"], queryFn: () => api<{ clinicName: string; scripts: { tier: number; words: string; text: string }[] }>("/followups/scripts") });
  const [f, setF] = useState<{ clinicName: string; scripts: Record<string, string> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (q.data) setF({ clinicName: q.data.clinicName, scripts: Object.fromEntries(q.data.scripts.map((s) => [String(s.tier), s.text])) }); }, [q.data]);
  if (!q.data || !f) return null;
  const save = async () => {
    setError(null);
    try { await api("/followups/scripts", { method: "PUT", body: f }); toast("Call scripts saved"); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Follow-up call scripts</h2></div>
      <div className="panel-pad stack">
        <p className="small muted" style={{ margin: 0 }}>Shown in the call dialog on Follow-up calls, filled in for each patient. Write them in the words staff
          use on the phone (Malayalam is fine). Fill-ins: {"{name}"}, {"{doctor}"}, {"{due}"}, {"{treatment}"}, {"{clinic}"}.</p>
        <label className="field"><span>Clinic name as said on the phone</span>
          <input value={f.clinicName} onChange={(e) => setF({ ...f, clinicName: e.target.value })} /></label>
        {q.data.scripts.map((s) => (
          <label key={s.tier} className="field"><span>{s.words}</span>
            <textarea rows={3} value={f.scripts[String(s.tier)] ?? ""} onChange={(e) => setF({ ...f, scripts: { ...f.scripts, [String(s.tier)]: e.target.value } })} /></label>))}
        <div className="row"><ErrorNotice error={error} /><span className="grow" />
          <button className="btn-primary" onClick={() => void save()}>Save scripts</button></div>
      </div>
    </section>
  );
}

// Early booking limits (D-030): admins change them, as in the Google app; managers see them
function EarlySection({ data }: { data: { thresholds: { days: number; percentage: number }[]; defaults: { days: number; percentage: number }[];
                                         waitlistPercent: number; waitlistDefault: number } }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const admin = user?.role === "admin";
  const [rows, setRows] = useState(data.thresholds.map((t) => ({ days: String(t.days), percentage: String(t.percentage) })));
  const [error, setError] = useState<unknown>(null);
  const [wl, setWl] = useState(String(data.waitlistPercent));
  useEffect(() => { setRows(data.thresholds.map((t) => ({ days: String(t.days), percentage: String(t.percentage) }))); setWl(String(data.waitlistPercent)); }, [data]);
  const saveWl = async () => {
    setError(null);
    try { await api("/settings/waitlist", { method: "PUT", body: { percent: Number(wl) } }); toast("Waiting list size saved"); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  const save = async (list: { days: string; percentage: string }[]) => {
    setError(null);
    try {
      await api("/settings/early-booking", { method: "PUT", body: { thresholds: list.map((r) => ({ days: Number(r.days), percentage: Number(r.percentage) })) } });
      toast("Early booking limits saved"); await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  const label = (d: string) => (d === "0" ? "Same day" : `${d} or more days ahead`);
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Early booking limits and waiting list size</h2><span className="muted small">{admin ? "admin" : "only an admin can change these"}</span></div>
      <div className="panel-pad stack">
        <p className="small muted" style={{ margin: 0 }}>The further away a day is, the smaller the share of its maximum slots that can be booked, so places stay for
          patients who need to book close to the date. Waitlist and cancelled bookings do not count. Over the limit a booking is refused; a manager can
          book anyway with a reason. Percentages must rise as the day gets closer, between 10% and 100%.</p>
        <table className="list compact" style={{ maxWidth: 520 }}>
          <thead><tr><th>Days ahead</th><th>Up to % of the day's slots</th>{admin && <th />}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td>{admin ? <input className="narrow-input" inputMode="numeric" aria-label="Days ahead" value={r.days}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, days: e.target.value.replace(/\D/g, "") } : x)))} /> : label(r.days)}
                {admin && <span className="muted small"> {r.days === "0" ? "same day" : "or more"}</span>}</td>
              <td>{admin ? <input className="narrow-input" inputMode="numeric" aria-label="Percentage" value={r.percentage}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percentage: e.target.value.replace(/\D/g, "") } : x)))} /> : `${r.percentage}%`}</td>
              {admin && <td><button className="btn-small" disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></td>}
            </tr>))}</tbody>
        </table>
        {admin && <div className="row"><ErrorNotice error={error} /><span className="grow" />
          <button onClick={() => setRows([...rows, { days: "", percentage: "" }])}>Add a band</button>
          <button onClick={() => void save(data.defaults.map((t) => ({ days: String(t.days), percentage: String(t.percentage) })))}>Back to the Google app's values</button>
          <button className="btn-primary" onClick={() => void save(rows)}>Save limits</button></div>}
        <div className="row">
          <label className="field"><span>Waiting list size: % of the day's maximum slots, rounded up (Google app: {data.waitlistDefault}%)</span>
            {admin ? <input className="narrow-input" inputMode="numeric" value={wl} onChange={(e) => setWl(e.target.value.replace(/\D/g, ""))} />
                   : <b>{data.waitlistPercent}%</b>}</label>
          {admin && <button onClick={() => void saveWl()}>Save waiting list size</button>}
        </div>
        <p className="small muted" style={{ margin: 0 }}>A 38-slot day then holds {Math.ceil(38 * Number(wl || 0) / 100)} on its waiting list, a 15-slot day
          {" "}{Math.ceil(15 * Number(wl || 0) / 100)}. When it is full a booking without a time is refused; a manager can add one with a reason. A patient already
          waiting keeps their place.</p>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsData>("/settings") });
  if (q.error) return <ErrorNotice error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="page-head"><div><h1>Settings</h1>
        <div className="muted">For managers and admins. Every change is written to the activity log. Users have their own page; API keys and passwords are kept in .env on shichika, not here.</div></div></div>
      <RulesSection data={d.rules} />
      <BookingSection data={d.booking} />
      <EarlySection data={(d as any).earlyBooking} />
      <section className="panel"><div className="panel-head"><h2>Lists</h2></div>
        <div className="panel-pad settings-cols">{d.lists.map((l) => <ListSection key={l.id} list={l} />)}</div></section>
      <PlansSection plans={d.plans} />
      <ScriptsSection />
      <section className="panel">
        <div className="panel-head"><h2 className="grow">Reserved slot blocks (from the Google app)</h2><span className="muted small">rule 17 and the HFA hold</span></div>
        <div className="panel-pad stack small">
          <p className="muted" style={{ margin: 0 }}>Each entry is day-from-to-days (D = every day; W-09:00-12:20 = Wednesday 09:00-12:20).
            HFA slots are held for HFA patients until 2 days before the day (others refused; a manager can book with a reason).
            For the other blocks, a booking whose visit type is ROP, injection, laser, dilation, urgent new or emergency gets a warning
            when it is outside its time; other bookings may use these slots. The list itself is changed in a later version.</p>
          <table className="list compact"><tbody>{d.reservedSlots.map((r) => (
            <tr key={r.name}><td className="nowrap"><b>{r.name}</b></td><td>{r.entries.join(" · ")}</td></tr>))}</tbody></table>
        </div>
      </section>
    </div>
  );
}
