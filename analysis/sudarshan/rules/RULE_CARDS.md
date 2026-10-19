# Rule cards - the 16 scheduling rules

Source of truth for `server/src/services/rules.ts` and `server/test/rules.test.ts`. Extracted 2026-10-19 from
`legacy/sudarshan/RuleEngine.js` (the code that ran), `checks.md` (the design), `Day_Scheduling_Rule_Checks.pdf` (what
staff were told) and `Code.js` (settings, consult start). Where they disagree, the running code wins and the card says so.

**Status: all rules are warnings (D-010, D-022: reviewed by Pavin and Dr. Sameera 19 Oct 2026, all stay warnings for
now).** Which should block a booking is decided later (P-1, `docs/RULES_FOR_REVIEW.md`). Levels keep the Google app's: error = "Against rule", warning = "Check", info = "Note".

**How the Google app ran them.** Only on the day overview, after pressing "Check rules" (`dayOverview.html:2727`,
`validateDayRules` `RuleEngine.js:890`), for one day and the selected doctor, over every row in the `appointment` sheet
for that day (waitlist included, cancelled excluded). Never at booking time. A Gemini summary of the findings followed
(`RuleEngine.js:981`); it sent patient names to Google and is **not** ported (D-006).
**How Sudarshan runs them.** Same checks, over the whole clinic day (one slot grid for all doctors, D-010): live in the
booking dialog and the reschedule panel for the booking being made (`POST /api/rules/check`), and for the whole day on
the board and in the appointment panel (`GET /api/rules/day`). Nothing is blocked.

**Replay on real data** (76 clinic days, 22 Jul - 18 Nov 2026, 2,381 bookings, live settings; counts only):
shown on each card as "fires".

## Shared definitions

| Term | Google app | Sudarshan | Note |
|---|---|---|---|
| New patient | MRD starts with N; no MRD -> PatientType is "new"/"guest" (`RuleEngine.js:159`) | same | PatientType "Guest" is on 7,985 old (S) bookings, so the MRD decides |
| Old patient | MRD starts with S (`:173`) | same | |
| Procedures | substring match on the upper-cased PlanOfAction; AT as a whole word or A-SCAN; IVR only if not IVTA (`:13`) | same | "BARRAGE LASER", "FOCAL LASER" count as LASER |
| Special case | Remarks contains VIP, BNI, WHEEL CHAIR/WHEELCHAIR, SVV (`:47`) | Remarks **or tags** (booking dialog tags VIP, BNI, Wheelchair, SVV advised) | **Changed**: tags did not exist as checkboxes before |
| Child | age < 18 from the Age text; "baby"/"months" = 0 (`:68`, `:202`) | `age_years` < 18, **or tag Kids** | **Changed**: Kids tag added |
| Consult start | the sheet's "Consult Start" column; rules needing it skipped rows where it was empty | stored value, else **slot + longest PrepMin** of the plan from PlanOfActionMaster - the Google app's own formula (`Code.js:8661`, `:16190`) | **Changed**: only 299 of 2,381 recent bookings had it stored, so rules 6, 8C, 8D, 13 rarely ran before |
| Consult order | consult start if present, else slot (`:353`) | same (consult start is now always known for slotted bookings) | |
| Rule settings | `RuleSettings` sheet, defaults `Code.js:22863` | `app.settings` `rule.*` (imported from the sheet; Sheets time fractions read as HH:MM) | Live values differ from defaults: new-patient gap **20** (default 30), lunch **14:00**-14:30 (default 13:30) |

**Probably silent in the Google app (inferred, cannot be confirmed now the export is deleted):** rules 3, 5 and 12 read the
hour with `TimeSlot.split(':')[0]`, but `getAppointmentsForDay` turned every cell into text with `toString()`
(`Code.js:4479`). If TimeSlot cells held time values (the rule settings sheet did), that text is
"Sat Dec 30 1899 09:40:00 GMT+0521 ...", the hour is NaN and these three rules never fired. The family rules (2, 3, 7)
had no data: "Family Identifier" is empty on all 20,072 imported bookings.

---

### Rule 1 - New patients from 10:00
- **Google app:** `checkNewPatientTiming` `RuleEngine.js:254`. Switch `RULE_NEW_TIMING`, setting `NEW_MORNING_START` 10:00. Level warning.
- **Given** a new patient with a slot **when** the slot is before 10:00 **then** "Check: new patient ... before 10:00". Waitlist skipped. VIP/BNI do not exempt.
- **Sudarshan:** identical. Test: `rule 1`. Fires: 36 (0.5 a day).

