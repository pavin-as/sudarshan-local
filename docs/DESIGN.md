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
2. **The day is the unit.** The day board (time rail with every slot) is the home screen; everything else opens over it
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

### Quality floor
Works down to phone width (nav wraps, rail stays readable); visible keyboard focus; respects reduced motion; no
external requests (fonts, scripts) so it works without internet; contrast AA or better.
