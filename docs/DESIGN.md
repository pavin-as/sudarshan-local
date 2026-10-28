# DESIGN.md - how Sudarshan is put together

Two parts: **system design** (the moving pieces and the rules between them) and **interface design** (how screens look
and read). Decisions behind these are in DECISIONS.md; the database is in SCHEMA.md.

## Part 1: System design

```
 Yarago EMR (MySQL 5.6, read only)
        |  sudarshan_ro, SELECT only
        v
 sync/yarago_sync.py  (service SudarshanYaragoSync: every 150 s + full copy 01:00)
        |
        v
 PostgreSQL 16 "sudarshan"
   yarago   raw mirror            clinical  decoded views         app  Sudarshan's data + audit log
        ^                              ^                               ^
        |                              |  read                         |  read/write via withTx()
        +------------------------------+-------------------------------+
                                       |
                    server/  Fastify API + serves web/dist  (service SudarshanServer, :8484)
                                       |
                    web/  React app in the browser on clinic PCs
```

### Folders

| Folder | Contents |
|---|---|
| `sync/` | The only code that talks to MySQL. |
| `db/migrations/`, `db/views/` | Schema (numbered, idempotent) and views (re-applied after every full copy). |
| `server/src/` | `app.ts` (wiring, errors, static files), `auth.ts` (sessions, permission checks), `db.ts` (`withTx`), `routes/` (one file per area), `services/` (booking and calendar logic), `lib/` (permissions, passwords, time, errors), `cli.ts` (console admin). |
| `web/src/` | `main.tsx` (routes, nav), `auth.tsx`, `api.ts` (fetch + types), `format.ts`, `pages/`, `components/`, `styles.css` (tokens). |
| `scripts/` | Install, update, migrate, import, checks. |
| `legacy/` | Read-only snapshot of the Google app. Reference only. |
| `analysis/`, `modernized/` | Code-modernization plugin output (Claude Code on shichika writes only here). |

### Server rules

1. **One way to write:** `withTx(auditCtx(req, "<plain sentence>"), async (c) => ...)`. Use `setAuditSummary(c, ...)`
   when the sentence depends on data read inside the transaction. Sentences name the patient as
   `Name (MRD)` and dates as `21 Oct 2026 10:20`.
2. **One way to check access:** first line of every handler is `need(req, "<permission>")`. The auth hook already
   rejects anonymous requests and users who must change their password.
3. **Validate every input with zod**; error messages are read by front-desk staff, so write them as plain sentences
   ("That date is in the past"), never codes.
4. **Errors:** throw `HttpError` (`badRequest`, `notFound`, `conflict`, `forbidden`). Booking refusals use
   `BookingRefused` with every problem listed and the nearest free slots.
5. **Booking logic lives in `services/booking.ts`**, runs inside the transaction and takes the per-day advisory lock
   first. Warnings are returned with the result; problems refuse the booking.
   Scheduling rules live in `services/rules.ts` as pure functions over a day's bookings (testable without a database);
   screens ask `POST /api/rules/check` before booking and `GET /api/rules/day` for the board.
6. **Read Yarago only through `clinical.*`** (or `yarago.*` for a simple indexed lookup). Never connect to MySQL.
7. **Dates** are `YYYY-MM-DD` strings and times `HH:MM` in clinic time; `lib/time.ts` has `todayIST()`, `niceDate()`.
   The database connection runs in Asia/Kolkata.
8. Multi-day lists skip the per-booking Yarago live lookup; only single-day boards compute the live stage.

### Appointment life cycle

```
            book (no time)            give a slot
  (new) --------------------> waitlist ------------> booked --confirm--> confirmed
     \---- book with time --------------------------^   |                    |
                                                        |  arrives (Yarago) / mark arrived
                         cancel (reason required)       v                    v
  cancelled <---------------------------------------- booked/confirmed -> checked_in -> completed
      |  restore (choose date/slot)                                        \-> no_show (did not come)
      +--> booked / waitlist
```
Every arrow writes an `appointment_events` row and an audit line.

### Live stage on the board
From Yarago, for the booking's patient on that day: `registered_not_arrived` -> `arrived` -> `optometry` ->
`waiting_for_doctor` -> `with_doctor` -> `done` (or `cancelled_in_yarago`). Bookings for new patients have no stage until
linked to their Yarago record from the appointment panel.