### Rule 2 - Family members not before 11:30 (except special cases)
- **Google app:** `checkSameFamilyTiming` `:280`. `RULE_FAMILY_TIMING`, `FAMILY_MORNING_CUTOFF` 11:30. Level info.
- **Given** a booking with a family group and a slot before 11:30 **and** not VIP/BNI/wheelchair/SVV **then** "Note". A family of one is still checked.
- **Sudarshan:** identical (special case also from tags). Test: `rule 2`. Fires: 0 (no family data yet).

### Rule 3 - A family of more than 3 not all in the morning
- **Google app:** `checkFamilySizeMorning` `:312`. `RULE_FAMILY_MORNING`, `FAMILY_MORNING_MAX` 3; "morning" = before 12:00 (fixed). Level warning, one finding per morning member.
- **Given** a family with more than 3 bookings that day (waitlist counts) **when** more than 3 have a slot before 12:00 **then** "Check" on each morning member.
- **Sudarshan:** identical. Probably never fired in the Google app (see above). Test: `rule 3`. Fires: 0.

### Rule 4 - New and old alternately
- **Google app:** `checkNewOldAlternation` `:346`. `RULE_NEW_CONSECUTIVE`, `NEW_CONSECUTIVE_GAP` (live 20 min). Level info.
- **Given** new patients in consult order **when** two neighbours are less than the gap apart **and** no old (S) patient has a consult between them **and** they are not one family sharing a slot **then** "Note" on the later one.
- **Sudarshan:** identical; consult order now uses the worked-out consult start. Test: `rule 4` (3 tests). Fires: 101 (1.3 a day).

### Rule 5 - No new patients from 16:00 (children, direct OPD, VIP, BNI may)
- **Google app:** `checkNewPatientAfter4PM` `:410`. `RULE_NEW_AFTER_4PM`, `NEW_EVENING_CUTOFF` 16:00 (compared by hour).
- **Given** a new patient with a slot in or after the cutoff hour: **with dilation** -> error "Against rule"; **else** unless child / DIRECT / VIP / BNI -> warning "Check". Dilation is an error even for a child.
- **Sudarshan:** identical, child also by Kids tag. Probably never fired in the Google app. Test: `rule 5` (2 tests). Fires: 7.

### Rule 6 - Consultation 10:30-13:30/14:00 and 14:30-17:30
- **Google app:** `checkConsultationWindows` `:452`. `RULE_CONSULT_WINDOW`, `CONSULT_WINDOW_START` 10:30, lunch (live 14:00-14:30), `CONSULT_WINDOW_END` 17:30. Only for rows with a stored Consult Start.
- **Given** a consult start **when** before 10:30 -> warning; strictly inside lunch -> info; after 17:30 -> warning.
- **Sudarshan:** same thresholds, consult start worked out when not stored. Test: `rule 6` (2 tests). Fires: before 252 (3.3 a day), lunch 97, after 32.

### Rule 7 - Same family not one after another
- **Google app:** `checkSameFamilyContinuous` `:509`. `RULE_FAMILY_CONTINUOUS`. Level info, on every member of the run. Slot order; a booking without a family breaks the run.
- **Sudarshan:** identical. Test: `rule 7`. Fires: 0 (no family data yet).

### Rule 8 - AT / Gonio (four checks)
- **Google app:** `checkGonioATConsecutive` `:561`.
  - **A** `RULE_GONIO_AT_CONSECUTIVE`, warning: two AT/Gonio neighbours in consult order with no "easy" old patient (old, without AT, Gonio, HFA, laser, OCT) between. *Because only neighbours are compared, nothing can be between them: in effect any two AT/Gonio patients next to each other.*
  - **B** `RULE_GONIO_AT_CAP`, `GONIO_AT_MAX_PER_DAY` 3, **error**, whole day: more than 3 AT/Gonio bookings (waitlist counts).
  - **C** `RULE_GONIO_TIMING`, `GONIO_EVENING_START` 14:30, info: Gonio with consult before 14:30, special cases skipped.
  - **D** `RULE_AT_TIMING`, `AT_EVENING_START` 14:30, info: AT (without Gonio) with consult before 14:30, special cases skipped.
- **Sudarshan:** identical. Tests: `rule 8A`, `rule 8B`, `rule 8C/8D`. Fires: A 36, **B 42 (on 42 of 76 days)**, C 14, D 151 (2 a day).

