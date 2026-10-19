# Sudarshan web app

React + TypeScript + Vite. Built into `web/dist/`, which the API server serves at `http://shichika:8484`.
No CDN or internet needed: the font (Atkinson Hyperlegible, designed for low-vision readers) is bundled.

```
npm ci && npm run build     # production build (install-server.ps1 / update.ps1 do this)
npm run dev                 # development at http://localhost:5173, API proxied to :8484
```

| Screen | Who | What |
|---|---|---|
| Day board | everyone | the day's slots; each booking shows where the patient is in Yarago right now (arrived, optometry, waiting, with doctor, done), refreshed every minute; waitlist and cancelled below; book by clicking a free slot |
| Confirmation calls | front desk | day-before call (next working day) and 4-day call (next 4 working days, Sundays skipped), as in the Google app |
| Patients | everyone | find by MRD / phone / name; patient page with visits, vision and pressure trend, injections and laser (clinical roles), dues, appointments, follow-up calls |
| Follow-up calls | everyone (logging: front desk) | overdue follow-ups, injection patients first; log the call or book |
| Activity log | manager, admin | every change as a sentence, searchable |
| Clinic calendar | manager, admin | slots per day, holidays, doctors' weekly hours and leave |
| Users | admin | add users, temporary passwords, roles, deactivate |
