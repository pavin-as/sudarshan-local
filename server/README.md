# Sudarshan API server

Node.js + TypeScript + Fastify, PostgreSQL through `pg`. Runs on shichika as the Windows service
`SudarshanServer` on port 8484 (clinic LAN only). Settings come from `D:\Sudarshan\app\.env`.

```
npm ci && npm run build          # build to dist/
npm start                        # run (the service does this)
node dist/cli.js list-users      # who can log in
node dist/cli.js temp-password <username>        # one-time password, must be changed at login
node dist/cli.js create-user <username> "<Full name>" <role>
npx tsx test/real-data.ts        # read-only check of every screen's query on the real database
SUDARSHAN_ENV=<test .env> npm test   # full API test - TEST DATABASE ONLY (writes and deletes test rows)
```

## Rules the code follows
- **Every write goes through `withTx()`** (src/db.ts). It sets `app.user_id`, `app.audit_summary`, `app.source`,
  `app.request_id`, so the audit trigger records who did it and a plain sentence. Never write to app tables
  with a bare `pool.query`.
- **Yarago is read only.** The server reads the mirror (`yarago.*`) and the decoded views (`clinical.*`);
  it never connects to MySQL.
- **Permissions** are one table in `src/lib/permissions.ts`; handlers call `need(req, "<permission>")`.
- **Sessions**: random id in an HTTP-only, SameSite=strict cookie, 12 h sliding expiry, stored in `app.sessions`.
  Passwords bcrypt (12 rounds); 5 wrong passwords per user and computer in 15 minutes locks for 15 minutes.
  New users and resets get a temporary password that must be changed at first login.
- **Booking** (src/services/booking.ts) runs under a per-day lock: a day must have maximum slots set
  (like planningB), slots are on the grid (09:00-17:50 every 10 min, from `app.settings`), one patient per
  slot, no booking on holidays or with a doctor on leave, no second booking for the same patient that day.
  A manager or admin can book over a full day or a taken slot by giving a reason (kept in the story and log).
  The 16 scheduling rules of the Google app are the next addition (as warnings).

## API (all under /api, JSON)
| | |
|---|---|
| `POST auth/login`, `POST auth/logout`, `GET auth/me`, `POST auth/change-password` | session |
| `GET users`, `POST users`, `PATCH users/:id`, `POST users/:id/reset-password` | admin |
| `GET meta` | doctors, plans of action, setting lists, status labels |
| `GET days?from&to`, `GET days/:date` | open days, capacity, slot grid, doctors' hours |
| `PUT days/:date/capacity`, `PUT/DELETE holidays/:date`, `GET holidays` | manager/admin |
| `GET/PUT doctors/:id/schedule`, `POST doctors/:id/exceptions`, `DELETE doctors/:id/exceptions/:eid` | doctor hours, leave |
| `GET appointments?date | from&to | patientId | q | status | doctorId` | board, with Yarago live stage |
| `GET appointments/:id` | appointment and its story |
| `POST appointments` | book (no slotTime = waitlist) |
| `POST appointments/:id/move` | reschedule, restore a cancelled one, give a waitlisted patient a slot |
| `PATCH appointments/:id` | edit details (plan, remarks, tags ...) |
| `POST appointments/:id/cancel`, `/confirm`, `/remarks`, `/status` | |
| `GET patients/search?q`, `GET patients/:id`, `GET patients/:id/visits/:visitId` | Yarago patient, visits, trend, injections, dues |
| `GET followups?view=to_call|upcoming|all_overdue`, `POST followups/:patientId/actions` | follow-up board and call log |
| `GET audit?patientId&entity&entityId&userId&from&to&text&before` | activity log in plain sentences |
| `GET health` | public: database and last sync time |