### Rule 9 - 09:20 and 09:40 are HFA slots
- **Google app:** `checkHFASlotRule` `:691`. `RULE_HFA_SLOT`, `HFA_SLOT_1` 09:20, `HFA_SLOT_2` 09:40.
- **Given** a non-HFA patient in 09:20/09:40 -> warning. **Given** an HFA patient in another slot **more than 1 day ahead** -> info "move to the HFA slot if free".
- **Sudarshan:** identical (days counted in clinic time). Test: `rule 9` (2 tests). Fires: non-HFA 47, HFA elsewhere 4.

**Changed 19 Oct (D-024):** HFA slots now come from the Google app's HFA block (days and times) when present; a non-HFA
booking there more than 2 days ahead is *against the rule* (error) and the booking itself is refused unless a manager
gives a reason. From 2 days before, other plans may have the slot, and the "HFA patient elsewhere" note stops (rule 16
moves from "the day before" to "2 days before"). Tests: `rule 9` (4 checks), `rule 16`.

### Rule 10 - ROP on Wednesday
- **Google app:** `checkROPDayRule` `:737`. `RULE_ROP_DAY`, `ROP_DAY` WED. **Error**. Waitlist counts.
- **Sudarshan:** identical. Test: `rule 10`. Fires: 22 (on 7 days).

### Rule 11 - Laser on Tuesday and Friday, unless SVV advised
- **Google app:** `checkLaserDayRule` `:759`. `RULE_LASER_DAY`, `LASER_DAYS` TUE,FRI. **Error** unless remarks mention SVV. Waitlist counts.
- **Sudarshan:** identical; SVV also from the "SVV advised" tag. Test: `rule 11`. Fires: 3.

### Rule 12 - Wheelchair early morning or evening
- **Google app:** `checkWheelchairTiming` `:782`. `RULE_WHEELCHAIR`, before 10:00 or from 16:00 (by hour). Info.
- **Sudarshan:** identical (wheelchair also from the tag). Probably never fired in the Google app. Test: `rule 12`. Fires: 13.

### Rule 13 - 20 minutes for a laser
- **Google app:** `checkProcedureDurationGaps` `:814`. `RULE_LASER_DURATION`, `LASER_DURATION` 20. Warning on the next patient when their consult starts less than 20 min after a laser patient's consult. Only rows with a stored Consult Start.
- **Sudarshan:** identical, consult start worked out. Test: `rule 13`. Fires: 2.

### Rule 14 - Time for each plan of action
- **Google app:** designed in `checks.md` (durations REF 10, DIL 15, HFA 20, LASER 20 ...), helper `getMaxProcedureDuration` `:225` exists but is **never called**: the rule never ran.
- **Sudarshan:** built as designed (warning when the next slot is sooner than the longest duration of the plan), switch `RULE_PLAN_DURATION` **OFF** by default. Test: `rule 14`. Would fire 907 times (12 a day) with the 10-minute grid, which is why it stays off until decided.

### Rule 15 - Special cases shown on the list
- **Google app:** `detectSpecialCases` `:857`, not a violation: VIP, BNI, Wheelchair, SVV from remarks, for highlighting.
- **Sudarshan:** the board shows these as labels on the appointment card (from remarks when not already a tag). Test: `rule 15`.

### Rule 16 - HFA patients may take other slots from the day before
- **Google app:** no separate code; it is the "more than 1 day ahead" condition of rule 9 (`:720`): from the day before, an HFA patient outside 09:20/09:40 gets no note, and a non-HFA patient in an HFA slot is still warned.
- **Sudarshan:** same, inside rule 9. Test: `rule 16`.

### Rule 17 - Visit types in their own times (added 19 Oct, D-024)
- **Google app:** `getAllowedSlots` (`Code.js:7669`) offered a booking of visit type HFA / ROP / INJECTION / URGENT NEW /
  EMERGENCY / DILATION / LASER only the slots in that type's generalSettings column (`getSpecializedIntervals`
  `Code.js:8128`), e.g. INJECTION `W-09:00-12:20-0`. General bookings were kept out only of the General Block (the HFA times).
- **Sudarshan:** a warning (never a block) when a booking's visit type is one of these and it is outside that type's time
  that day, or the type has no time that day. Other bookings may use the slots. Switch `RULE_RESERVED_SLOTS`, on.
  HFA is rule 9 plus the booking hold. Tests: `rule 17` (2 checks). Fires: 6 times in 76 days.
