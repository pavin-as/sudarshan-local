// Sessions: a random id in an HTTP-only cookie, looked up in app.sessions on every request.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { config } from "./config.js";
import { one, pool, q } from "./db.js";
import { HttpError, forbidden } from "./lib/errors.js";
import { effectivePermissions, type Overrides, type Permission, type Role } from "./lib/permissions.js";

export const COOKIE = "sudarshan_sid";

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: string;
  permissions: Permission[];       // the role's defaults with this login's own changes (D-053), read on every request
}

declare module "fastify" {
  interface FastifyRequest { user: SessionUser | null }
  interface FastifyContextConfig { public?: boolean; allowWhilePasswordChangeDue?: boolean }
}

const TOUCH_EVERY_MS = 5 * 60 * 1000;

export async function createSession(userId: number, req: FastifyRequest): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO app.sessions (user_id, expires_at, ip, user_agent)
     VALUES ($1, now() + make_interval(hours => $2), $3, $4) RETURNING id`,
    [userId, config.sessionHours, req.ip, (req.headers["user-agent"] ?? "").slice(0, 300)]);
  return row!.id;
}

export function setSessionCookie(reply: FastifyReply, sid: string) {
  reply.setCookie(COOKIE, sid, {
    path: "/", httpOnly: true, sameSite: "strict", secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600,
  });
}

export async function revokeSessions(userId: number, exceptSessionId?: string) {
  await q(`UPDATE app.sessions SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
          [userId, exceptSessionId ?? null]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// fastify-plugin: the hook must apply to every route, not only routes inside this plugin
export const authPlugin = fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req) => {
    // Refuse writes coming from another web site (the cookie is SameSite=strict too).
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      let host: string | null = null;
      try { host = origin ? new URL(origin).host : null; } catch { host = "invalid"; }
      if (origin && host !== req.headers.host) throw forbidden("Request from another site refused");
    }

    const sid = req.cookies[COOKIE];
    if (sid && UUID_RE.test(sid)) {
      const s = await one<any>(
        `SELECT s.id, s.last_seen_at, u.id AS user_id, u.username, u.full_name, u.role, u.must_change_password,
                (SELECT jsonb_object_agg(p.permission, p.allowed) FROM app.user_permissions p WHERE p.user_id = u.id) AS overrides
           FROM app.sessions s JOIN app.users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`, [sid]);
      if (s) {
        req.user = { id: s.user_id, username: s.username, fullName: s.full_name, role: s.role,
                     mustChangePassword: s.must_change_password, sessionId: s.id,
                     permissions: effectivePermissions(s.role, (s.overrides ?? {}) as Overrides) };
        if (Date.now() - new Date(s.last_seen_at).getTime() > TOUCH_EVERY_MS) {
          // sliding expiry; sessions are not audited
          void pool.query(`UPDATE app.sessions SET last_seen_at = now(), expires_at = now() + make_interval(hours => $2) WHERE id = $1`,
                          [s.id, config.sessionHours]).catch(() => {});
        }
      }
    }

    const cfg = req.routeOptions.config ?? {};
    if (!req.url.startsWith("/api/") || cfg.public) return;
    if (!req.user) throw new HttpError(401, "not_logged_in", "Please log in");
    if (req.user.mustChangePassword && !cfg.allowWhilePasswordChangeDue)
      throw new HttpError(403, "must_change_password", "Please set a new password first");
  });
}, { name: "sudarshan-auth" });

/** Use inside a handler: throws 403 unless the logged-in user has the permission. */
export function need(req: FastifyRequest, p: Permission): SessionUser {
  const u = req.user;
  if (!u) throw new HttpError(401, "not_logged_in", "Please log in");
  if (!u.permissions.includes(p)) throw forbidden();
  return u;
}

/** Use inside a handler: throws 403 unless the logged-in user has at least one of the permissions. */
export function needAny(req: FastifyRequest, ps: Permission[]): SessionUser {
  const u = req.user;
  if (!u) throw new HttpError(401, "not_logged_in", "Please log in");
  if (!ps.some((p) => u.permissions.includes(p))) throw forbidden();
  return u;
}

/** Whether the user has a permission (for showing more or less, never instead of need()). */
export const has = (u: SessionUser | null | undefined, p: Permission) => !!u?.permissions.includes(p);

export function auditCtx(req: FastifyRequest, summary?: string) {
  return { userId: req.user?.id ?? null, requestId: req.id, source: "web" as const, summary };
}
