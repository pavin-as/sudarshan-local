import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COOKIE, auditCtx, createSession, revokeSessions, setSessionCookie } from "../auth.js";
import { one, withTx } from "../db.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/passwords.js";
import { ROLE_PERMISSIONS } from "../lib/permissions.js";

// Brute-force guard: 5 wrong passwords per username+computer in 15 minutes, then wait.
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 5;
const failures = new Map<string, number[]>();
function recentFails(key: string): number[] {
  const now = Date.now();
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}

const loginBody = z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { public: true } }, async (req, reply) => {
    const { username, password } = loginBody.parse(req.body);
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (recentFails(key).length >= MAX_FAILS)
      throw new HttpError(429, "too_many_attempts", "Too many wrong passwords. Wait 15 minutes or ask the admin to reset it.");

    const u = await one<any>(
      `SELECT id, username, full_name, role, password_hash, must_change_password, is_active
         FROM app.users WHERE username = $1`, [username]);
    const ok = await verifyPassword(password, u?.is_active ? u.password_hash : null);
    if (!u || !ok) {
      recentFails(key).push(Date.now());
      if (u?.is_active && !u.password_hash)
        throw new HttpError(401, "no_password", "No password set for this user yet. Ask the admin for a temporary password.");
      throw new HttpError(401, "bad_login", "Wrong username or password");
    }
    failures.delete(key);

    const sid = await createSession(u.id, req);
    await withTx({ userId: u.id, requestId: req.id, source: "web" }, async (c) => {
      // last_login_at is bookkeeping, not worth an audit line
      await c.query("SELECT set_config('app.skip_audit', 'on', true)");
      await c.query("UPDATE app.users SET last_login_at = now() WHERE id = $1", [u.id]);
    });
    setSessionCookie(reply, sid);
    return { user: { id: u.id, username: u.username, fullName: u.full_name, role: u.role,
                     mustChangePassword: u.must_change_password, permissions: ROLE_PERMISSIONS[u.role as keyof typeof ROLE_PERMISSIONS] } };
  });

  app.post("/api/auth/logout", { config: { public: true } }, async (req, reply) => {
    if (req.user) await withTx(auditCtx(req), (c) =>
      c.query("UPDATE app.sessions SET revoked_at = now() WHERE id = $1", [req.user!.sessionId]));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { config: { allowWhilePasswordChangeDue: true } }, async (req) => {
    const u = req.user!;
    return { user: { id: u.id, username: u.username, fullName: u.fullName, role: u.role,
                     mustChangePassword: u.mustChangePassword, permissions: ROLE_PERMISSIONS[u.role] } };
  });

  app.post("/api/auth/change-password", { config: { allowWhilePasswordChangeDue: true } }, async (req) => {
    const u = req.user!;
    const { currentPassword, newPassword } = changeBody.parse(req.body);
    const row = await one<{ password_hash: string }>("SELECT password_hash FROM app.users WHERE id = $1", [u.id]);
    if (!(await verifyPassword(currentPassword, row?.password_hash))) throw badRequest("Current password is wrong");
    const problem = passwordProblem(newPassword, u.username);
    if (problem) throw badRequest(problem);
    if (newPassword === currentPassword) throw badRequest("Choose a password different from the current one");
    const hash = await hashPassword(newPassword);
    await withTx(auditCtx(req, `${u.fullName} changed their password`), (c) =>
      c.query("UPDATE app.users SET password_hash = $2, must_change_password = false WHERE id = $1", [u.id, hash]));
    await revokeSessions(u.id, u.sessionId);           // log out other computers
    return { ok: true };
  });
}
