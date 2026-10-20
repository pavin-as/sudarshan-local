import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Dialog, ErrorNotice, useToast } from "../components/ui";

function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true" /><div><b>Sudarshan</b><span>Sampada VR appointments</span></div></div>;
}

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await login(username.trim(), password); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <Brand />
        <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        <ErrorNotice error={error} />
        <button className="btn-primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        <p className="muted small">Forgot your password? Ask the admin for a temporary one.</p>
      </form>
    </div>
  );
}

export function ChangePasswordPage() {
  const { user, refresh, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    if (next !== again) { setError(new Error("The two new passwords are not the same")); return; }
    setBusy(true);
    try { await api("/auth/change-password", { body: { currentPassword: current, newPassword: next } }); await refresh(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <Brand />
        <h2>Choose your own password</h2>
        <p className="muted small">Hello {user?.fullName}. Replace the temporary password with one only you know: at least 8 characters, not containing your username.</p>
        <label className="field"><span>Temporary password</span><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus /></label>
        <label className="field"><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={8} /></label>
        <label className="field"><span>New password again</span><input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></label>
        <ErrorNotice error={error} />
        <button className="btn-primary" disabled={busy}>Save password</button>
        <button type="button" className="btn-quiet" onClick={() => void logout()}>Log out</button>
      </form>
    </div>
  );
}

// Voluntary change from inside the app (nav footer, Users page): asks for the current password first.
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError(null);
    if (next !== again) { setError(new Error("The two new passwords are not the same")); return; }
    setBusy(true);
    try { await api("/auth/change-password", { body: { currentPassword: current, newPassword: next } }); toast("Password changed. Other computers were logged out."); onClose(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Dialog narrow title="Change password" onClose={onClose} foot={<button className="btn-primary" disabled={busy || !current || !next || !again} onClick={() => void save()}>Save password</button>}>
      <label className="field"><span>Current password</span><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus /></label>
      <label className="field"><span>New password</span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
      <label className="field"><span>New password again</span><input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
      <p className="muted small">At least 8 characters, not containing your username.</p>
      <ErrorNotice error={error} />
    </Dialog>
  );
}
