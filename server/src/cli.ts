// Run on shichika for things that must work before anyone can log in.
//   node dist/cli.js list-users
//   node dist/cli.js temp-password <username>             -> prints a one-time password, must be changed at login
//   node dist/cli.js create-user <username> "<Full name>" <role>
//   node dist/cli.js retina-batch [<folder>] [--graded-by <username>] [--dry-run] [--no-move]   -> grade a folder (D-040)
//   node dist/cli.js retina-remidio-import [<folder>] [--dry-run] [--all]   -> keep photographs downloaded from Remidio Connect (D-041)
import { pool, withTx } from "./db.js";
import { hashPassword, temporaryPassword } from "./lib/passwords.js";
import { ROLES } from "./lib/permissions.js";
import { runBatch } from "./services/retinaImport.js";
import { importDownloads } from "./services/remidioImport.js";

const GRADER_DIR = "D:\\classification\\sampada-retinal-ai";
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const [cmd, ...args] = process.argv.slice(2);
const ctx = (summary: string) => ({ userId: null, source: "cli" as const, summary });

async function main() {
  switch (cmd) {
    case "list-users": {
      const r = await pool.query(`SELECT username, full_name, role, is_active, password_hash IS NOT NULL AS has_pw, legacy_username
                                    FROM app.users ORDER BY is_active DESC, role, full_name`);
      console.table(r.rows);
      return;
    }
    case "temp-password": {
      const [username] = args;
      if (!username) throw new Error("usage: temp-password <username>");
      const temp = temporaryPassword();
      const hash = await hashPassword(temp);
      const r = await withTx(ctx(`Temporary password set for ${username} on the server console`), (c) =>
        c.query(`UPDATE app.users SET password_hash = $2, must_change_password = true, is_active = true WHERE username = $1 RETURNING full_name`, [username, hash]));
      if (!r.rowCount) throw new Error(`No user called ${username}. Run list-users.`);
      await pool.query(`UPDATE app.sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id = (SELECT id FROM app.users WHERE username = $1)`, [username]);
      console.log(`\n  ${r.rows[0].full_name} (${username})\n  Temporary password: ${temp}\n  They must choose their own password when they log in.\n`);
      return;
    }
    case "create-user": {
      const [username, fullName, role] = args;
      if (!username || !fullName || !ROLES.includes(role as any)) throw new Error(`usage: create-user <username> "<Full name>" <${ROLES.join("|")}>`);
      const temp = temporaryPassword();
      const hash = await hashPassword(temp);
      await withTx(ctx(`Added user ${fullName} (${role}) on the server console`), (c) =>
        c.query(`INSERT INTO app.users (username, full_name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,true)`, [username, fullName, role, hash]));
      console.log(`\n  Created ${fullName} (${username}, ${role})\n  Temporary password: ${temp}\n`);
      return;
    }
    case "retina-batch": {
      const folder = args[0] && !args[0].startsWith("--") ? args[0] : `${GRADER_DIR}\\ingest\\incoming`;
      await runBatch({ folder, gradedBy: option("--graded-by"), dryRun: flag("--dry-run"), move: !flag("--no-move") });
      return;
    }
    case "retina-remidio-import": {
      const folder = args[0] && !args[0].startsWith("--") ? args[0] : "D:\\Sudarshan\\data\\remidio-import";
      await importDownloads({ folder, dryRun: flag("--dry-run"), all: flag("--all") });
      return;
    }
    default:
      console.log("commands: list-users | temp-password <username> | create-user <username> \"<Full name>\" <role>"
        + " | retina-batch [<folder>] [--graded-by <username>] [--dry-run] [--no-move] | retina-remidio-import [<folder>] [--dry-run] [--all]");
  }
}

main().then(() => pool.end()).catch(async (e) => { console.error("Error:", e.message); await pool.end(); process.exit(1); });
