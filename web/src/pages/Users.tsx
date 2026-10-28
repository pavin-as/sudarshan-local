import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";
import { stamp } from "../format";
import { ChangePasswordDialog } from "./Login";
import { Dialog, ErrorNotice, Loading, useToast } from "../components/ui";

const ROLES: [string, string, string][] = [
  ["staff", "Front desk", "book, reschedule, confirm, follow-up calls"],
  ["counsellor", "Counsellor", "front desk, plus clinical details"],
  ["optometrist", "Optometrist", "sees the board and clinical details"],
  ["doctor", "Doctor", "sees the board, clinical details and summaries; adds remarks"],
  ["manager", "Manager", "everything except users and finance: calendar, capacity, activity log"],
  ["admin", "Admin", "everything, including users and finance"],
];
const roleName = (r: string) => ROLES.find((x) => x[0] === r)?.[1] ?? r;

// D-053: what a login has beyond or below its role, in a word or two for the list
function accessTags(u: any) {
  const p: string[] = u.permissions ?? [];
  const tags: string[] = [];
  if (p.includes("reconciliation.read")) tags.push("Finance");
  else if (p.includes("cash.deposit")) tags.push("Cash desk");
  if (p.includes("adjustments.approve") && u.role !== "admin") tags.push("Approves");
  return tags;
}

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api("/users").then((r) => r.users as any[]) });
  const [changingOwn, setChangingOwn] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [shown, setShown] = useState<{ name: string; username: string; pw: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({ username: "", fullName: "", role: "staff" });

  const reset = async (u: any) => {
    try { const r = await api(`/users/${u.id}/reset-password`, { method: "POST" }); setShown({ name: u.fullName, username: u.username, pw: r.temporaryPassword }); await qc.invalidateQueries({ queryKey: ["users"] }); }
    catch (e: any) { toast(e.message, "err"); }
  };
  const add = async () => {
    setError(null);
    try { const r = await api("/users", { body: form }); setAdding(false); setShown({ name: r.user.fullName, username: r.user.username, pw: r.temporaryPassword }); setForm({ username: "", fullName: "", role: "staff" }); await qc.invalidateQueries({ queryKey: ["users"] }); }
    catch (e) { setError(e); }
  };
  const save = async () => {
    setError(null);
    try { await api(`/users/${editing.id}`, { method: "PATCH", body: { fullName: editing.fullName, role: editing.role, isActive: editing.isActive } }); toast("User saved"); setEditing(null); await qc.invalidateQueries({ queryKey: ["users"] }); }
    catch (e) { setError(e); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Users</h1><div className="muted">Everyone who can log in. Passwords are never shown; give a temporary one and they choose their own.</div></div>
        <span className="grow" /><button className="btn-primary" onClick={() => { setError(null); setAdding(true); }}>Add user</button>
      </div>
      <div className="panel">
        {q.isLoading ? <Loading /> : (<div className="table-wrap">
          <table className="list">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Access</th><th>Login</th><th>Last login</th><th /></tr></thead>
            <tbody>{(q.data ?? []).map((u) => (
              <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                <td><b>{u.fullName}</b>{!u.isActive && <span className="tag">inactive</span>}</td>
                <td>{u.username}</td><td>{roleName(u.role)}</td>
                <td className="small">{accessTags(u).map((t) => <span key={t} className="tag">{t}</span>)}
                  {u.role !== "admin" && Object.keys(u.overrides ?? {}).length > 0 && <span className="muted"> {Object.keys(u.overrides).length} change{Object.keys(u.overrides).length === 1 ? "" : "s"} from role</span>}</td>
                <td className="small">{!u.hasPassword ? <span className="overdue">no password yet</span> : u.mustChangePassword ? "temporary password" : "own password"}</td>
                <td className="small">{u.lastLoginAt ? stamp(u.lastLoginAt) : "never"}</td>
                <td className="right nowrap">
                  {u.id === me?.id
                    ? <button className="btn-small" onClick={() => setChangingOwn(true)}>Change password</button>
                    : <button className="btn-small" onClick={() => void reset(u)}>{u.hasPassword ? "Reset password" : "Give password"}</button>}{" "}
                  <button className="btn-small" onClick={() => { setError(null); setEditing({ ...u }); }}>Edit</button>{" "}
                  <button className="btn-small" onClick={() => setAccess(u)}>Access</button>
                </td>
              </tr>))}</tbody>
          </table></div>)}
      </div>

      {changingOwn && <ChangePasswordDialog onClose={() => setChangingOwn(false)} />}
      {shown && (
        <Dialog narrow title="Temporary password" onClose={() => setShown(null)} foot={<button className="btn-primary" onClick={() => setShown(null)}>Done</button>}>
          <p>Give this to <b>{shown.name}</b> (username <b>{shown.username}</b>). They will choose their own password when they log in. It will not be shown again.</p>
          <div style={{ fontSize: "1.8rem", fontWeight: 700, letterSpacing: "0.06em", textAlign: "center", padding: "0.6rem", background: "#fff", border: "1px solid var(--line)", borderRadius: 8 }}>{shown.pw}</div>
        </Dialog>
      )}
      {adding && (
        <Dialog narrow title="Add user" onClose={() => setAdding(false)} foot={<button className="btn-primary" onClick={() => void add()}>Add user</button>}>
          <label className="field"><span>Full name</span><input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoFocus /></label>
          <label className="field"><span>Username</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.trim() })} placeholder="e.g. fameesha" /></label>
          <RolePick value={form.role} onChange={(role) => setForm({ ...form, role })} />
          <ErrorNotice error={error} />
        </Dialog>
      )}
      {editing && (
        <Dialog narrow title={`Edit ${editing.fullName}`} onClose={() => setEditing(null)} foot={<button className="btn-primary" onClick={() => void save()}>Save</button>}>
          <label className="field"><span>Full name</span><input value={editing.fullName} onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} /></label>
          <RolePick value={editing.role} onChange={(role) => setEditing({ ...editing, role })} />
          <label className="check"><input type="checkbox" checked={editing.isActive} disabled={editing.id === me?.id} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />Can log in</label>
          <ErrorNotice error={error} />
        </Dialog>
      )}
      {access && <AccessDialog user={access} onClose={() => setAccess(null)} onSaved={() => { setAccess(null); void qc.invalidateQueries({ queryKey: ["users"] }); }} />}
    </>
  );
}

