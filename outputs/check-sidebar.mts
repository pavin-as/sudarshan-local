import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "file:///C:/Users/Admin/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs";
import { ROLE_PERMISSIONS } from "../server/src/lib/permissions.ts";
const base = "D:/Sudarshan/testdb/web-dist";
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url!, "http://localhost").pathname;
    const file = path.startsWith("/assets/") ? join(base, path) : join(base, "index.html");
    res.setHeader("Content-Type", ({".js":"text/javascript",".css":"text/css",".html":"text/html",".woff":"font/woff",".woff2":"font/woff2"} as any)[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(r => server.listen(8597, "127.0.0.1", r));
const browser = await chromium.launch({headless:true, channel:"msedge"});
try {
  await mkdir("outputs/sidebar", {recursive:true});
  for (const role of [...Object.keys(ROLE_PERMISSIONS), "doctor-finance"]) {
    const permissions = role === "doctor-finance" ? [...ROLE_PERMISSIONS.doctor, "reconciliation.read", "cash.deposit", "adjustments.submit", "books.audit"] : ROLE_PERMISSIONS[role];
    const context = await browser.newContext({viewport:{width:1366,height:768}});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/**", async route => {
      const p = new URL(route.request().url()).pathname;
      const data: Record<string, unknown> = {
        "/api/auth/me":{user:{id:1,fullName:"TEST "+role,role:role === "doctor-finance" ? "doctor" : role,permissions,mustChangePassword:false}},
        "/api/health":{googleMaster:false,lastBackup:new Date().toISOString(),lastBackupStatus:"ok"},
        "/api/appointments":{appointments:[]},
        "/api/direct-calls":{calls:[],counts:{open:3}},
        "/api/cancel-list":{appointments:[],counts:{toCall:2,all:2}},
        "/api/triage":{assessments:[],pending:4},
        "/api/payments":{counts:{review:2}},
        "/api/fundus/sessions":{sessions:[],todo:5},
        "/api/adjustments":{pending:2},
      };
      await route.fulfill({status:p in data ? 200 : 403,contentType:"application/json",body:JSON.stringify(data[p] ?? {message:"Synthetic preview: unavailable"})});
    });
    await page.goto("http://127.0.0.1:8597/calls");
    const nav = page.getByRole("navigation");
    await nav.getByRole("link",{name:/Direct calls/}).waitFor();
    assert.equal(await nav.getByRole("button",{name:/Calls & messages/}).getAttribute("aria-expanded"),"true");
    assert.equal(await nav.getByRole("button",{name:/Finance/}).count(),permissions.some(p=>["payments.write","reconciliation.read","cash.deposit","adjustments.submit","books.audit"].includes(p)) ? 1 : 0);
    assert.equal(await nav.getByRole("button",{name:"Administration"}).count(),permissions.some(p=>["audit.read","settings.manage","users.manage"].includes(p)) ? 1 : 0);
    const toggle = nav.getByRole("button",{name:/Calls & messages/});
    await toggle.focus(); await page.keyboard.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"),"false");
    assert.equal(await nav.getByRole("link",{name:/Direct calls/}).isVisible(),false);
    assert.match(await toggle.innerText(),/5/);
    await page.keyboard.press("Space");
    assert.equal(await toggle.getAttribute("aria-expanded"),"true");
    for (const button of await nav.locator(".nav-section-toggle").all()) {
      if (await button.getAttribute("aria-expanded") === "false") await button.click();
    }
    assert.equal(await nav.getByRole("link",{name:"Users",exact:true}).count(),permissions.includes("users.manage")?1:0);
    assert.equal(await nav.getByRole("link",{name:"Day collection",exact:true}).count(),permissions.includes("reconciliation.read")?1:0);
    assert.equal(await nav.getByRole("link",{name:/Fundus reports/}).count(),permissions.includes("clinical.read")?1:0);
    await nav.getByRole("button",{name:"Log out",exact:true}).scrollIntoViewIfNeeded();
    if (role === "admin" || role === "doctor-finance") {
      for (const button of await nav.locator(".nav-section-toggle").all()) {
        if (!(await button.innerText()).includes("Calls & messages")) await button.click();
      }
      await nav.locator(".nav-menu").evaluate(el=>el.scrollTop=0);
      await page.screenshot({path:"outputs/sidebar/"+role+"-desktop.png",fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
      await page.screenshot({path:"outputs/sidebar/"+role+"-phone.png",fullPage:true});
    }
    if (permissions.includes("clinical.read")) {
      await page.goto("http://127.0.0.1:8597/fundus");
      await nav.getByRole("link",{name:/Fundus reports/}).waitFor();
      assert.equal(await nav.getByRole("button",{name:/Clinical/}).getAttribute("aria-expanded"),"true");
    }
    assert.deepEqual(errors,[]);
    console.log("PASS sidebar:",role);
    await context.close();
  }
} finally { await browser.close(); server.close(); }



