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
  clinicName: string;
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

function ClinicNameSection({ name }: { name: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState(name);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setV(name), [name]);
  const save = async () => {
    setError(null);
    try { await api("/settings/clinic-name", { method: "PUT", body: { clinicName: v } }); toast("Clinic name saved"); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Clinic name</h2></div>
      <div className="panel-pad stack">
        <label className="field"><span>Name shown in payment links</span><input value={v} maxLength={80} onChange={(e) => setV(e.target.value)} /></label>
        <div className="row"><ErrorNotice error={error} /><span className="grow" />
          <button className="btn-primary" disabled={v.trim() === name || v.trim().length < 2} onClick={() => void save()}>Save name</button></div>
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

// WhatsApp and payment links (D-034): off / test / live, test numbers, the AiSensy templates, payment amounts.
// Live only by an admin and only after cut-over (the server refuses it while the Google app is the master).
interface WaTemplate { key: string; label: string; campaign: string; params: string[]; kind: "appointment" | "payment" }
interface WaSettings { mode: string; modes: { key: string; label: string }[]; keySet: boolean; testNumbers: string[]; templates: WaTemplate[]; params: { key: string; label: string }[] }
interface PaySettings { mode: string; modes: { key: string; label: string }[]; defaultAmount: number; minAmount: number; maxAmount: number; linkMinutes: number;
                        keyMode: string | null; problem: string | null }

function ModeSwitch({ value, modes, onChange, admin }: { value: string; modes: { key: string; label: string }[]; onChange: (m: string) => void; admin: boolean }) {
  return (
    <div className="seg" role="group" aria-label="Mode">{modes.map((m) => (
      <button key={m.key} aria-pressed={value === m.key} disabled={m.key === "live" && !admin && value !== "live"}
        title={m.key === "live" ? "Admins only, after cut-over" : undefined} onClick={() => onChange(m.key)}>{m.label}</button>))}</div>
  );
}

function WhatsAppSection() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings-whatsapp"], queryFn: () => api<WaSettings>("/settings/whatsapp") });
  const [nums, setNums] = useState<string | null>(null);
  const [tpl, setTpl] = useState<WaTemplate[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return null;
  const d = q.data;
  const templates = tpl ?? d.templates;
  const save = async (body: unknown, done: string) => {
    setError(null);
    try { await api("/settings/whatsapp", { method: "PUT", body }); toast(done); setNums(null); setTpl(null); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  const editT = (i: number, patch: Partial<WaTemplate>) => setTpl(templates.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">WhatsApp (AiSensy)</h2>
        <span className="muted small">{d.keySet ? "AiSensy key is set in .env" : "AiSensy key not set yet (AISENSY_API_KEY in .env)"}</span></div>
      <div className="panel-pad stack">
        <div className="row"><b>Mode</b><ModeSwitch value={d.mode} modes={d.modes} admin={user?.role === "admin"} onChange={(m) => void save({ mode: m }, `WhatsApp: ${m}`)} />
          <span className="small muted">Test: only bookings named TEST, only to the numbers below. Live: every booked patient, after cut-over.</span></div>
        <label className="field"><span>Test numbers (staff phones, one per line or separated by commas)</span>
          <textarea rows={2} value={nums ?? d.testNumbers.map((n) => `+${n}`).join("\n")} onChange={(e) => setNums(e.target.value)} /></label>
        {nums !== null && <div className="row"><span className="grow" /><button onClick={() => setNums(null)}>Undo</button>
          <button className="btn-primary" onClick={() => void save({ testNumbers: nums.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) }, "Test numbers saved")}>Save test numbers</button></div>}
        <h3>Templates</h3>
        <p className="small muted" style={{ margin: 0 }}>Each template is approved by Meta in AiSensy first; put its campaign name here. The values are filled in this order.
          The payment-link template needs a new approved template with the link (none yet).</p>
        <table className="list compact">
          <thead><tr><th>Name</th><th>AiSensy campaign</th><th>Values, in order</th><th>For</th></tr></thead>
          <tbody>{templates.map((t, i) => (
            <tr key={t.key}>
              <td><input value={t.label} aria-label="Template name" onChange={(e) => editT(i, { label: e.target.value })} /></td>
              <td><input value={t.campaign} placeholder="not approved yet" aria-label="AiSensy campaign" onChange={(e) => editT(i, { campaign: e.target.value })} /></td>
              <td className="small">{d.params.map((p) => (
                <label key={p.key} className="check" style={{ marginRight: "0.5rem" }}><input type="checkbox" checked={t.params.includes(p.key)}
                  onChange={(e) => editT(i, { params: e.target.checked ? [...t.params, p.key] : t.params.filter((x) => x !== p.key) })} />{p.key}</label>))}
                <div className="muted">{t.params.join(", ")}</div></td>
              <td className="small">{t.kind === "payment" ? "payment link" : "appointment"}</td>
            </tr>))}</tbody>
        </table>
        <div className="row"><ErrorNotice error={error} /><span className="grow" />
          <button onClick={() => setTpl([...templates, { key: `template_${templates.length + 1}`, label: "New template", campaign: "", params: ["name", "date"], kind: "appointment" }])}>Add a template</button>
          {tpl && <button onClick={() => setTpl(null)}>Undo</button>}
          <button className="btn-primary" disabled={!tpl} onClick={() => void save({ templates }, "Templates saved")}>Save templates</button></div>
      </div>
    </section>
  );
}

function PaymentsSection() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings-payments"], queryFn: () => api<PaySettings>("/settings/payments") });
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!q.data) return null;
  const d = q.data;
  const vals = f ?? { defaultAmount: String(d.defaultAmount), minAmount: String(d.minAmount), maxAmount: String(d.maxAmount), linkMinutes: String(d.linkMinutes) };
  const save = async (body: unknown, done: string) => {
    setError(null);
    try { await api("/settings/payments", { method: "PUT", body }); toast(done); setF(null); await qc.invalidateQueries(); }
    catch (e) { setError(e); }
  };
  const field = (k: string, label: string) => (
    <label className="field"><span>{label}</span><input className="narrow-input" inputMode="numeric" value={vals[k]}
      onChange={(e) => setF({ ...vals, [k]: e.target.value.replace(/\D/g, "") })} /></label>);
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="grow">Payment links (Razorpay)</h2>
        <span className="muted small">{d.keyMode === "test" ? "Razorpay test keys in .env" : d.keyMode === "live" ? "Razorpay live keys in .env" : d.keyMode ? "Razorpay key in .env not recognised" : "Razorpay keys not set yet (.env)"}</span></div>
      <div className="panel-pad stack">
        <div className="row"><b>Mode</b><ModeSwitch value={d.mode} modes={d.modes} admin={user?.role === "admin"} onChange={(m) => void save({ mode: m }, `Payments: ${m}`)} />
          <span className="small muted">Test: Razorpay test keys, only bookings named TEST. Live: live keys, after cut-over.</span></div>
        {d.problem && d.mode !== "off" && <div className="notice small">{d.problem}</div>}
        <div className="row">{field("defaultAmount", "Usual amount (₹)")}{field("minAmount", "Smallest (₹)")}{field("maxAmount", "Largest (₹)")}{field("linkMinutes", "Link open for (minutes, 15 or more)")}</div>
        <div className="row"><ErrorNotice error={error} /><span className="grow" />
          {f && <button onClick={() => setF(null)}>Undo</button>}
          <button className="btn-primary" disabled={!f} onClick={() => void save(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, Number(v)])), "Payment settings saved")}>Save amounts</button></div>
        <p className="small muted" style={{ margin: 0 }}>Refunds are made by an admin, from the payment in the appointment panel.</p>
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
      <ClinicNameSection name={d.clinicName} />
      <EarlySection data={(d as any).earlyBooking} />
      <section className="panel"><div className="panel-head"><h2>Lists</h2></div>
        <div className="panel-pad settings-cols">{d.lists.map((l) => <ListSection key={l.id} list={l} />)}</div></section>
      <PlansSection plans={d.plans} />
      <WhatsAppSection />
      <PaymentsSection />
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
