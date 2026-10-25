import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { startSummaryJob } from "./services/overview.js";
import { startOutreachJobs } from "./services/payments.js";
import { outboxStarted } from "./routes/whatsapp.js";
import { startRemidioJobs } from "./services/remidioReceiver.js";

const app = await buildApp();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
// doctor summaries for the day's patients from 07:00 (local model only; not started by tests, which build the app alone)
const summaryTimer = startSummaryJob(app.log);
// WhatsApp outbox (only what a person queued) and the Razorpay status check (D-034, D-017)
const outreachTimers = startOutreachJobs(app.log);
outboxStarted();
// Remidio photo receiver and grading of new photographs (D-041); does nothing while retina.remidio_mode is "off"
const remidioTimers = startRemidioJobs(app.log);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    clearInterval(summaryTimer);
    for (const t of [...outreachTimers, ...remidioTimers]) clearInterval(t);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