### Doctor summary (D-026)
`services/summary.ts` builds the facts (pure data, each with its Yarago visit) fresh on every request;
`services/overview.ts` asks the local model for the two-line overview from those facts (no name, MRD or ids), keeps it
only if every number in it is in the facts, and stores it in `app.ai_summaries` with the facts and their hash. A
change in the facts (new Yarago data) queues a new overview; the queue runs one at a time. The automatic run is
07:00-09:00 only (`startSummaryJob`, started by `index.ts`, never by tests). A shown overview is logged in
`app.ai_summary_views`. The model is changed with the setting `ai.overview_model`; a prompt change bumps `PROMPT_VERSION`.

### WhatsApp and payment links (D-034)
`services/outreach.ts` holds the off / test / live switch, which bookings test mode may touch and phone cleaning;
`services/whatsapp.ts` the templates, who may get a message (`recipientFor`, pure, with the reason in words), the
preview, queueing and the outbox worker (`deliverQueued`); `services/razorpay.ts` only the Razorpay REST calls;
`services/payments.ts` links, refunds and the once-a-minute check (`pollPayments`). AiSensy and Razorpay sit behind
replaceable transports (`setWhatsAppTransport`, `setRazorpayTransport`) so tests never reach them. A send is always
two steps: a person's request writes `queued` rows in one transaction; the worker claims one row at a time
(`attempts = 1` before the call, so a restart never sends twice) and records the answer. The worker and the check are
started by `index.ts` (`startOutreachJobs`), never by tests, which call them directly. A payment link is made in two
transactions around the Razorpay call, so no lock is held while waiting on the internet. Razorpay errors are
`RazorpayError` (HTTP 502 with Razorpay's words).

### Retina AI, research DR grader (D-040)
`services/retinaAi.ts` holds only the call to the grader container (`POST http://127.0.0.1:7860/api/grade`, raw image body,
file name in `x-file-name`, key in `x-grader-key`; behind `setGraderTransport` so tests never need Docker) and the agreement
figures (pure). `routes/retinaAi.ts` takes the photograph as the raw request body (`image/jpeg` / `image/png`, 40 MB, its own
content-type parser), so no upload library and no temporary file; the photograph lives only in memory for the call.
The grader is unreachable → 503 and nothing saved; an unreadable photograph → a `rejected` row with the grader's words.
`blind=true` saves the AI grade without returning it, so a doctor grades first; `blinded` on a doctor's grade is always worked
out from `dr_grading_views`, never sent by the browser. The console folder import (`cli retina-batch`) is in
`services/retinaImport.ts`. Screen: `pages/RetinaAi.tsx`, tabs Grade a photograph / To grade / Records / Agreement / System,
a "Research use only" notice on every tab and "AI-generated · verify" beside every AI grade.

### Remidio photographs (D-041)
`services/remidio.ts` holds only Remidio's API (behind `setRemidioTransport`) and the photo download (behind
`setPhotoFetcher`; signed `https://storage.googleapis.com` links only, 40 MB, JPEG/PNG bytes checked by the receiver), plus
`photoFromItem` / `stripLinks` (pure). `services/remidioReceiver.ts` runs `pollQueue` (every 60 s, single flight, up to 20
items) and `gradeNewPhotos` (every 30 s, 5 at a time, stops while the grader is down), both started by `index.ts`, never by
tests, which call them directly. Order per item: store files, insert `fundus_photos`, log, then `itemSuccessfullyHandled`.
Failures keep the item at the head; the 10th failure of the same item logs `gave_up` and takes it off. Photographs are
served by `GET /api/retina-ai/photos/:id/image` (paths only from the database, resolved inside the photo folder).
Screens: Retina AI tabs Photographs and System (receiver), thumbnails in To grade and Records; `FundusPhotos` on the patient page.

### Topcon Maestro2 photographs (D-048)
`services/topconImport.ts` runs `pollTopcon` (every 60 s from `index.ts`, single flight, up to 3 exams, oldest first):
- **Which exams:** it lists `<TOPCON_SHARE>\Data\*.fda`, using `pickWaiting` (pure): saved at or after
  `retina.topcon_since`, unchanged for 2 minutes (its `.fds` too), and with no final row in `topcon_import_log`. Names
  already settled are not looked at again while the server runs (`forgetSettledNames()` when the start point moves).
