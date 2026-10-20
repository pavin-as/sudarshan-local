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
  ["manager", "Manager", "everything except users: calendar, capacity, activity log"],
  ["admin", "Admin", "everything, including users"],
];
const roleName = (r: string) => ROLES.find((x) => x[0] === r)?.[1] ?? r;

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api("/users").then((r) => r.users as any[]) });
  const [changingOwn, setChangingOwn] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
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
        {q.isLoading ? <Loading /> : (
          <table className="list">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Login</th><th>Last login</th><th /></tr></thead>
            <tbody>{(q.data ?? []).map((u) => (
              <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                <td><b>{u.fullName}</b>{!u.isActive && <span className="tag">inactive</span>}</td>
                <td>{u.username}</td><td>{roleName(u.role)}</td>
                <td className="small">{!u.hasPassword ? <span className="overdue">no password yet</span> : u.mustChangePassword ? "temporary password" : "own password"}</td>
                <td className="small">{u.lastLoginAt ? stamp(u.lastLoginAt) : "never"}</td>
                <td className="right nowrap">
                  {u.id === me?.id
                    ? <button className="btn-small" onClick={() => setChangingOwn(true)}>Change password</button>
                    : <button className="btn-small" onClick={() => void reset(u)}>{u.hasPassword ? "Reset password" : "Give password"}</button>}{" "}
                  <button className="btn-small" onClick={() => { setError(null); setEditing({ ...u }); }}>Edit</button>
                </td>
              </tr>))}</tbody>
          </table>)}
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
    </>
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
