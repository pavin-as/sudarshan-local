import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { authPlugin } from "./auth.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { calendarRoutes } from "./routes/calendar.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { patientRoutes } from "./routes/patients.js";
import { followupRoutes } from "./routes/followups.js";
import { auditRoutes } from "./routes/audit.js";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.logLevel,
      // never log cookies, passwords or request bodies
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
    genReqId: () => randomUUID(),
    trustProxy: "127.0.0.1",          // Caddy on the same machine
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const problems = err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
      return reply.status(400).send({ error: "invalid_input", message: problems[0], problems });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    const e = err as any;
    if (e.validation || e.statusCode === 400 || e.statusCode === 415) return reply.status(e.statusCode ?? 400).send({ error: "invalid_input", message: e.message });
    if (e.code === "23514" || e.code === "23505") {        // check / unique violation from Postgres
      req.log.warn({ err }, "constraint violation");
      return reply.status(409).send({ error: "conflict", message: "That would break a data rule: " + (e.constraint ?? e.detail ?? "constraint") });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "server_error", message: "Something went wrong on the server. It has been logged.", requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: "not_found", message: `No such address: ${req.method} ${req.url}` }));

  app.get("/api/health", { config: { public: true } }, async () => {
    const r = await pool.query(`SELECT now() AS db_time,
        (SELECT max(finished_at) FROM app.sync_runs WHERE status = 'ok') AS last_sync,
        (SELECT max(last_run_at) FROM yarago.sync_state) AS last_table_sync`);
    return { ok: true, dbTime: r.rows[0].db_time, lastSync: r.rows[0].last_sync, lastTableSync: r.rows[0].last_table_sync };
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(calendarRoutes);
  await app.register(appointmentRoutes);
  await app.register(patientRoutes);
  await app.register(followupRoutes);
  await app.register(auditRoutes);
  return app;
}