- **Each exam:** copies the `.fda` and `.fds` into a new folder under `TOPCON_WORK_DIR`, runs the exporter (Topcon's tool,
  `-dcm`; its exit code is -1 even on success, so a run counts when it made `.dcm` files), then the converter
  (`scripts/topcon_photo.py` in the isolated Python), and keeps each colour OP photograph like a Remidio one (JPEG,
  thumbnail and the OP `.dcm` in `RETINA_PHOTO_DIR`). The work folder is removed in `finally`.
- **Replaceable in tests:** the exporter and the converter (`setTopconExporter` / `setTopconConverter`).
- **Signing in:** the server runs as SYSTEM, so it signs in to the share with `net use` and the password from `.env`.
  net use's own error text is never passed on, because it can repeat the password.
- **Failures:** the 5th failure of the same exam logs `gave_up`.
- **Grading:** `gradeNewPhotos` grades every `fundus_photos` row whatever its source.
- **Sessions:** Maestro2 photographs form session 0 of their day. Evaluation sets carry `camera` in their criteria.

### Maestro2 OCT / OCTA scans (D-049)
- **Import:** the same pass keeps each exam's OCT (`keepOct`) after its photographs.
  - `EXPORT_FLAGS` = `-dcm -segDcm -enfaceSlabs`.
  - `scripts/topcon_photo.py --oct <dir>` writes the viewer files and reports the OCT's shape.
  - `examRoots()` = the live folder plus `config.topcon.archives` (read recursively, logged as `<label>/<path>`).
  - Exams count as done only with a final log row of this `VERSION`.
- **Backfill window:** `services/backfillWindow.ts` (`windowOpen`, `startOfToday`). `pickWaiting` puts today's exams first
  and past ones only while the window is open; `gradeNewPhotos` holds back past Maestro2 photographs the same way.
- **API:** `routes/oct.ts`, all `clinical.read`: list, detail with `oct.json`'s scan lines, layers and slabs, B-scan JPEG,
  slab PNG, `layers.bin` (int16 ×10, -1 missing, `[B-scans, surfaces, columns]`).
- **Screens:** `components/OctViewer.tsx` (`OctViewer`, `OctScans`). B-scans are fixed-aspect images in physical
  proportion × depth factor; SVG overlays carry the layer lines and scan lines.
- **Sessions:** the To report list leaves out Maestro2-only sessions before `retina.topcon_report_from`.

### Retinal thickness (D-050)
- **Calculation:** `services/octThickness.ts` is pure. `computeThickness(layer grid, spacing, scan lines, eye, protocol)`
  places every sample in mm from the scan's spacing and orients it from its scan lines on the photograph; `sectorOf` gives
  the ETDRS sector, each boundary belonging to one sector.
- **Running it:** `services/octMeasure.ts`:
  - `measureMissing` runs every minute from `startTopconJobs`;
  - `writeCheckSheet` / `compareCheckSheet` back the console commands.
- **API and screens:**
  - `GET /api/oct/thickness?patientId` (points, Yarago injections and vision, check state) feeds
    `components/InjectionResponse.tsx`;
  - `GET /api/oct/studies/:id` carries the scan's thickness for the viewer's ETDRS grid.

### Fundus reports (D-042)
`routes/fundus.ts`: a session is computed, not stored: linked `fundus_photos` grouped by patient, day in clinic time and
`coalesce(remidio_exam_id, 0)`, left-joined to its `fundus_reports` row (the same key). Reads need `clinical.read`, writes
`fundus.report`; answers never carry an AI grade. `services/fundusReport.ts` holds the words for every choice (the API sends
them, so the form and the views use the same words) and `syncReportGrades`, which writes the report's DR grade per eye as
the signer's (or corrector's) `dr_doctor_grades` row on that eye's AI gradings, blinded from `dr_grading_views`; it runs in
the report's transaction and again from `gradeNewPhotos` when a photograph is graded after its report. Screen
`pages/FundusReports.tsx` (page, `PatientFundus` for the patient page, session drawer, report form).

