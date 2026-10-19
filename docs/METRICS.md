# METRICS.md - what each reported number means

One definition per number (D-020). Every figure in Metabase and, later, inside Sudarshan comes from the `analytics`
schema, rebuilt nightly at 02:30 by `analytics.refresh()` (db/migrations/0006_analytics.sql). The same definitions are
in the table `analytics.metric_definitions`. Dashboards: `scripts/metabase_dashboards.py` (the SQL of every question).

**Periods.** "Last week" = the last full Monday-Sunday week. "Last month" = the last full calendar month.
Dates are clinic dates (Asia/Kolkata).
**Patients** appear only as a random key (`patient_key`) and an age band. The key-to-patient link stays in `app`.

## Checked against the source (19 Oct 2026, September 2026)

| Figure | analytics | Source | Match |
|---|---|---|---|
| Completed visits | 634 | Yarago `tblappointments` status 3 | yes |
| Clinic billing (without optical) | ₹11,77,800 | sum of bill totals, `tblpatientsappointmentbillingdetails` | yes (bill lines = bill totals) |
| Optical | ₹3,80,320 | `tblopticalpatientpayment` | yes |
| Collected | ₹11,76,600 | cash + card + cheque + other on the bills | yes |
| Injections given | 16 | Yarago injection module | to confirm with the clinic's own count |

## Volume

| Measure | Definition | Notes |
|---|---|---|
| Visits | Yarago visits with status 3 (completed). | `fact_visit.completed` |
| New patients | A visit that is the patient's first completed visit in Yarago. | `fact_visit.new_patient` |
| Slots used % | Bookings with a time, not cancelled, divided by the maximum slots of each open day (open = maximum slots above 0 and not a holiday). | Can exceed 100%: days were booked past their maximum in the Google app. Weeks with no bookings at all are left out of the weekly chart. |
| Visits by doctor | Completed visits by the doctor recorded in Yarago. | |

## Leakage

| Measure | Definition | Notes |
|---|---|---|
| Did-not-come % | Past bookings with a time, not cancelled, with no Yarago visit for that patient that day (and not marked arrived), divided by all such bookings. | Bookings for new patients not yet linked to Yarago count as "came" only if marked arrived. |
| Follow-up not back within 14 days % | Yarago follow-ups due in the period (at least 14 days ago) where the patient's next visit was not within 14 days of the due date. | `fact_followup` |
| Back for the planned follow-up after an injection % | For each injection given: the first follow-up Yarago planned after it; on time = the patient's next visit was no later than its due date + 7 days. | Yarago records no planned date for the next dose itself (the injection's own follow-up field is empty on 98% of rows), so this measures the post-injection review. Dr. Sameera to confirm. |
| Advised, not done | Injections or lasers advised (not given / not done) over 60 days ago, with no injection or laser of that kind done for that patient and eye since. | No surgeries are marked as advised in Yarago in the last 12 months, so surgery is not included. |

## Case mix

| Measure | Definition | Notes |
|---|---|---|
| Clinical group | First matching rule (`analytics.category_rule`, kind `diagnosis`) over the visit's coded examination findings ("FUNDUS: SEVERE NPDR; LENS: PC IOL +"). "No specific finding" = only general entries such as "FINDINGS"; "No findings recorded" = none. | Yarago has no usable diagnosis: the coded diagnosis link is empty and both "final diagnosis" fields hold the visit plan. Rules proposed by Claude, not yet approved by Dr. Sameera; unmatched findings are listed in `app.analytics_unmatched`. |
| Visit purpose | First matching rule (kind `purpose`) over the visit plan note ("re oct, ref+dil, post inj case"). | Same approval. |

## Flow

| Measure | Definition |
|---|---|
| Time per station | From the Yarago station timer (`clinical.visit_timeline`): wait for optometry (check-in to optometry start), optometry including dilation, wait for doctor, with doctor, total (check-in to check-out). Median, and the time within which 9 in 10 patients finished. |

## Front desk

| Measure | Definition | Notes |
|---|---|---|
| Confirmation calls done % | Past bookings with a time, not cancelled, with the 4-day / 1-day call recorded. | |
| Rescheduled / cancelled | Reschedule events per booking; cancelled bookings by week of appointment. | Imported bookings have no reschedule history. |
| Cancellation reason group | Typed reason grouped by keywords (travelling, unwell, doctor unavailable, duplicate, wants another date, not coming, could not reach, died, other). The typed text itself is not copied to analytics. | Bookings cancelled in the Google app carry no reason or date. |
| Bookings by source | Booking, direct call, follow-up call, cancel list, or imported from the Google app. | Booking date is "not known" for 1,828 imported bookings that had none (the importer stamped them with the import day). |

## Money

| Measure | Definition | Notes |
|---|---|---|
| Billed | Sum of Yarago bill lines (after concession): consultation and charges, investigations, injections, lasers, other procedures, others. Optical orders separately (order total minus refund). | Large totals shown in lakh (Metabase cannot group digits as 11,77,800). |
| Billed per visit | Clinic billing (without optical) in the month divided by completed visits in the month. | |
| Collected | Cash + card + cheque + other payment on each clinic bill. | |
| Dues by age | What each patient owes now (`clinical.patient_due`), by days since that amount last changed: 0-30, 31-90, over 90 days. | Not by bill date: Yarago keeps one running due per patient. |

## Pharmacy (dashboard "Pharmacy", D-032)

| Measure | Definition | Notes |
|---|---|---|
| Pharmacy sales | Yarago pharmacy sale lines (`tblopticalpatientorderdetails`, categories Eye Drops, Tablets, Ointments, Others, Pharmacy Stationary): line total minus returned amount, after discount, including GST. Cancelled orders left out. | Optical (lens, frame, contact lens) not included; it is under Money. Last 12 months on 19 Oct: Rs 52.6 lakh. |
| Purchases | Wholesaler invoice lines (`tblopticalpharmacypurchasedetails`), same categories, dated by the delivery-challan date, else the order date, else entry. Quantity after returns to the wholesaler. | Last 12 months on 19 Oct: Rs 53.1 lakh from 5 wholesalers. |
| Manufacturer | The company most often named on a medicine's purchase invoices (Yarago keeps none on the medicine). "Not recorded" when no invoice names one. | Covers 85 of the 87 medicines sold in the last year, 99% of sales value. |
| Wholesaler | `tbl_mst_vendor` of the purchase invoice (purchases) or of the batch sold (sales). | Names as in Yarago. |
| Pharmacy bill | One Yarago pharmacy order. Average bill = sales / bills. | |
| Slow-moving | Bought in the last 6 months, not sold in the last 90 days. | |

## Not available from Yarago (noted 19 Oct 2026)

- **Patient geography:** no PIN code, city or state is recorded for any patient (address is free text).
- **Diagnosis:** see Case mix above.
- **Surgery advised, not done:** no surgery advice recorded in the last 12 months.
