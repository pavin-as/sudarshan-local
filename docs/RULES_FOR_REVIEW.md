# Scheduling rules: block or warn?

For Pavin and Dr. Sameera. **Reviewed 19 Oct 2026: all rules stay warnings for now (D-022);** blocks to be decided later (P-1). Details for each rule: `analysis/sudarshan/rules/RULE_CARDS.md`.

**Now:** every rule only warns. Staff see the warning in the booking dialog before they book and on the day board, and
can still book. **To decide:** for each rule, mark one:
- **Block**: the booking is refused. A manager can still book it with a written reason (like a full day today).
- **Warn**: shown, booking goes ahead (as now).
- **Off**: not checked.

"Times a day" = how often the rule would have fired on real bookings, 22 Jul - 18 Nov 2026 (76 clinic days).
"Suggested" is Claude's suggestion only.

| # | Rule, in plain words | Times a day | Suggested | Your choice |
|---|---|---|---|---|
| 1 | New patients not before 10:00 | 0.5 | Warn | |
| 2 | Family members not before 11:30, unless VIP, BNI, wheelchair or SVV | no data yet | Warn | |
| 3 | A family of more than 3 should not all come in the morning | no data yet | Warn | |
| 4 | Do not book two new patients one after another; put an old patient between | 1.3 | Warn | |
| 5a | **New patient needing dilation not from 16:00** | 0 (none in this period) | **Block** | |
| 5b | Other new patients not from 16:00, unless a child, direct OPD, VIP or BNI | 0.1 | Warn | |
| 6 | Consultation should fall in 10:30-14:00 or 14:30-17:30 (worked out from slot + preparation time) | 5.0 | Warn | |
| 7 | Family members not one after another | no data yet | Warn | |
| 8a | AT or Gonio patients not one after another | 0.5 | Warn | |
| 8b | **At most 3 AT/Gonio a day** (exceeded on 42 of 76 days: is 3 still right?) | 0.6 | Warn, and agree the number | |
| 8c | Gonio and AT best after 14:30 | 2.2 | Warn | |
| 9 | HFA slots kept for HFA patients until 2 days before | 0.7 | **Block** (decided 19 Oct, D-024; manager can override) | Block |
| 17 | Visit types (ROP, injection, laser, dilation, urgent new, emergency) booked in their own times | 0.1 | Warn | Warn |
| 10 | **ROP only on Wednesday** | 0.3 | **Block** | |
| 11 | **Laser only on Tuesday and Friday, unless SVV advised** | 0.04 | **Block** (SVV advised still allowed) | |
| 12 | Wheelchair patients before 10:00 or from 16:00 | 0.2 | Warn | |
| 13 | Leave 20 minutes after a laser patient | 0.03 | Warn | |
| 14 | Leave enough time for each plan of action (REF 10, dilation 15, HFA and laser 20 min ...). Never used in the Google app | 12 | Off | |
| 15 | Show VIP, BNI, wheelchair and SVV on the list | - | Always on (not a warning) | |
| 16 | From the day before, HFA patients may take any slot | - | Part of rule 9 | |

Also please confirm:
1. **The numbers**, as set in the Google app: new patients from 10:00, until 16:00; family cutoff 11:30; two new
   patients at least 20 minutes apart; doctor 10:30-17:30 with lunch 14:00-14:30; HFA slots 09:20 and 09:40; AT/Gonio
   best after 14:30; wheelchair before 10:00 or from 16:00; laser 20 minutes.
2. **Children:** under 18, or ticked "Kids". **Special cases** come from the tick boxes or the remarks text.
3. **Family rules** only work if staff fill "Family group" when booking. In the Google app the column was empty for every
   booking, so these rules never had anything to check.