### Retina AI evaluation (D-043)
`services/evaluation.ts` is pure (metrics, seeded patient-level bootstrap, Markdown report, CSV) and shared by the web
routes (`routes/evaluation.ts`, sets of Sampada photographs) and the console (`services/evalExternal.ts`, public
datasets). A model is identified by `dr_gradings.model_sha256`; results list every model that graded the set's photographs,
so a second grader appears without code changes. Method and data needs: AI_EVALUATION.md.

### Silent multi-model grading and screening outcomes (D-046)
`gradeNewPhotos` (`services/remidioReceiver.ts`) loops the graders in `retina.graders` (`activeGraders()` in
`services/screening.ts`): each is a target from `graderTargets()` (`arko`, `rfm` from `RFM_GRADER_URL` / `RFM_GRADER_KEY`)
plus an optional head (`?head=`); the model SHA comes from the grader's `/health` (per head for RFM), and a photograph is
graded once per model SHA. `screeningFor()` turns a grading into refer / uncertain / routine from
`retina.screening_cutoffs`; `routes/retinaAi.ts` adds it to every grading it shows (never to the blinded to-grade list).
The doctor's grade (`my-grade`, and fundus reports through `syncReportGrades`) is written to every model's grading of the
photograph. `routes/evaluation.ts` adds a screening block per model (`evalScreening.ts`; rows clustered by patient code),
with cut-offs from `?validation=<frozen validation set>` or the starting cut-offs.

### Money reconciliation (D-052)
- **Calculation:** `services/reconcile.ts` is pure: `reconcile(input)` (no clock, no database) and `effectsFor(request)`.
  `services/reconData.ts` builds the input from the money views, the Zoho copy, the bank rules, the settings and the effects
  of approved requests (approved, and reversed with their approved reversal, which net to nothing). Pages only show the result.
- **Zoho:** `services/zohoBooks.ts` holds only the REST calls, behind `setZohoTransport`. `allowed()` lets through GETs
  to the Books API and the token refresh, nothing else. `services/zohoSync.ts` copies lines into `app.zoho_*` (single
  flight; `startZohoJobs` every 10 minutes, fetching when the copy is over 2 hours old, 08:00-22:00).
- **Adjustments:** `services/adjustments.ts`.
  - `submit` checks the request against its Yarago record and Zoho line, works out its effects once, and inserts the
    request and its effects in one transaction. An advisory lock serialises the duplicate check. The same `request_key`
    returns the first request.
  - `approve` / `reject` / `withdraw` lock the row and change only a pending one, so a second decision is a 409.
  - An approved reversal marks the original `reversed` and approves its paired replacement in the same transaction.
  - The guard triggers in 0028 back all of this up in the database.
- **Assistant:** `services/reconAssistant.ts` (Ollama, `ai.recon_model`). Its input comes from `modelInput()`: totals and
  statuses with no names, MRDs, bill numbers or bank wording. Its answer passes a number check (`checkNumbers`, which
  allows thousands separators). Ollama down → 503 with plain words.
- **API:** `routes/reconciliation.ts`.
  - `GET /api/recon`, `/detail`, `/zoho-lines` and `/bank-rules`, and `POST /zoho/fetch` and `/assistant`: all
    `reconciliation.read`.
  - `GET /api/recon/search` and `/api/adjustments`, and `POST /api/adjustments`, `/preview`, `/:id/withdraw` and
    `/:id/reverse`: `adjustments.submit`.
  - `POST /:id/approve` and `/:id/reject`, bank rules and settings: `adjustments.approve` (admin).
- **Screens:**
  - `pages/Reconciliation.tsx`: tiles, by method, day by day with a drawer, category and source tables, credits to look
    at, approved adjustments, assistant, bank rules. D-056: every money figure carries its Clinic / Pharmacy & optical
    parts (`sourceOf()` in `reconcile.ts`: a source starting `pharmacy` is pharmacy, the rest clinic); matching stays on
    the combined day and method.
  - `pages/Adjustments.tsx`: the request form with a preview of its effects, the lists, and the drawer with decisions,
    reversal and correction.

### Access per login, cash book, bank fees (D-053)
- **Access:** `lib/permissions.ts` keeps the role defaults and `PERMISSION_INFO` (page and words per permission).
  `effectivePermissions(role, overrides)`: an admin's set is fixed. The session lookup in `auth.ts` reads the login's
  `app.user_permissions` on every request, so `need()` / `needAny()` / `has()` use `req.user.permissions`; never check
  `role` for a permission. Users page: `AccessDialog` (`GET /api/users/access`, `PUT /api/users/:id/access`).
