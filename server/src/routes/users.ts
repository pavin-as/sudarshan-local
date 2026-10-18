import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditCtx, need, revokeSessions } from "../auth.js";
import { one, q, withTx } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { hashPassword, temporaryPassword } from "../lib/passwords.js";
import { ROLES } from "../lib/permissions.js";

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
  last_login_at AS "lastLoginAt", legacy_username AS "legacyUsername"`;

export async function userRoutes(app: FastifyInstance) {
  app.get("/api/users", async (req) => {
    need(req, "users.manage");
    return { users: await q(`SELECT ${USER_COLS} FROM app.users ORDER BY is_active DESC, full_name`) };
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
