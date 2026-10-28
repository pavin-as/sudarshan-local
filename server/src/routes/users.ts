import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need, revokeSessions } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { hashPassword, temporaryPassword } from "../lib/passwords.js";
import { effectivePermissions, PERMISSION_INFO, PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Overrides, type Permission, type Role } from "../lib/permissions.js";

const roleEnum = z.enum(ROLES as [string, ...string[]]);
const createBody = z.object({
  username: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/, "Use letters, digits, dot, dash or underscore"),
  fullName: z.string().trim().min(1).max(100),
  role: roleEnum,
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
});
const updateBody = z.object({
  fullName: z.string().trim().min(1).max(100).optional(),
  role: roleEnum.optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("")),
  isActive: z.boolean().optional(),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

const USER_COLS = `id, username::text, full_name AS "fullName", role, email::text, is_active AS "isActive",
  must_change_password AS "mustChangePassword", (password_hash IS NOT NULL) AS "hasPassword",
  last_login_at AS "lastLoginAt", legacy_username AS "legacyUsername",
  coalesce((SELECT jsonb_object_agg(p.permission, p.allowed) FROM app.user_permissions p WHERE p.user_id = users.id), '{}') AS overrides`;

const accessBody = z.object({ overrides: z.record(z.enum(PERMISSIONS as [Permission, ...Permission[]]), z.boolean()) });
const label = (p: Permission) => PERMISSION_INFO.find((x) => x.key === p)?.label ?? p;

export async function userRoutes(app: FastifyInstance) {
  app.get("/api/users", async (req) => {
    need(req, "users.manage");
    const users = await q<any>(`SELECT ${USER_COLS} FROM app.users ORDER BY is_active DESC, full_name`);
    return { users: users.map((u) => ({ ...u, permissions: effectivePermissions(u.role, u.overrides) })) };
  });

  // D-053: the list of permissions by page, with each role's defaults, for the access editor
  app.get("/api/users/access", async (req) => {
    need(req, "users.manage");
    return { permissions: PERMISSION_INFO, roleDefaults: ROLE_PERMISSIONS };
  });

  // One login's access: its own changes to the role's defaults (only the differences are kept). Takes effect on the
  // next request; admins always have everything, so an admin's access is not changed here.
  app.put("/api/users/:id/access", async (req) => {
    need(req, "users.manage");
    const { id } = idParam.parse(req.params);
    const { overrides } = accessBody.parse(req.body);
    const cur = await one<{ full_name: string; role: Role; overrides: Overrides }>(
      `SELECT full_name, role, coalesce((SELECT jsonb_object_agg(p.permission, p.allowed) FROM app.user_permissions p WHERE p.user_id = u.id), '{}') AS overrides
         FROM app.users u WHERE id = $1`, [id]);
    if (!cur) throw notFound("User");
    if (cur.role === "admin") throw badRequest("An admin always has every permission: change the role first to limit this login");
    const defaults = new Set(ROLE_PERMISSIONS[cur.role]);
    const wanted = Object.entries(overrides).filter(([p, on]) => defaults.has(p as Permission) !== on) as [Permission, boolean][];
    const before = new Set(effectivePermissions(cur.role, cur.overrides));
    const after = new Set(effectivePermissions(cur.role, Object.fromEntries(wanted)));
    const added = PERMISSIONS.filter((p) => after.has(p) && !before.has(p)), removed = PERMISSIONS.filter((p) => before.has(p) && !after.has(p));
    if (!added.length && !removed.length) return { user: await one(`SELECT ${USER_COLS} FROM app.users WHERE id = $1`, [id]), changed: false };
    const summary = `Access for ${cur.full_name}: ${[...added.map((p) => `+ ${label(p)}`), ...removed.map((p) => `− ${label(p)}`)].join("; ")}`;
    await withTx(auditCtx(req, summary), async (c) => {
      await c.query(`DELETE FROM app.user_permissions WHERE user_id = $1 AND NOT (permission = ANY($2))`, [id, wanted.map(([p]) => p)]);
      for (const [p, on] of wanted)
        await c.query(`INSERT INTO app.user_permissions (user_id, permission, allowed, set_by) VALUES ($1, $2, $3, $4)
                       ON CONFLICT (user_id, permission) DO UPDATE SET allowed = EXCLUDED.allowed, set_by = EXCLUDED.set_by, set_at = now()
                       WHERE app.user_permissions.allowed IS DISTINCT FROM EXCLUDED.allowed`, [id, p, on, req.user!.id]);
    });
    const user = await one<any>(`SELECT ${USER_COLS} FROM app.users WHERE id = $1`, [id]);
    return { user: { ...user, permissions: effectivePermissions(user.role, user.overrides) }, changed: true };
  });

  app.post("/api/users", async (req) => {
    need(req, "users.manage");
    const b = createBody.parse(req.body);
    if (await one("SELECT 1 FROM app.users WHERE username = $1", [b.username])) throw conflict("That username is already taken");
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    const user = await withTx(auditCtx(req, `Added user ${b.fullName} (${b.role})`), async (c) =>
      (await c.query(`INSERT INTO app.users (username, full_name, role, email, password_hash, must_change_password)
                      VALUES ($1,$2,$3,$4,$5,true) RETURNING ${USER_COLS}`,
                     [b.username, b.fullName, b.role, b.email || null, hash])).rows[0]);
    // shown once to the admin, never stored in plain text
    return { user, temporaryPassword: temp };
  });

  app.patch("/api/users/:id", async (req) => {
    const me = need(req, "users.manage");
    const { id } = idParam.parse(req.params);
    const b = updateBody.parse(req.body);
    const cur = await one<any>("SELECT id, full_name, role, is_active FROM app.users WHERE id = $1", [id]);
    if (!cur) throw notFound("User");
    if (id === me.id && (b.isActive === false || (b.role && b.role !== "admin")))
      throw badRequest("You cannot remove your own admin access or deactivate yourself");
    if (cur.role === "admin" && ((b.role && b.role !== "admin") || b.isActive === false)) {
      const admins = await one<{ n: number }>("SELECT count(*)::int AS n FROM app.users WHERE role = 'admin' AND is_active");
      if ((admins?.n ?? 0) <= 1) throw badRequest("Sudarshan needs at least one active admin");
    }
    const what = b.isActive === false ? "Deactivated" : b.isActive === true && !cur.is_active ? "Reactivated" : "Updated";
    const user = await withTx(auditCtx(req, `${what} user ${b.fullName ?? cur.full_name}`), async (c) =>
      (await c.query(`UPDATE app.users SET full_name = coalesce($2, full_name), role = coalesce($3, role),
                         email = CASE WHEN $4::boolean THEN nullif($5, '')::citext ELSE email END,
                         is_active = coalesce($6, is_active)
                       WHERE id = $1 RETURNING ${USER_COLS}`,
                      [id, b.fullName ?? null, b.role ?? null, b.email !== undefined, b.email ?? null, b.isActive ?? null])).rows[0]);
    if (b.isActive === false || (b.role && b.role !== cur.role)) await revokeSessions(id);
    return { user };
  });

  app.post("/api/users/:id/reset-password", async (req) => {
    need(req, "users.manage");
    const { id } = idParam.parse(req.params);
    if (id === req.user!.id) throw badRequest("Use Change password for your own account");
    const cur = await one<any>("SELECT full_name FROM app.users WHERE id = $1", [id]);
    if (!cur) throw notFound("User");
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    await withTx(auditCtx(req, `Gave ${cur.full_name} a temporary password`), (c) =>
      c.query("UPDATE app.users SET password_hash = $2, must_change_password = true WHERE id = $1", [id, hash]));
    await revokeSessions(id);
    return { temporaryPassword: temp };
  });
}