- **Bank fees:** `services/bankFees.ts` is pure: `ratesOn`, `feeOn`, `paymentBand`, `dayBands` (fee range per day and
  method, given to `reconcile()` as `feeBands`) and `feeReport` (days, months, charges, late batches). `reconcile()`
  accepts a credit short by up to the ceiling and reports `bankFee`.
- **Cash book:** `services/cashBook.ts` is pure: `cashBook(input)` (deposit checks, carry, bank match, cash in hand) and
  `deskView(book)`, the only thing a cash-desk login is sent. `reconData.loadCashBook` builds the input;
  `reconcile()` gets the covered days (`cash`) so cash rows say Deposited.
- **API:** `routes/cash.ts`: `GET /api/cash` (cash.deposit or reconciliation.read; the full book only with the latter),
  `POST /api/cash/deposits` (cash.deposit; advisory lock, `request_key`), `POST /api/cash/deposits/:id/void` and
  `PUT /api/cash/settings` (adjustments.approve). `GET/PUT /api/recon/fee-rates` in `routes/reconciliation.ts`.
- **Screens:** `pages/Cash.tsx` (banner in the cash colour, deposit form with a confirm step, desk list or checked book,
  settings); `Reconciliation.tsx` gains the cash tile, "Kept by the bank", and the Bank fees section with rates.
- **Zoho:** `listBankTransactions` reads `Status.All` and `Status.Uncategorized`, newest first, until a page is before
  the period (Zoho ignores date filters), and turns Zoho's ledger side round (`debit` = money in).

### Day collection (D-057)
- **Summary:** `services/collections.ts` is pure: `daySummary(input)` gives totals (by source), methods, service groups
  with items, hours (first to last, empty ones kept; untimed payments counted but not placed), billed against collected,
  discounts and dues of clinic bills, and the day's payments, refunds and lines with patient MRD and name.
- **Data:** `services/collectionsData.ts`: `loadDay()` reads the money views for one day, plus last week's same day (up
  to the same time when it is today); `loadBill()` gives a clinic bill (from the views) or a pharmacy order (order
  lines with `tbl_mst_product` names, after cancellations), with every payment and refund on it.
- **API:** `routes/collections.ts`: `GET /api/collections/day?date=` and `GET /api/collections/bill?source=&key=`, both
  `reconciliation.read`. Never the cash desk: its deposits are blind.
- **Screen:** `pages/Collections.tsx`: headline and source cards, method tiles, service bars, hour bars, "Worth a look",
  the payment list (filtered by the card, tile or hour clicked), a lines drawer and a bill drawer; print hides the
  controls. Source colours are `--src-clinic` and `--src-pharmacy`.

### Books audit (D-054)
- **Checks:** `services/booksAudit.ts` is pure: `booksAudit(input)` returns each check (group, title, target, level,
  due, not due yet, amount, words, items with what to do). Work dated after `today − dueDays` is "not due yet" and
  never colours a check. `weakNarration()` decides a narration is only the bank's text.
- **Repeats:** `splitRepeats()` / `lineShape()` in `reconcile.ts`: a bank line Zoho holds twice counts once wherever
  bank lines are read (`reconData.bankLines`, used by the reconciliation and the cash book).
- **Data:** `services/booksAuditData.ts`: `loadAudit()` (Zoho copies, bank rules, Yarago payments less refunds per day),
  `saveAuditSnapshot()` after each fetch (the Zoho job; the page's fetch), `auditTrend()` (last snapshot of each
  Saturday-to-Friday week). Invoices and expenses count as readable only when the last good fetch copied them.
