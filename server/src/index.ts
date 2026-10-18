import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";

const app = await buildApp();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