// D-053: which pages a login sees and what it may do there. The role gives the defaults; ticking or unticking one
// here changes this login only. Saved changes apply at the login's next click, with no need to log in again.
function AccessDialog({ user, onClose, onSaved }: { user: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const cat = useQuery({ queryKey: ["users-access"], queryFn: () => api<{ permissions: { key: string; page: string; label: string }[]; roleDefaults: Record<string, string[]> }>("/users/access") });
  const [on, setOn] = useState<Set<string>>(new Set(user.permissions ?? []));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const admin = user.role === "admin";
  const defaults = new Set(cat.data?.roleDefaults[user.role] ?? []);
  const changed = (cat.data?.permissions ?? []).filter((p) => on.has(p.key) !== defaults.has(p.key));
  const save = async () => {
    setError(null); setSaving(true);
    try {
      const overrides = Object.fromEntries((cat.data?.permissions ?? []).map((p) => [p.key, on.has(p.key)]));
      const r = await api<{ changed: boolean }>(`/users/${user.id}/access`, { method: "PUT", body: { overrides } });
      toast(r.changed ? `Access for ${user.fullName} saved` : "Nothing changed"); onSaved();
    } catch (e) { setError(e); } finally { setSaving(false); }
  };
  const toggle = (k: string) => setOn((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const finance = (k: string) => ["cash.deposit", "reconciliation.read", "adjustments.submit", "adjustments.approve"].includes(k);
  return (
    <Dialog title={`Access for ${user.fullName}`} onClose={onClose}
            foot={admin ? <button onClick={onClose}>Close</button> : <>
              <button onClick={() => setOn(new Set(defaults))} disabled={!changed.length}>Back to the role's defaults</button>
              <span className="grow" />
              <button className="btn-primary" onClick={() => void save()} disabled={saving || !cat.data}>{saving ? "Saving…" : "Save access"}</button></>}>
      {cat.isLoading ? <Loading /> : cat.error ? <ErrorNotice error={cat.error} /> : (
        <div className="stack" style={{ gap: "0.6rem" }}>
          <p className="small muted" style={{ margin: 0 }}>
            {admin ? "An admin always has every page and action (except writing fundus reports, which only doctors do). Change the role to limit this login."
              : <>{roleName(user.role)} role defaults are marked <i>role</i>. Tick or untick to change this login only.
                {" "}Finance: <b>Cash desk</b> records deposits without seeing Yarago's figures; <b>Finance, full view</b> sees everything (Dr Sameera).</>}
          </p>
          <table className="list compact access-table">
            <thead><tr><th>Page</th><th>Can</th><th /></tr></thead>
            <tbody>{cat.data!.permissions.map((p) => {
              const differs = on.has(p.key) !== defaults.has(p.key);
              return (
                <tr key={p.key} className={finance(p.key) ? "access-finance" : undefined}>
                  <td className="small">{p.page}</td>
                  <td><label className="check" style={{ margin: 0 }}>
                    <input type="checkbox" checked={on.has(p.key)} disabled={admin} onChange={() => toggle(p.key)} />
                    <span>{p.label}</span></label></td>
                  <td className="small nowrap">{defaults.has(p.key) ? <span className="muted">role</span> : null}{differs && <span className="tag alert">{on.has(p.key) ? "given" : "taken away"}</span>}</td>
                </tr>);
            })}</tbody>
          </table>
          {!admin && changed.length > 0 && <div className="small">{changed.length} change{changed.length === 1 ? "" : "s"} from the {roleName(user.role).toLowerCase()} role. Recorded in the activity log.</div>}
          <ErrorNotice error={error} />
        </div>)}
    </Dialog>
  );
}

function RolePick({ value, onChange }: { value: string; onChange: (r: string) => void }) {
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: "0.3rem" }}>
      <legend style={{ fontWeight: 700, fontSize: "0.87rem", marginBottom: "0.3rem" }}>Role</legend>
      {ROLES.map(([k, name, help]) => (
        <label key={k} className="check" style={{ alignItems: "flex-start" }}>
          <input type="radio" name="role" checked={value === k} onChange={() => onChange(k)} />
          <span><b>{name}</b> <span className="muted small">{help}</span></span>
        </label>
      ))}
    </fieldset>
  );
}