- **API:** `routes/booksAudit.ts`: `GET /api/books-audit`, `POST /api/books-audit/fetch` (books.audit; reads Zoho from the
  audit's start), `PUT /api/books-audit/settings` (adjustments.approve).
- **Screen:** `pages/BooksAudit.tsx`: score tiles, weekly trend, a table per group with the items behind each check,
  targets (admin), and a print-only sheet (`.audit-sheet`, A4 portrait) of what is due with a box to tick.
- **Zoho:** `listInvoices`, `listExpenses`; a refused read for lack of a scope is `ZohoError.denied`, recorded as -1 in
  the run's counts, and the fetch goes on.

### Adding a feature (checklist)
1. Read DECISIONS.md and COMPLIANCE.md; if the feature conflicts, ask first.
2. Migration (if needed) + SCHEMA.md; audit triggers for new tables.
3. Route with `need()`, zod input, `withTx` writes with a plain sentence.
4. API test in `server/test/api.test.ts` (TESTING.md).
5. Screen following Part 2.
6. CHANGELOG.md entry; STATUS.md tick.

## Part 2: Interface design

**Who and where:** 6-10 front-desk staff, counsellors, optometrists and doctors at a retina clinic, on desktop PCs all
day, often while on the phone with a patient. Many readers are older or tired by evening. The screen must be readable
at a glance and hard to misuse.

### Principles
1. **Legibility first.** Font: **Atkinson Hyperlegible** (designed for low-vision readers by the Braille Institute;
   fitting for an eye clinic), bundled locally. Body 16 px, never below 13 px for secondary text. Tabular figures for
   times and MRDs.
2. **The day is the unit.** The day board (List by default; Time slots shows the time rail with every slot) is the home screen; everything else opens over it
   (appointment panel from the right, booking dialog in the middle) so staff never lose their place.
3. **One bold element per screen.** On the board it is the time rail and each patient's live stage; everything else is
   quiet.
4. **Plain words.** Sentence case, active verbs, buttons say exactly what happens ("Book Tue 21 Oct 10:20",
   "Cancel appointment"), the same word through the flow (the toast says "Booked ..."). No jargon, no codes.
   "Did not come", not "no_show".
5. **Errors give direction.** Say what is wrong and what to do; offer the next free slots instead of "slot taken".
6. **Destructive actions need a reason**, shown inline (cancel asks "Why?") rather than a browser pop-up.
7. **Colour never carries meaning alone**: every status also has a word.

### Tokens (`web/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `--choroid` | #1d3b4f | Navigation, headings |
| `--action` | #0f6b70 | Primary buttons, links, confirmed |
| `--disc` | #f2b43c | Attention: calls due, warnings, booked-not-confirmed edge |
| `--vessel` | #a8321e | Cancel, overdue, errors |
| `--done` | #2f7650 | Completed |
| `--ink` / `--ink-soft` | #17252f / #4e5f6a | Text |
| `--paper` / `--surface` / `--line` | #f3f5f4 / #ffffff / #d6dde0 | Page, panels, rules |
| Radius | 4 px small, 8 px panels | |

Names come from the eye (choroid, optic disc, vessel), so the palette stays specific to the clinic.

### Patterns
- **Appointment card:** left edge colour = status (teal confirmed, amber booked); name bold, MRD beside it; second line
  plan, doctor, age; tags as small labels (VIP, wheelchair, kids, BNI); status word on the right.
- **Free slot:** "Book 10:10" row, dashed, only when "Show free slots" is on.
- **Panels:** title, then facts as a two-column list, then actions at the bottom (primary on the right).
- **Tables** for lists that are scanned (confirmations, follow-ups, users).
- **Toasts** confirm what was done, bottom centre, a few seconds.
- **Today page:** stat tiles on top (a number and what it counts; tiles that lead somewhere are links), then the
  live list on the left and "To do" on the right. Every to-do line is a link to the screen where it is done; the page
  itself changes nothing. Live figures refresh every minute.
- **Sending to patients** (WhatsApp, payment links): a mode banner on every screen that sends ("test mode: ... real
  patients get nothing"); a list of who gets it and why the others do not before the button; the button says how many
  ("Send to 12 patients"), then an inline "Yes, send 12" (no pop-up). Not-delivered messages are listed to call instead.
- **Printed sheets** (huddle): `@media print` hides the menu and buttons; a closing line reminds that the paper holds
  patient names.
- **Rule findings:** a word for the level ("Against rule", "Check", "Note") then the sentence and what to do, with a red,
  amber or plain left edge. Shown before booking (dialog, reschedule), in the board's side panel (notes folded away) and
  as the worst level's word on the card. Never a pop-up.

### Quality floor
Works down to phone width (nav wraps, rail stays readable); visible keyboard focus; respects reduced motion; no
external requests (fonts, scripts) so it works without internet; contrast AA or better.
