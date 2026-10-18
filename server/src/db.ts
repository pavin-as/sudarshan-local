// Postgres access. Every write goes through withTx(), which tells the audit trigger
// who is acting and why (SET LOCAL app.user_id / app.audit_summary / app.source / app.request_id).
import pg from "pg";
import { config } from "./config.js";

// Return dates and times exactly as stored (no timezone shifting), numbers as numbers.
pg.types.setTypeParser(1082, (v) => v);                 // date        -> 'YYYY-MM-DD'
pg.types.setTypeParser(1083, (v) => v.slice(0, 5));     // time        -> 'HH:MM'
pg.types.setTypeParser(1700, (v) => Number(v));         // numeric     -> number
pg.types.setTypeParser(20, (v) => Number(v));           // bigint      -> number (ids stay far below 2^53)

export const pool = new pg.Pool({
  ...config.pg,
  application_name: "sudarshan-server",
  options: `-c TimeZone=${config.timezone}`,      // "today" and dates are always clinic time
});

export type Db = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(text, params as any[]);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await q<T>(text, params, db))[0];
}

export interface AuditContext {
  userId: number | null;
  requestId?: string;
  source?: "web" | "job" | "cli" | "import";
  summary?: string;
}

/** Run fn in a transaction; the audit trigger records ctx.userId and the summary on every row changed. */
export async function withTx<T>(ctx: AuditContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.audit_summary', $2, true),
              set_config('app.source', $3, true), set_config('app.request_id', $4, true)`,
      [ctx.userId == null ? "" : String(ctx.userId), ctx.summary ?? "", ctx.source ?? "web", ctx.requestId ?? ""]);
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Change the plain-language audit sentence mid-transaction (applies to rows written after this call). */
export async function setAuditSummary(c: pg.PoolClient, summary: string): Promise<void> {
  await c.query("SELECT set_config('app.audit_summary', $1, true)", [summary]);
}
