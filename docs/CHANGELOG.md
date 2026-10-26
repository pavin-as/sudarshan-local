# CHANGELOG.md

Every change that reaches shichika, newest first. Write for Pavin: what changed for the clinic, then technical notes.
Add entries under **Unreleased** while working; `update.ps1 -Message` text should match the entry title.
Dates are when deployed on shichika.

## Unreleased
- **A new patient's story starts with "Booked"**: the temporary-ID remark (D-036) is now written after the booking, not before it (`routes/appointments.ts`); api and outreach tests updated for D-036's temporary ID (story step, `NDC_…` in log sentences), all 6 database tests pass.
- **Maestro2 fundus photographs in Sudarshan** (D-048). Each new Topcon Maestro2 exam's colour fundus photograph is read
  from the ImageNet PC's read-only share, converted on shichika and kept like a Remidio photograph:
  - linked to the patient by SPD number;
  - shown on Fundus reports (one session per patient and day), the patient page and Retina AI > Photographs ("Topcon
    Maestro2", with a camera filter);
  - graded silently by the research models.

  Retina AI > System has a new "Photographs from the Topcon Maestro2" panel: off / peek / on, a start point, and what to
  do with IDs not in Yarago. Evaluation sets now have a camera, and cut-offs are never carried from one camera to the
  other. Setup: after update.ps1, run `scripts\setup-topcon.ps1` (admin).
  - Technical: migration `0024_topcon_photos.sql` (`fundus_photos` source `topcon` with DICOM UIDs, device, protocol,
    exam file and `.dcm`; `topcon_import_log`; settings `retina.topcon_*`; `dr_gradings` source `topcon`).
  - `services/topconImport.ts`, `scripts/topcon_photo.py`, `routes/retinaAi.ts` (topcon status/switch/check-now; photo
    source filter; Remidio counts now Remidio only), `routes/fundus.ts` (session cameras), `routes/evaluation.ts`
    (camera), and grading labelled by camera.
  - Tests: `test/topcon.test.ts` (12, in `npm test`).
- **Isolated test database on shichika** (Pavin, 26 Oct): `scripts\testdb.ps1` (Docker PostgreSQL 16 on 127.0.0.1:55432,
  synthetic data). CLAUDE.md and TESTING.md updated. Fixed the Remidio test: the settings write-back, D-042's photo access,
  and the peek wording ("left eye", not "LE").
- **First Topcon exports checked** (D-047, Step 1). shichika reads OCT_PC through a read-only share, and two of today's exams
  exported to DICOM. The fundus photograph, B-scans, OCTA flow, en face slabs and Topcon's layer surfaces all open. The
  patient ID is the SPD number. Nothing reaches Sudarshan's screens yet.
  - New `scripts\oct_inspect.py` reports technical facts only: identifiers as present or empty, the patient ID as a format.
  - It runs in `D:\Sudarshan\tools\oct-venv` (pydicom 3.0.1, pylibjpeg-openjpeg 2.4.0, Pillow, numpy).
- **Topcon export tool set up on shichika** (D-047, Step 0). The .NET 10 Desktop Runtime 10.0.13 is installed. Topcon's DICOM
  OCT Export Tool 3.0.0.39 is in `D:\Sudarshan\tools\topcon\`. Its temp files and logs go to the admin-only
  `D:\Sudarshan\data\oct\work\`. shichika's Hardware ID for Topcon's licence is `410689457` (US tier now). No patient
  files have been converted yet. RUNBOOK section 13.
- **Plan for Topcon Maestro2 fundus photographs, OCT and OCTA** (D-047). `docs/OCT_PLAN.md` replaces Pavin's notes. Topcon's
  export tool will run on shichika, and the ImageNet PC stays read only. Nothing changes in the clinic yet. Documentation
  only.
- **Retina AI: silent RFM grading of Remidio photographs with a research screening outcome** (D-046). Every new Remidio
  photograph is now graded by Arko007 and by RFM's APTOS and Messidor-2 heads. Records, the grading drawer and the System
  tab show which model graded it and its outcome (Refer / Uncertain: a person decides / Routine), labelled research and
  silent; poor-quality or not-gradable photographs are always Uncertain. The doctor grades a photograph once on To grade
  (one row per photograph) and the grade counts for every model. Evaluation sets get a role (validation / test); a test
  set's results can use cut-offs chosen on a frozen validation set with no shared patient, and each model shows screening
  sensitivity, severe/PDR cleared, specificity, NPV and referral rate with patient-level intervals. Setup: after
  update.ps1, run `scripts\setup-rfm.ps1` (admin) to give Sudarshan the RFM key. Technical: migration
  `0023_multi_model_screening.sql` (unique photograph + model, `eval_sets.purpose`, settings `retina.graders`,
  `retina.screening_cutoffs`); `services/screening.ts`; `gradeNewPhotos` loops the graders; `routes/retinaAi.ts`
  (screening on gradings, model filter, to-grade per photograph, grade shared across models, graders in status);
  `routes/evaluation.ts` (role, disjoint patients, screening per model); fundus report grades are blinded as of the report
  time. Tests: 11 evaluation checks without a database; 1 more Remidio API check (needs a test database).
- **Retina AI evaluation is screening-first** (D-045): refer / uncertain / routine with cut-offs chosen on validation images
  only. New console report `cli retina-eval-screening --validation <csv> --test <csv> --run Name=<csv> ...`
  (`services/evalScreening.ts`): screening sensitivity, severe/PDR cleared, specificity, NPV, referral rate with 95%
  intervals, a two-outcome view and an operating table. First results on APTOS in AI_EVALUATION.md section 5: RFM (APTOS
  head) 99.1% sensitivity at 84.8% specificity; Arko007 has to refer everyone. Tests: 9 evaluation checks without a database.
- **Retina AI: RFM installed as a second research grader; Arko007 labelled unreliable** (D-044). The Retina AI page now
  says above every result that the current model (Arko007) is unreliable (APTOS: misses 3 in 10 eyes needing referral) and
  is kept for research and comparison only. RFM (a retinal foundation model with published DR heads) runs in its own
  container beside it, loaded the safe way (pinned checksums, tensor-only check, `weights_only=True`, no RFM code run);
  it grades nothing in Sudarshan yet. Its licences were checked part by part (AI_EVALUATION.md 4b): fine for research;
  clinical or commercial use needs the head author's permission and legal review. Technical: `graders/rfm/` (app.py,
  Dockerfile, docker-compose.yml); `cli retina-eval-external --grader rfm --head ...`; new `cli retina-eval-compare` (paired
  side-by-side report with false negatives, `services/evalCompare.ts`); `gradeImage`/`graderHealth` take a grader target;
  per-image CSVs keep full score precision; APTOS report wording (images, not patients) and an independent recount.
- **Retina AI > Evaluation: measure the AI properly** (D-043). An admin makes an evaluation set from reported Remidio
  photographs (the doctor's grade of each eye, blinded by default; options for dates, quality and macula-centred only),
  sees how many images and referable eyes it holds, then freezes it. For each model the tab shows referable-DR
  sensitivity and specificity, AUROC, kappa, macro-F1, per-grade recall with 95% intervals and the confusion matrix, with
  plain warnings while the set is too small; "Download report" gives a written report, "Download CSV" one row per image
  without names, MRDs or dates. A console command measures the model on public datasets such as the IDRiD test set. The
  Phase 01 report is in `docs/AI_EVALUATION.md`: the existing model's benchmark cannot be reproduced because none was ever
  published. Technical: migration `0022_eval_sets.sql` (`app.eval_sets`, `app.eval_set_items`, frozen guard);
  `services/evaluation.ts` (metrics, patient-level bootstrap, report, CSV), `routes/evaluation.ts`
  (`/api/retina-ai/eval/...`), `services/evalExternal.ts` (`cli retina-eval-external`); tests: 7 without a database
  (`test/evaluation.unit.test.ts`, in `test:rules`), 3 more API checks in `test/fundus.test.ts`.
- **Fundus reports: doctors report Remidio photographs in Sudarshan** (D-042). New menu item "Fundus reports" lists each
  patient's photo session with its photographs; doctors see how many are waiting. Opening one shows the photographs large
  and the report form: per eye the DR grade, macular oedema and other findings, then referral and comments. Saving signs it
  with the doctor's name; a correction asks why and keeps both names. The patient page's "Fundus photographs" now shows the
  sessions with their reports. Optometrists, counsellors and managers can now see the photographs and reports too (they
  could not before); only doctors write them; the research AI grade stays admin and doctors and never shows on reports.
  The report's DR grades also count as the doctor's (blinded) grades on Retina AI > Agreement. Technical: migration
  `0021_fundus_reports.sql` (`app.fundus_reports`, guard: no delete, corrections need a reason, signer and session fixed);
  permission `fundus.report` (doctor); `routes/fundus.ts`, `services/fundusReport.ts` (`syncReportGrades`, also run by
  `gradeNewPhotos` for photographs graded after the report); `pages/FundusReports.tsx`; photograph routes need
  `clinical.read`; tests 17 without a database, `test/fundus.test.ts` (7, test database, in `npm test`).
- **Retina AI: photographs taken before the receiver was on can be brought in** (D-041). Download the exams in Remidio
  Connect (Exams > Download), then one console command keeps every SPD photograph in Sudarshan with its eye, field and
  quality, linked to the patient and graded like the others (RUNBOOK 12). Tried on one real download: 2 of 2 photographs
  matched. Technical: `cli retina-remidio-import [<folder>] [--dry-run] [--all]` (`services/remidioImport.ts`: unpacks
  Remidio zips with Windows tar into a temporary folder, matches by MRN, day and capture time with `matchDownload` /
  `parseDownloadPath`, keeps with the shared `keepPhoto`); tests 15 without a database, 12 in `test/remidio.test.ts`.
- **Retina AI: fundus photographs arrive from the Remidio FOP by themselves** (D-041). Once switched on, Sudarshan checks
  Remidio every minute, keeps each new photograph on shichika (in the nightly backup), links it to the patient by the SPD
  number typed on the FOP and grades it with the research model. Admin and doctors see the photographs on Retina AI (new
  *Photographs* tab, and in *To grade*, so doctors can grade from the photograph itself) and as "Fundus photographs" on
  the patient page (photographs only, no AI grade). Photos whose number is not in Yarago (e.g. WSD numbers) are kept
  unlinked or not kept, as set on Retina AI > System, where an admin also switches the receiver off / peek / on.
  Technical: migration `0020_remidio_photos.sql` (`app.fundus_photos`, kept for good with link-once; `app.remidio_queue_log`;
  `dr_gradings.photo_id`; source `remidio`; settings `retina.remidio_mode`, `retina.remidio_unmatched`); `services/remidio.ts`
  (API, signed-link download from storage.googleapis.com only), `services/remidioReceiver.ts` (`pollQueue` every 60 s,
  `gradeNewPhotos` every 30 s, started by `index.ts`); routes `/api/retina-ai/photos`, `/photos/:id/image`, `/remidio`,
  `/remidio/check-now`; `scripts/setup-remidio.ps1` (tokens from the clipboard and Remidio's collection into `.env`, photo
  folder); `backup.ps1` copies the photo folder; `remidio-api-trial.ps1` (read-only trial, 25 Oct). 0019 now narrows the
  source list only once. Tests: 13 without a database, `test/remidio.test.ts` (11, test database, in `npm test`).
- **Retina AI: the September test records are removed.** The 4 records copied from the old grader on 25 Oct were random
  fundus photographs used to try it, with made-up MRDs, not patients (Pavin). They are removed from Sudarshan (the removal
  shows in the activity log), and `scripts\remove-retina-test-data.ps1` deletes the grader's old test databases and the log
  lines with typed names. Retina AI starts empty; the first real records will be photographs from Remidio (SPD numbers).
  The "copy the old records" command is gone. Technical: migration `0019_retina_remove_test_records.sql` (deletes
  `source = 'legacy_import'`, drops `legacy_record_id`, source now `upload` / `batch` only); `importLegacy` and
  `cli retina-import-legacy` removed; the grader makes no `records.db` while `LEGACY_UI=0`; `retina-batch` reads a bare
  number as an SPD number (`normaliseMrd()`, as patient search); Retina AI reads added to `test/real-data.ts`; tests 10 + 16.
- **Retina AI (research): diabetic retinopathy grade from a fundus photograph, for admin and doctors** (D-040). A new "Retina AI"
  page sends a photograph to the research model already installed on shichika and keeps the result in Sudarshan, linked to the
  Yarago patient. Five tabs: *Grade a photograph* (find the patient, choose the eye and the photo; tick "give my own grade first"
  to see the AI grade only after yours), *To grade* (photographs you have not graded, without the AI grade), *Records* (every
  grading, search by MRD or name and dates, remarks), *Agreement* (how often the AI matches doctors' blinded grades: same grade,
  within one, kappa, referable DR found / missed) and *System* (is the grader running). Every screen says it is research use
  only; the grade never goes into the patient's record, summaries or follow-ups. Managers and front desk do not see the page or
  the grades (the activity log shows only that a grade was set). The grader's old page on port 7860 is switched off and no
  longer reachable from other PCs. Folder grading and copying the old grader's records run on the server console (RUNBOOK 12).
  Technical: migration `0018_retina_ai.sql` (`app.dr_gradings` append-only by trigger, `app.dr_doctor_grades`,
  `app.dr_grading_views`); permission `retina_ai.use` (admin, doctor); `routes/retinaAi.ts`, `services/retinaAi.ts`,
  `services/retinaImport.ts`, `pages/RetinaAi.tsx`; `cli retina-batch`; `.env` `RETINA_AI_URL`,
  `RETINA_AI_KEY` from `scripts/setup-retina-ai.ps1`; 413 "too large" answer in the error handler. Grader
  (`D:\classification\sampada-retinal-ai`, not in git): `POST /api/grade` with a shared key, `inference.validate_bytes()`,
  port `127.0.0.1:7860`, `LEGACY_UI=0`, log lines without names or phones; `model_guard.py` fixed (it had refused the
  model since 21 Sep: Keras 3 settings objects were taken for unknown layers; pinned SHA-256 unchanged). Tests: `test/retina.unit.test.ts` (9, in
  `test:rules`), `test/retina.test.ts` (15, test database, in `npm test`).
- **Appointment panel: "What happened" is readable for imported bookings.** The old Google-app history used to show as a
  block of raw code (`[{"timestamp":...}]`). It now shows one line per step, e.g. "22 Oct, 18:31 Appointment created for
  BABY OF HRIDYA (syamili@sampada)" and "Check-in time updated from 16:20 to 16:40". Technical: `historyLines()` in
  `AppointmentDrawer.tsx` parses the stored Journey / RescheduleHistory text; text that is not JSON still shows as before.
- **Settings: clinic name.** A "Clinic name" box (managers and admins) sets the name shown in payment links. It replaces the
  field that sat with the removed follow-up call scripts; the saved value is kept. Technical: `PUT /api/settings/clinic-name`
  (setting key `followup.clinic_name`, unchanged so `payments.ts` still reads it); default "Sampada".
- **Babies' ages in days and months, not "0".** A patient under one year old now shows as "12 days", "1 month 10 days" or
  "5 months 21 days" (from the date of birth in Yarago). It shows on the Patients groups (ROP), patient search, patient page,
  doctor summary, Today, the day board and appointment panel, booking dialog, huddle sheet and the day print. From the first
  birthday it is years as before. A booking made for a baby who is not yet linked to a Yarago record has only the age
  typed in, so it still shows that number. One patient aged 0 has no date of birth in Yarago and still shows "0".
  Technical: `clinical.age_text(dob)` and the new last column `age_text` of `clinical.patient` (views/10_clinical.sql);
  `ageText` in the API where the age is shown (null from one year old); `APPT_AGE_TEXT` in `lib/text.ts` for queries on
  `app.appointments`. The doctor-summary facts carry `ageText` only for babies, so other patients' cached summaries are not regenerated.
- **Patients: a card for each group, with lists you can print** (D-039). Under the search bar there are now cards for ROP,
  Injection, Laser, Diabetic retinopathy, Glaucoma, Squint, Myopia, Low vision and Other retina, each with its count.
  Click a card to see its patients (50 at a time, "Show more"), find a name or MRD inside the list, sort by most recent or
  name, and **Print** (the whole list, A4 landscape; "Save as PDF" in the print window). Printing is recorded in the
  activity of prints (who, which list, how many). The cards are for doctors, optometrists, counsellors, managers and admins
  (clinical access); front desk still has the search bar. **Low vision** = best-corrected vision in the better eye worse
  than 6/18 (WHO, confirmed by Dr. Sameera) or booked for low vision. **The lists are rebuilt every night**, so a diagnosis
  entered today appears tomorrow; the page says when they were last rebuilt. Technical: migration 0017
  (`app.patient_group`, `app.refresh_patient_groups()`), called by `sync/yarago_sync.py` after the analytics rebuild;
  `routes/patientGroups.ts` (`GET /api/patient-groups`, `/api/patient-groups/:key`); `components/PatientGroups.tsx`;
  `lib/text.ts` holds the wording helpers shared with the follow-up board. `test/real-data.ts` prints the card counts.
- **Follow-up calls: Print / Save as PDF.** A **Print** button beside the view buttons prints the list you are looking at
  (the team card and the To call / Due this week / All overdue choice), on A4 landscape with a heading that names the team,
  the view, the date and the number of patients. The cards, buttons and Call column are left out. In the print window,
  choose "Save as PDF" as the printer to get a PDF. The page now loads up to 500 patients (was 300) so a long list prints
  whole; if a list is longer, the heading says "the first 500". Technical: `web/src/pages/Followups.tsx`, print rules in `styles.css`.
- **Follow-up call scripts removed** (D-038). The call dialog no longer shows "What to say", and Settings no longer has
  "Follow-up call scripts" (they did not match what the cards show). Dr. Sameera confirmed that "Mature Retina" means
  ROP treatment is over, so the ROP card rule stays as built. Technical: removed `fillScript`/`DEFAULT_SCRIPTS`/`TIER_WORDS`,
  `GET`/`PUT /api/followups/scripts` and `ScriptsSection`; rows no longer carry `script` or `tierWords`. The saved texts and
  `followup.clinic_name` stay in `app.settings` (payment links still use the clinic name; it can no longer be edited in the app).
- **Follow-up calls: one card per team** (D-038). The cards are now ROP, Injection, Laser, Diabetic retinopathy, Other
  retina and Routine, plus "All patients" (each counted once). Each number is the patients of that team who are overdue
  and still need a call; hover a card for its rule. A patient can be on more than one card. Before, the first card
  ("Urgent", 56) mixed ROP, injection and detachment patients. The ROP card has 32 babies on real data; a baby leaves it
  when the last ROP visit shows a mature retina or 12 months pass without one, and ROP is not cut off by "Overdue up to".
  Technical: `groupsFor` and `GROUPS` in `services/followupRisk.ts`, `?group=` replaces `?tier=` on `GET /api/followups`
  (response `groups` replaces `tiers`); two new rule checks in `test/followups.test.ts`; `test/real-data.ts` prints the
  card counts and now switches its temporary login off instead of deleting it (the delete failed on a foreign key).
- **Today: fewer wrong "without a booking" and no more "can't tell"** (D-036). Four patients who booked under a
  slightly different spelling (Saidali / Saidalavi, Zainaba / Sainaba, Mymoona / Maimoona, B/O Hamnath) were counted as
  walk-ins; near spellings now match when the mobile number is the same. A new patient's booking that nobody matches is
  simply "not arrived yet". Technical: `nameScore` (edit distance, 0.7) in `services/arrivalMatch.ts`.
- **Plan: Sudarshan replaces Yarago, with queue management** (D-037). Recorded in PLAN.md and DECISIONS.md; nothing
  changes for staff yet. The temporary NDC ID is only a booking-time label; the SPD number starts the patient's history.
- **New patients get a temporary ID, and Today counts "without a booking" correctly** (D-036). A booking for a new
  patient is now saved as `NDC_20261012_135440_117` (booking date and time in IST, then the booking number) instead of
  waiting for an SPD number, so no-shows never use up a real MRD. On Today, a patient who booked earlier but has no MRD
  yet is matched by MRD, or by mobile number and name, and counts as booked ("not linked yet" is shown beside the time);
  only a patient with no appointment made before today is "without a booking". The booking search finds a temporary ID
  by any part of it. Technical: `services/tempMrd.ts`, `services/arrivalMatch.ts`, `routes/today.ts`,
  `POST /api/appointments`; new `test/arrival.unit.test.ts` (in `test:rules`). The API test (writes) was not run on shichika.
- **The day board opens in List view.** "Time slots" (the time rail with every slot) shows when you click it; the
  buttons now read List, Time slots. Technical: default `view` in `web/src/pages/Board.tsx`.
- **Payment links are open 15 minutes** (D-035), not 24 hours; after that Razorpay will not take payment on the link.
  Settings shows "Link open for (minutes, 15 or more)". Technical: migration 0016 (setting `payments.link_minutes`
  replaces `payments.link_hours`); `expire_by` is now + minutes + 30 s; the outreach test checks the expiry and the
  15-minute floor.
- **Change your own password.** "Change password" in the menu footer (asks for the current password, then the new one
  twice); on the Users page your own row shows "Change password" instead of "Reset password", which logged you out.
  Resetting your own account through the API is now refused. Other computers are logged out after a change.
  Technical: `ChangePasswordDialog` in `web/src/pages/Login.tsx`; guard in `POST /api/users/:id/reset-password`.
- **WhatsApp reminders and payment links, in test mode** (D-034). New **WhatsApp** page: pick a day, see every booked
  patient and whether they would get the reminder (and why not: no phone, landline, already sent, test mode), then
  "Send to 12 patients" and "Yes, send 12". The history shows what was sent and what did not arrive (call those
  patients), beside the Google app's own sends. In the appointment panel: send one reminder, make a **Razorpay payment
  link** (amount, the patient's mobile read back and ticked), copy it, send it from WhatsApp on the PC or through
  AiSensy, "Check payment now", cancel it; an admin can refund. New **Payments** page (open, paid, to check). Settings:
  off / test / live for each, test numbers, templates (AiSensy campaign names), amounts. **Test mode until cut-over:**
  only bookings named TEST, WhatsApp only to the test numbers, Razorpay test keys only; live is refused before cut-over
  and only an admin can choose it. A payment does not change the booking (P-5).
  Technical: migration 0015 (`app.broadcasts`, `app.payment_refunds`, columns on `messages` and `payments`, settings
  `messaging.*`, `payments.*`), `services/outreach.ts`, `whatsapp.ts`, `razorpay.ts`, `payments.ts`, routes
  `whatsapp.ts`, `payments.ts`, permissions `messages.send`, `messages.broadcast`, `payments.write`, `payments.refund`;
  outbox every 5 s and Razorpay check every minute started by `index.ts`; `.env` `AISENSY_API_KEY`, `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`. Tests `test/outreach.test.ts` (18) and `test/outreach.unit.test.ts` (7).
- **Tests:** the API test runs again after D-029/D-030 and the Today change (early-booking bands set for its days, print
  log cleaned up, Today's new fields); `server/test/yarago_stub.sql` builds an empty Yarago mirror for a test database
  in a workspace without shichika's schema file.
- **What we owe wholesalers, on the Pharmacy dashboard** (D-033): amount owed now, open invoices, oldest open invoice,
  amount settled in the last 30 days, balance per wholesaler and the list of open invoices (oldest paid first). Live as
  of the last sync: the pharmacy purchase and payment tables now sync every 150 seconds.
- **Fix: pharmacy purchases were shown at selling value.** Yarago's purchase line total is unit selling price x
  quantity; purchases are now the invoice amount (12 months: Rs 30.1 lakh, not Rs 53.1 lakh).
  Technical: migration 0014 (views `analytics.wholesaler_invoice`, `wholesaler_balance`, `wholesaler_open_invoice`;
  `fact_pharmacy_purchase.selling_value`; `refresh_pharmacy()` at invoice value); three tables added to `HOT_TABLES`.
- **Metabase "Pharmacy" dashboard** (D-032): pharmacy sales last month, purchases, bills and average bill; sales per month
  by category; sales and purchases per month; sales by manufacturer; purchases by wholesaler; top 25 medicines (with
  manufacturer, quantity, share and patients); which wholesaler supplies which manufacturer; manufacturers bought vs
  sold; medicines bought in the last 6 months but not sold in 90 days. Rebuilt nightly.
  Technical: migration 0013 (`analytics.dim_medicine`, `dim_wholesaler`, `fact_pharmacy_sale`, `fact_pharmacy_purchase`,
  `analytics.dmy()`, `analytics.refresh_pharmacy()`), nightly step in `sync/yarago_sync.py`, `PHARMACY` in
  `scripts/metabase_dashboards.py`.
- **Waiting list size** (D-031), as in the Google app: a day's waitlist holds at most 15% of its slots, rounded up
  (6 on a 38-slot day, 3 on a 15-slot day). The Waitlist button shows "5/6" and turns amber when full, with a notice;
  a booking without a time on a full list is refused, a manager can add anyway with a reason, a patient already waiting
  keeps their place. The day board's waitlist shows "n of 6 places". Admins change the percentage on Settings.
- **Early booking limit** (D-030), as in the Google app: far-ahead days can only be filled to a share of their slots
  (10+ days 51%, 5-9 days 79%, 4 days 85%, 1-3 days 95%, same day 100%). An amber notice with the unlock table appears as
  soon as a held day is chosen when booking or rescheduling; held days show "held" on the date strips. A booking over
  the limit is refused; a manager can book anyway with a reason. The waitlist and a change of time on the same day are
  not limited. Admins change the bands on Settings. The reschedule panel now also offers managers the override for a
  full day, a taken slot or a held HFA slot (the server accepted it; the screen did not show it).
  Technical: `services/earlyBooking.ts`, check in `checkPlacement`, `early` on day info, `PUT /api/settings/early-booking`;
  6 new checks in `npm run test:rules`, an API test step.
- **Today: two boxes whose numbers add up** (Pavin, 19 Oct: "11 arrived and 13 checked out is confusing"). Before, some
  figures counted only booked patients and others everyone in Yarago. Now: *Booked for today* = arrived + not arrived
  yet + can't tell (booking not linked to a Yarago patient); *Came to the clinic today* = with a booking + without a
  booking, and = seen and gone + still in the clinic, one row per patient from Yarago. **Every number opens the list of
  those patients** (MRD, age, booked slot, check-in, check-out or where they are now, time in clinic, doctor, plan;
  booked lists add the phone and arrival). The in-clinic list matches the count (the 10-hour cut-off is gone).
  Technical: `/api/today` returns `came` and `booked` lists; `Drawer` gains `wide`.
- **Fix: patients shown "in clinic" after Yarago checked them out.** Yarago can open two appointments for one patient on
  one day (checked in on the first, checked out on the second; 8% of patient-days in the last 90 days have two or more,
  many of them a same-day injection or laser). Today and the day board now follow the patient's day: the most advanced
  Yarago appointment and all of that day's station timers; done once any of them is checked out or completed.
  Reported by Pavin for a patient on 19 Oct. A patient who returns for a second visit after checking out shows as done.
- **Print and Print POA on the day board** (D-029), as in the Google app's Day Overview: the day list sorted by consult
  start or check-in time, with "adjust for doctor's late arrival" (enter the doctor's actual start; every consult
  start moves by the delay, planned time struck through), and the list grouped by plan of action. Counts and the
  plan-of-action breakdown at the top; rule notes after the day list. A4 landscape; every print is recorded.
  Technical: migration 0012 (`app.print_log`), `POST /api/print/day` (`preview` is not logged), `web/src/pages/DayPrint.tsx`
  (`/print?date=&kind=day_consult|day_checkin|poa[&start=HH:MM][&noprint=1]`); trial banner hidden in print.
- **EMR completeness page** (`/emr-completeness`, menu "EMR completeness", D-028): for each item on Yarago's optometry
  and doctor screens and the injection record, the share of consultations where it was recorded, for each of the last
  6 months and the last 12 months, against the SOP targets; all visits, new patients or review visits. Rebuilt nightly.
  Technical: migration 0011 (`analytics.emr_completeness`, `analytics.filled()`, `analytics.refresh_emr_completeness()`,
  setting `emr.targets`), nightly step in `sync/yarago_sync.py`, `routes/emr.ts`, `web/src/pages/EmrCompleteness.tsx`.
- **Follow-up board ranked by clinical risk** (D-027): Urgent (injection in the last 6 months, ROP, detachment), High
  (recent laser, retinal disease under care), Monitor (diabetes, conditions to watch), Routine. Counts per tier at the
  top (click to filter), the reasons beside each patient, a filled-in call script in the call dialog, and how many came
  back after a call. Scripts are edited on Settings > Follow-up call scripts.
  Technical: `services/followupRisk.ts`, `GET/PUT /api/followups/scripts`, ranked `GET /api/followups` (tier, reasons,
  script; `tiers`, `cameBackAfterCall30d`); 6 new checks in `npm run test:rules`.
- **Roles from the Login sheet**: "Opto" is now Optometrist (6 users) and "reception" Front desk; a role set on the
  Users screen is no longer overwritten once the person has a Sudarshan password.
- **Doctor summary** (`/patients/<id>/summary`, D-026), in the layout Dr. Sameera agreed: today's booking, a two-line
  overview written by the local model (labelled "AI-generated · verify", shown only when every number in it is in the
  facts), alerts, findings by eye, vision and pressure, treatment, last visit; every date opens that Yarago visit.
  Prepared for the day's patients from 07:00; opened from the patient page or the appointment panel ("Doctor summary").
  Doctors, optometrists, counsellors and managers see it (clinical access). Every view is logged.
  Technical: `services/summary.ts` (facts), `services/overview.ts` (Ollama, number check, 07:00-09:00 job, one-at-a-time
  queue), `routes/summary.ts`, migration 0010 (audit on `ai_summaries`, `facts_hash`, `checked`, settings
  `ai.overview_model`, `ai.overview_at`), `web/src/pages/DoctorSummary.tsx`; 4 new checks in `npm run test:rules`.
- **EMR data completeness report** for the clinical staff SOP (shared page "EMR data completeness: what to record at
  every visit"): what the optometry and doctor screens leave empty, from 9,118 completed visits.
- **Trial refresh from the Google app** (D-025): every 15 minutes 07:00-21:00 and at 23:30, Sudarshan copies the Google
  app's bookings, cancel list, direct calls, triage and clinic calendar (`scripts/refresh-from-google.ps1`, about 25 s;
  log `logs/import.log`). Records keep their Sudarshan id from one copy to the next. While the trial lasts these are
  read-only in Sudarshan (a plain message says to change them in the Google app) and a banner at the top shows when
  they were last copied. Settings, rules and plans of action are no longer overwritten by the import.
  Technical: importer updates by Google ID (no delete and re-insert), `--scheduled`, read-only Google scopes; migration
  0009 (`trial.google_master`); `lib/trial.ts` guards on appointment, cancel-list, direct-call, triage and calendar
  writes; `fromGoogle` on list rows; `/api/health` gives `googleMaster`, `lastImport`; API test step for the guard.
- **HFA slots are held** for HFA patients until 2 days before the day: a booking with another plan is refused before
  then (the booking dialog says so in red and does not suggest those slots); a manager can book with a reason.
- **Reserved slot blocks as warnings** (rule 17): a booking whose visit type is ROP, injection, laser, dilation, urgent
  new or emergency is warned when it is outside that type's time; other bookings may use those slots, as in the Google app.
- **Plans of action in words** on the board list, cards, appointment panel, confirmations, patient page, cancel list and
  huddle sheet ("REF, DIL, OCT (left eye)" instead of `["REF","DIL","OCT (LE)"]`); the edit box shows the plain list.
- **Patient search by MRD number**: "12345", "spd12345" and "SPD 12345" all find SPD12345 first.
- **Bookings without a time** in the Google app are now waitlist (27 imported at 00:00 corrected; importer fixed).
- Direct calls: old patients can be logged by every role (confirmed).
  Technical: `services/reserved.ts`, `isKind` + rule 17 in `services/rules.ts`, HFA hold in `services/booking.ts`,
  migration 0008, `planText` in `web/src/format.ts`; 34 rule checks, API test step for the hold. D-024.
- **Settings** (`/settings`, managers and admins): the scheduling rules (switch each on or off, change its numbers, with
  the Google app's default shown where it differs), the booking grid (slot length, first slot, end of day), the visit
  and patient type lists, and the plans of action (preparation and consultation minutes, priority, hide/show). Every
  change goes to the activity log. The Google app's reserved slot blocks (HFA, injection, laser, ROP, dilation,
  emergency) are shown for reference. Fixed on the way: the visit-type list was one comma-joined line, so the booking
  dialog offered it as a single choice. Not carried over: the API-key page (secrets stay in .env) and maintenance mode.
  Technical: `routes/settings.ts`, `RULE_FIELDS` / `RULE_SWITCH_LABELS` in `services/rules.ts`, API test steps.
- **Month view** (`/month`): the month as a Monday-Sunday calendar; each day shows booked of maximum slots (red when
  over), waitlist, new patients, injections / lasers / ROP / HFA / AT-Gonio planned, and scheduling-rule warnings for
  days still to come; month totals on top; a click opens the day board. Technical: `routes/month.ts`, `pages/Month.tsx`.
- **Triage** (`/triage`): the Google app's seven urgency questions, word for word, with the result shown as the
  answers are picked (any serious answer = Emergency, else any moderate = Urgent, else Not urgent). Save, then book
  straight away (the booking dialog opens with the urgency set; the decision "Booked: today / tomorrow / later date"
  is recorded by itself) or record another decision. Pending assessments are listed first, emergencies at the top; the
  menu shows how many wait. All 212 imported assessments score exactly as the Google app scored them.
  Technical: `services/triage.ts` (questions, scoring), `routes/triage.ts`, `test/triage.test.ts` (7 checks, in
  `npm run test:rules`), API test steps.
- **Direct calls** (`/calls`): log a phone call (Yarago patient or new patient, appointment or enquiry, referral,
  urgency, what they said), then book it straight from the call (the booking dialog opens with the caller's details)
  or close it with a reason (enquiry answered / did not want an appointment); closed calls can be opened again.
  Open calls are listed emergencies first, then longest waiting. The 63 calls open in the Google app are there.
- **Cancel list** (`/cancelled`): cancelled bookings to call back - log each call with a call-again date, rebook
  (Restore), or take the booking off the list with a reason; cancelling can set a call-back date. Shows when a patient
  already has a new booking. Holds the same 61 bookings as the Google app's cancel sheet (archived and old_cancel rows
  are off the list). Menu shows how many calls and call-backs are waiting; the Today page counts them too.
  Technical: migration 0007, `routes/directCalls.ts`, `routes/cancelList.ts`, cancel accepts `callbackOn`, importer
  fills call-back date and cancel-list state; API test steps for both lists.
- **Today** page (first menu item): who is in the clinic right now and for how long (longest first, live from Yarago's
  station timer), patients who arrived without a Sudarshan booking, the next 7 days against maximum slots, and the work
  waiting (confirmation calls, follow-up calls, waitlists, scheduling-rule warnings) with links to where it is done.
  **Huddle sheet** (`/huddle`): the next open day on one printable page - summary (booked, new, not confirmed,
  dilation, injections, lasers, AT/Gonio, HFA, ROP), rule warnings, every booking with plan, doctor, confirmation and
  rule flag; the printout reminds staff it contains patient names. Technical: `server/src/routes/today.ts`,
  `web/src/pages/Today.tsx`, `Huddle.tsx`, print styles; API test and real-data steps.
- Management dashboards: Metabase at `http://shichika:3000` (clinic network only) with four dashboards - Clinic week,
  Retina care, Money, Front desk - built on a new reporting schema rebuilt every night at 02:30. Patients appear there
  only as a random number and an age band. "Clinic week" is emailed to Pavin every Monday 07:00 (from
  admin@gs.sampadavr.com through Gmail). September's visits, billing, optical and collections match Yarago exactly.
  Found on the way: Yarago records no usable diagnosis (both "final diagnosis" fields hold the visit plan), so clinical
  groups come from the coded examination findings by rules for Dr. Sameera to approve; no patient PIN/area; no surgery advice.
  Technical: migration 0006 (`analytics` schema, `analytics.refresh()`, `app.analytics_patient_key`,
  `app.analytics_unmatched`), sync mode `analytics` + nightly schedule, `scripts/install-metabase.ps1` (Java 21 + Metabase
  v0.63.19, SHA-256 pinned, NSSM service `SudarshanMetabase`, roles `sudarshan_bi` / `metabase`, firewall),
  `scripts/metabase_setup.py` + `metabase_dashboards.py` (API, idempotent), `scripts/check_smtp.py`, backup includes the
  `metabase` database. Docs: METRICS.md (definitions, source checks), SCHEMA, RUNBOOK, COMPLIANCE, D-023.
- Scheduling rules: the Google app's 16 rules now show as warnings. The booking dialog and the reschedule panel say,
  before you book, if a time goes against a rule (e.g. "Check: new patient at 09:40, before 10:00"); the day board lists
  the day's findings and marks the cards; the appointment panel shows its own. Nothing is blocked: Pavin and
  Dr. Sameera reviewed the rules and keep all as warnings for now (D-022); blocks will be decided later.
  Technical: `server/src/services/rules.ts` (pure, ported from `RuleEngine.js`), `routes/rules.ts`
  (`GET /api/rules/day`, `POST /api/rules/check`), `test/rules.test.ts` (30 checks, `npm run test:rules`), API test and
  `real-data.ts` steps; web `components/RuleNotes.tsx`. Rule cards: `analysis/sudarshan/rules/RULE_CARDS.md`. No
  migration. Consult start is worked out from slot + plan preparation time when not stored; rule 14 is off (D-021).
- Plan: analytics and business intelligence added (analytics schema, first KPIs, Metabase), D-020.
- Nightly backup of Sudarshan to the QNAP at 02:00 (database without the Yarago copy, plus the code), 14 daily and
  12 monthly kept, restore test every 4 weeks; the menu shows managers and admins when the last backup ran and warns
  if it failed or is over a day old. Technical: `scripts/backup.ps1`, `restore-test.ps1`, `install-backup.ps1`,
  migration 0005 `app.backup_runs`, `/api/health` reports the last backup.
- Project documents: PLAN, SCHEMA, DESIGN, TESTING, RUNBOOK, COMPLIANCE, DECISIONS, CHANGELOG in `docs/`; CLAUDE.md
  points agents to them.

## 2026-10-19 - Web app (trial)
- Staff can log in at `http://shichika:8484` and use: day board with live Yarago stage, booking dialog, appointment
  panel (history, confirm, reschedule, cancel with reason, link a new patient to Yarago), confirmation calls (day-before
  and 4-day, Sundays skipped), patients, follow-up calls, activity log, clinic calendar, users.
- Trial only: the Google app remains the real booking system; practice bookings are named TEST.
- Technical: `web/` (React 18 + Vite + TypeScript, Atkinson Hyperlegible bundled); server serves `web/dist`
  (`@fastify/static`, files looked up per request, missing assets 404 instead of returning the page); multi-day
  appointment lists skip the per-booking Yarago lookup; booking "booked by" shows "in the Google app" for imported rows.
  `update.ps1` and `install-server.ps1` build both server and web.

## 2026-10-18 - API server
- Logins with personal passwords (bcrypt, lockout after 5 tries, forced change of temporary passwords), roles,
  calendar (daily slots, holidays, doctor hours and leave), appointments (book, waitlist, reschedule, restore, cancel,
  confirm, remarks, manual arrival), patients (search, page, visit detail), follow-up board and call log, activity log.
- Booking checks as in the Google app (day open, slot grid, one patient per slot, holiday, leave, no double booking),
  per-day lock, manager override with reason.
- Yarago appointment status labels confirmed (migration 0004); booking settings added.
- Technical: service `SudarshanServer` on 8484, firewall rule for the local subnet; `scripts/install-server.ps1`;
  38-check API test; read-only real-data check. Fixed during testing: auth hook was not applied to all routes
  (fastify-plugin), editing an appointment wiped fields that were not sent.

## 2026-10-18 - App schema, audit log, Sheets import
- Sudarshan's own tables (migration 0003) and the new audit log: every change recorded by the database with who, a plain
  sentence and before/after per field; readable feed `app.audit_feed`.
- Imported from Google Sheets: 20,072 appointments (15,613 linked to Yarago patients, 9,557 matched to visits,
  1,132 past bookings marked did-not-come), 14 users (no passwords), 3 doctors, calendar, settings, 26,180 history
  events, 4,140 follow-up notes, direct calls, triage, messages, daily KPIs. The old AuditLog was not imported.

## 2026-10-18 - Clinical views and visit timeline
- Decoded views over the mirror (patients, visits, findings, vision/IOP trend, injections, laser, follow-ups, dues),
  per-visit timeline from the station timer, follow-up state per patient; Malayalam text repair.

## 2026-10-18 - Yarago sync
- Full mirror of Yarago into PostgreSQL (553 tables, 11.4M rows, 2.4 min first copy); service
  `SudarshanYaragoSync` every 150 s and a full copy at 01:00; guard for unreliable modified dates.

## 2026-10-18 - Phase A setup
- Read-only MySQL user, PostgreSQL 16, Node.js 24, Git, project folder and legacy snapshot.
