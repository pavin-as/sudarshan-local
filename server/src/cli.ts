// Run on shichika for things that must work before anyone can log in.
//   node dist/cli.js list-users
//   node dist/cli.js temp-password <username>             -> prints a one-time password, must be changed at login
//   node dist/cli.js create-user <username> "<Full name>" <role>
//   node dist/cli.js retina-batch [<folder>] [--graded-by <username>] [--dry-run] [--no-move]   -> grade a folder (D-040)
//   node dist/cli.js retina-remidio-import [<folder>] [--dry-run] [--all]   -> keep photographs downloaded from Remidio Connect (D-041)
//   node dist/cli.js retina-eval-external <folder> --labels <csv> [--name <name>] [--out <folder>] [--grader arko|rfm] [--head aptos|messidor|idrid]
//                                                                                -> benchmark on a public dataset (D-043, D-044)
//   node dist/cli.js oct-thickness-sheet [--from yyyy-mm-dd] [--out <file.csv>]  -> CST check sheet to fill from IMAGEnet (D-050)
//   node dist/cli.js oct-thickness-compare [<file.csv>] [--record ILM-BM|ILM-OS/RPE] [--by <name>]  -> agreement (aggregates)
//   node dist/cli.js oct-report-check <report.pdf> [--scan <id>]  -> IMAGEnet's CST from a report printed to PDF, checked against the scan
import { pool, withTx } from "./db.js";
import { hashPassword, temporaryPassword } from "./lib/passwords.js";
import { ROLES } from "./lib/permissions.js";
import { runBatch } from "./services/retinaImport.js";
import { importDownloads } from "./services/remidioImport.js";
import { evaluateExternal } from "./services/evalExternal.js";
import { compareRuns } from "./services/evalCompare.js";
import { screeningReport } from "./services/evalScreening.js";
import { compareCheckSheet, measureMissing, writeCheckSheet } from "./services/octMeasure.js";
import { checkReport } from "./services/octReport.js";

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
    case "retina-eval-external": {
      const labels = option("--labels");
      if (!args[0] || args[0].startsWith("--") || !labels) throw new Error("usage: retina-eval-external <image folder> --labels <labels.csv> [--name <name>] [--out <folder>]");
      await evaluateExternal({ folder: args[0], labels, name: option("--name"), out: option("--out"), grader: option("--grader"), head: option("--head") });
      return;
    }
    case "retina-eval-compare": {
      const runs = args.flatMap((a, i) => (a === "--run" && args[i + 1] ? [args[i + 1]] : [])).map((r) => {
        const at = r.indexOf("=");
        if (at < 1) throw new Error(`--run needs Name=file.csv, got "${r}"`);
        return { name: r.slice(0, at), csv: r.slice(at + 1) };
      });
      const labels = option("--labels");
      if (!labels) throw new Error("usage: retina-eval-compare --labels <csv> --run Name=file.csv --run Name=file.csv [--name <name>] [--out <folder>]");
      compareRuns({ labels, runs, name: option("--name"), out: option("--out") });
      return;
    }
    case "retina-eval-screening": {
      const runs = args.flatMap((a, i) => (a === "--run" && args[i + 1] ? [args[i + 1]] : [])).map((r) => {
        const at = r.indexOf("=");
        if (at < 1) throw new Error(`--run needs Name=file.csv, got "${r}"`);
        return { name: r.slice(0, at), csv: r.slice(at + 1) };
      });
      const validation = option("--validation"), test = option("--test");
      if (!validation || !test || !runs.length) throw new Error("usage: retina-eval-screening --validation <csv> --test <csv> --run Name=file.csv ... [--refer-sensitivity 0.95] [--clear-sensitivity 0.99]");
      screeningReport({ validation, test, runs, name: option("--name"), out: option("--out"),
                        referSens: option("--refer-sensitivity") ? Number(option("--refer-sensitivity")) : undefined,
                        clearSens: option("--clear-sensitivity") ? Number(option("--clear-sensitivity")) : undefined });
      return;
    }
    case "oct-thickness-sheet": {
      let n = 0, step: number;
      do { step = await measureMissing(200); n += step; } while (step > 0);         // measure anything not measured yet
      const r = await writeCheckSheet({ from: option("--from"), out: option("--out") });
      console.log(`${n ? `${n} scan(s) measured now; ` : ""}${r.rows} measured macula scan(s) in ${r.out}${r.filledBefore ? ` (${r.filledBefore} IMAGEnet value(s) kept from before)` : ""}.`);
      console.log("Open it in Excel on shichika, type IMAGEnet's central subfield thickness (µm) in imagenet_cst_um for any rows, save as CSV,");
      console.log("then run oct-thickness-compare. The sheet names patients: keep it on shichika and delete it when the check is done.");
      return;
    }
    case "oct-thickness-compare": {
      const file = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
      const def = option("--record");
      if (def && def !== "ILM-BM" && def !== "ILM-OS/RPE") throw new Error("--record takes ILM-BM or ILM-OS/RPE");
      const r = await compareCheckSheet({ file, record: def as any, by: option("--by") });
      console.log(`${r.filled} row(s) with an IMAGEnet value. Sudarshan minus IMAGEnet, in µm (bias, SD, 95% limits of agreement, mean |difference|, largest, r):`);
      for (const d of ["ILM-BM", "ILM-OS/RPE"]) for (const k of ["all", "cubes", "radial"]) {
        const a = r[d][k];
        console.log(`  ${d.padEnd(10)} ${k.padEnd(6)} ${a ? `n ${a.n}: bias ${a.biasUm}, SD ${a.sdUm}, limits ${a.loaUm[0]} to ${a.loaUm[1]}, mean |d| ${a.maeUm}, largest ${a.maxAbsUm}, r ${a.r ?? "-"}` : "too few"}`);
      }
      if (def) console.log(`Recorded as checked (${def}).`);
      return;
    }
    case "oct-report-check": {
      if (!args[0] || args[0].startsWith("--")) throw new Error("usage: oct-report-check <IMAGEnet report.pdf> [--scan <id>]");
      const scan = option("--scan");
      for (const line of await checkReport(args[0], scan ? Number(scan) : undefined)) console.log(line);
      return;
    }
    default:
      console.log("commands: list-users | temp-password <username> | create-user <username> \"<Full name>\" <role>"
        + " | retina-batch [<folder>] [--graded-by <username>] [--dry-run] [--no-move] | retina-remidio-import [<folder>] [--dry-run] [--all]"
        + " | retina-eval-external <folder> --labels <csv> [--name <name>] [--out <folder>]");
  }
}

main().then(() => pool.end()).catch(async (e) => { console.error("Error:", e.message); await pool.end(); process.exit(1); });
