import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startSummaryJob } from "./services/overview.js";

const app = await buildApp();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
// doctor summaries for the day's patients from 07:00 (local model only; not started by tests, which build the app alone)
const summaryTimer = startSummaryJob(app.log);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    clearInterval(summaryTimer);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
