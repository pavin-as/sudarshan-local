"""The Metabase dashboards, as data: one entry per question (SQL over the analytics schema, chart type, place on a
24-column grid). Applied by scripts/metabase_setup.py. Definitions of each measure: docs/METRICS.md.
"Last week" = the last full Monday-Sunday week; "last month" = the last full calendar month.
"""
COLLECTION = "Sudarshan"

LAST_WEEK = "visit_date >= date_trunc('week', current_date)::date - 7 AND visit_date < date_trunc('week', current_date)::date"
LAST_MONTH = "BETWEEN (date_trunc('month', current_date) - interval '1 month')::date AND (date_trunc('month', current_date) - interval '1 day')::date"
INR = {"number_style": "currency", "currency": "INR", "currency_style": "symbol", "decimals": 0}
# Metabase cannot group digits the Indian way (11,77,800), so large totals are shown in lakh
LAKH = {"prefix": "₹", "suffix": " lakh", "scale": 0.00001, "decimals": 2, "number_style": "decimal"}


def money(*cols):
    return {"column_settings": {f'["name","{c}"]': INR for c in cols}}


def lakh(*cols):
    return {"column_settings": {f'["name","{c}"]': LAKH for c in cols}}


def chart(dims, metrics, stacked=False, **extra):
    v = {"graph.dimensions": dims, "graph.metrics": metrics, "graph.show_values": False,
         "graph.x_axis.scale": "ordinal", "graph.x_axis.axis_enabled": "rotate-45"}
    if stacked:
        v["stackable.stack_type"] = "stacked"
    v.update(extra)
    return v


def card(name, sql, display, row, col, w, h, viz=None, description=None):
    return {"name": name, "sql": sql.strip(), "display": display, "row": row, "col": col, "w": w, "h": h,
            "viz": viz or {}, "description": description}


def note(text, row, col=0, w=24, h=2):
    return {"text": text, "row": row, "col": col, "w": w, "h": h}


SLOTS_USED = """
SELECT round(100.0 * coalesce(sum(b.n), 0) / nullif(sum(d.max_slots), 0), 1) AS "Slots used %"
FROM analytics.dim_date d
LEFT JOIN (SELECT appointment_date, count(*) AS n FROM analytics.fact_appointment WHERE timed AND NOT cancelled GROUP BY 1) b
       ON b.appointment_date = d.date
WHERE d.open_for_booking AND d.date >= date_trunc('week', current_date)::date - 7 AND d.date < date_trunc('week', current_date)::date
"""

CLINIC_WEEK = {
    "name": "Clinic week",
    "description": "Volume, slot use, patients who did not come, and time in clinic. Emailed to Pavin every Monday 07:00.",
    "cards": [
        note("**Clinic week.** The top row is the last full week (Monday to Sunday). Slots used can pass 100% when a day is booked "
             "beyond its set maximum. Rebuilt nightly at 02:30 from Yarago and Sudarshan; patients are never named here.", 0),
        card("Visits", f"SELECT count(*) AS \"Completed visits\" FROM analytics.fact_visit WHERE completed AND {LAST_WEEK}",
             "scalar", 2, 0, 5, 3),
        card("New patients", f"SELECT count(*) AS \"New patients\" FROM analytics.fact_visit WHERE completed AND new_patient AND {LAST_WEEK}",
             "scalar", 2, 5, 5, 3),
        card("Slots used", SLOTS_USED, "scalar", 2, 10, 5, 3, {"column_settings": {'["name","Slots used %"]': {"suffix": "%"}}}),
        card("Did not come", """
SELECT round(100.0 * avg(did_not_come::int), 1) AS "Did not come %" FROM analytics.fact_appointment
WHERE timed AND NOT cancelled AND appointment_date >= date_trunc('week', current_date)::date - 7 AND appointment_date < date_trunc('week', current_date)::date
""", "scalar", 2, 15, 4, 3, {"column_settings": {'["name","Did not come %"]': {"suffix": "%"}}}),
        card("Minutes in clinic (median)", f"""
SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_min)::numeric) AS "Median minutes in clinic"
FROM analytics.fact_visit WHERE total_min IS NOT NULL AND {LAST_WEEK}
""", "scalar", 2, 19, 5, 3),
        card("Completed visits per week", """
SELECT to_char(date_trunc('week', visit_date), 'FMDD Mon') AS "Week",
       count(*) FILTER (WHERE new_patient) AS "New patients", count(*) FILTER (WHERE NOT new_patient) AS "Returning patients"
FROM analytics.fact_visit
WHERE completed AND visit_date >= date_trunc('week', current_date)::date - 26 * 7 AND visit_date < date_trunc('week', current_date)::date
GROUP BY date_trunc('week', visit_date) ORDER BY date_trunc('week', visit_date)
""", "bar", 5, 0, 12, 6, chart(["Week"], ["New patients", "Returning patients"], stacked=True)),
        card("Slots used per week", """
SELECT to_char(d.week_start, 'FMDD Mon') AS "Week", round(100.0 * sum(coalesce(b.n, 0)) / nullif(sum(d.max_slots), 0), 1) AS "Slots used %"
FROM analytics.dim_date d
LEFT JOIN (SELECT appointment_date, count(*) AS n FROM analytics.fact_appointment WHERE timed AND NOT cancelled GROUP BY 1) b
       ON b.appointment_date = d.date
WHERE d.open_for_booking AND d.date >= date_trunc('week', current_date)::date - 26 * 7 AND d.date < date_trunc('week', current_date)::date
GROUP BY d.week_start HAVING sum(coalesce(b.n, 0)) > 0 ORDER BY d.week_start
""", "line", 5, 12, 12, 6, chart(["Week"], ["Slots used %"]), "Weeks with no bookings at all (clinic closed) are left out."),
        card("Did not come, by weekday (last 90 days)", """
SELECT to_char(appointment_date, 'Dy') AS "Weekday", round(100.0 * avg(did_not_come::int), 1) AS "Did not come %", count(*) AS "Bookings"
FROM analytics.fact_appointment
WHERE timed AND NOT cancelled AND appointment_date >= current_date - 90 AND appointment_date < current_date
GROUP BY 1 ORDER BY min(extract(isodow FROM appointment_date))
""", "bar", 11, 0, 8, 6, chart(["Weekday"], ["Did not come %"])),
        card("Did not come, by days booked ahead (last 90 days)", """
SELECT CASE WHEN lead_days <= 1 THEN '0-1 days' WHEN lead_days <= 7 THEN '2-7 days' WHEN lead_days <= 30 THEN '8-30 days' ELSE 'over 30 days' END AS "Booked ahead",
       round(100.0 * avg(did_not_come::int), 1) AS "Did not come %", count(*) AS "Bookings"
FROM analytics.fact_appointment
WHERE timed AND NOT cancelled AND lead_days IS NOT NULL AND appointment_date >= current_date - 90 AND appointment_date < current_date
GROUP BY 1 ORDER BY min(lead_days)
""", "bar", 11, 8, 8, 6, chart(["Booked ahead"], ["Did not come %"])),
        card("Visits by doctor, last 4 weeks", """
SELECT coalesce(doctor, 'Not recorded') AS "Doctor", count(*) AS "Completed visits"
FROM analytics.fact_visit WHERE completed AND visit_date >= date_trunc('week', current_date)::date - 28 AND visit_date < date_trunc('week', current_date)::date
GROUP BY 1 ORDER BY 2 DESC
""", "row", 11, 16, 8, 6, chart(["Doctor"], ["Completed visits"])),
        card("Typical patient journey per week (median minutes)", """
SELECT to_char(date_trunc('week', visit_date), 'FMDD Mon') AS "Week",
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_for_optometry_min)::numeric) AS "Wait for optometry",
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY optometry_min)::numeric) AS "Optometry incl. dilation",
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_for_doctor_min)::numeric) AS "Wait for doctor",
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY with_doctor_min)::numeric) AS "With doctor"
FROM analytics.fact_visit
WHERE total_min IS NOT NULL AND visit_date >= date_trunc('week', current_date)::date - 12 * 7 AND visit_date < date_trunc('week', current_date)::date
GROUP BY date_trunc('week', visit_date) ORDER BY date_trunc('week', visit_date)
""", "bar", 17, 0, 12, 6, chart(["Week"], ["Wait for optometry", "Optometry incl. dilation", "Wait for doctor", "With doctor"], stacked=True),
             "Medians of each stage, stacked; the stages' medians do not add up exactly to the median total."),
        card("Time per station, last 4 weeks", """
SELECT s.stage AS "Stage", round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.m)::numeric) AS "Median minutes",
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY s.m)::numeric) AS "9 in 10 patients within (minutes)", count(*) AS "Patients"
FROM analytics.fact_visit v
CROSS JOIN LATERAL (VALUES (1, 'Wait for optometry', v.wait_for_optometry_min), (2, 'Optometry incl. dilation', v.optometry_min),
                           (3, 'Wait for doctor', v.wait_for_doctor_min), (4, 'With doctor', v.with_doctor_min),
                           (5, 'Total in clinic', v.total_min)) s(o, stage, m)
WHERE s.m IS NOT NULL AND v.visit_date >= current_date - 28
GROUP BY s.o, s.stage ORDER BY s.o
""", "table", 17, 12, 12, 7),
        card("Arrivals by hour and time in clinic (last 90 days)", """
SELECT lpad(check_in_hour::text, 2, '0') || ':00' AS "Check-in hour", count(*) AS "Patients",
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY total_min)::numeric) AS "Median minutes in clinic"
FROM analytics.fact_visit WHERE check_in_hour IS NOT NULL AND visit_date >= current_date - 90
GROUP BY check_in_hour ORDER BY check_in_hour
""", "combo", 24, 0, 24, 6, chart(["Check-in hour"], ["Patients", "Median minutes in clinic"],
                                   **{"series_settings": {"Median minutes in clinic": {"display": "line", "axis": "right"}, "Patients": {"display": "bar"}}})),
    ],
}

RETINA = {
    "name": "Retina care",
    "description": "Injections, lasers, follow-up leakage, treatments advised but not done, and the case mix.",
    "cards": [
        note("**Retina care.** Yarago records no diagnosis, so the clinical group comes from each visit's coded examination findings "
             "and the purpose from the visit plan note, by rules Dr. Sameera is to approve. 'No specific finding' = only general findings entered.", 0),
        card("Injections given per month, by drug", """
SELECT to_char(date_trunc('month', treated_date), 'Mon YYYY') AS "Month",
       initcap(btrim(regexp_replace(regexp_replace(item, '\\s*\\(.*$', ''), '^intra ?vitreal\\s*', '', 'i'))) AS "Drug",
       count(*) AS "Injections"
FROM analytics.fact_treatment
WHERE kind = 'injection' AND done AND treated_date >= (date_trunc('month', current_date) - interval '12 months')::date
GROUP BY date_trunc('month', treated_date), 2 ORDER BY date_trunc('month', treated_date)
""", "bar", 2, 0, 12, 6, chart(["Month", "Drug"], ["Injections"], stacked=True)),
        card("Lasers done per month", """
SELECT to_char(date_trunc('month', treated_date), 'Mon YYYY') AS "Month", count(*) AS "Laser sessions (per eye)"
FROM analytics.fact_treatment
WHERE kind = 'laser' AND done AND treated_date >= (date_trunc('month', current_date) - interval '12 months')::date
GROUP BY date_trunc('month', treated_date) ORDER BY date_trunc('month', treated_date)
""", "bar", 2, 12, 12, 6, chart(["Month"], ["Laser sessions (per eye)"])),
        card("Back for the planned follow-up after an injection (within 7 days)", """
SELECT to_char(date_trunc('month', next_due_date), 'Mon YYYY') AS "Month follow-up was due",
       round(100.0 * avg(next_on_time::int), 1) AS "On time %", count(*) AS "Follow-ups due"
FROM analytics.fact_treatment
WHERE kind = 'injection' AND next_on_time IS NOT NULL AND next_due_date >= current_date - 365
GROUP BY date_trunc('month', next_due_date) ORDER BY date_trunc('month', next_due_date)
""", "line", 8, 0, 12, 6, chart(["Month follow-up was due"], ["On time %"]),
             "After each injection: did the patient come back for the first follow-up Yarago planned, by its due date + 7 days."),
        card("Follow-ups not back within 14 days, by month due", """
SELECT to_char(date_trunc('month', due_date), 'Mon YYYY') AS "Month due",
       round(100.0 * avg((NOT returned_within_14d)::int), 1) AS "Not back within 14 days %", count(*) AS "Follow-ups due"
FROM analytics.fact_followup
WHERE due_date >= current_date - 365 AND due_date <= current_date - 14
GROUP BY date_trunc('month', due_date) ORDER BY date_trunc('month', due_date)
""", "line", 8, 12, 12, 6, chart(["Month due"], ["Not back within 14 days %"])),
        card("Follow-ups due in the last 12 months, by state now", """
SELECT state AS "State", count(*) AS "Follow-ups"
FROM analytics.fact_followup WHERE due_date >= current_date - 365 AND due_date <= current_date
GROUP BY 1 ORDER BY CASE state WHEN 'returned' THEN 0 WHEN 'overdue up to 30 days' THEN 1 WHEN 'overdue 31-90 days' THEN 2
                               WHEN 'overdue 91-365 days' THEN 3 ELSE 4 END
""", "row", 14, 0, 8, 6, chart(["State"], ["Follow-ups"])),
        card("Advised but not done after 60 days, by month advised", """
SELECT date_trunc('month', coalesce(scheduled_date, advised_date))::date AS "Month advised",
       CASE kind WHEN 'injection' THEN 'Injection' ELSE 'Laser' END AS "Treatment", count(*) AS "Not done"
FROM analytics.fact_treatment
WHERE advised_not_done AND coalesce(scheduled_date, advised_date) >= current_date - 365
GROUP BY 1, 2 ORDER BY 1
""", "bar", 14, 8, 16, 6, chart(["Month advised", "Treatment"], ["Not done"], stacked=True)),
        card("Visits by clinical group, last 12 months", """
SELECT diagnosis_category AS "Clinical group (from findings)", count(*) AS "Completed visits"
FROM analytics.fact_visit WHERE completed AND visit_date >= current_date - 365
GROUP BY 1 ORDER BY 2 DESC
""", "row", 20, 0, 12, 9, chart(["Clinical group (from findings)"], ["Completed visits"])),
        card("Visits by purpose, last 12 months", """
SELECT visit_purpose AS "Purpose (from the plan note)", count(*) AS "Completed visits"
FROM analytics.fact_visit WHERE completed AND visit_date >= current_date - 365
GROUP BY 1 ORDER BY 2 DESC
""", "row", 20, 12, 12, 9, chart(["Purpose (from the plan note)"], ["Completed visits"])),
    ],
}

MONEY = {
    "name": "Money",
    "description": "Billing by service, revenue per visit, collections by payment mode, and what patients owe now.",
    "cards": [
        note("**Money.** From Yarago billing: amounts after concession. Optical orders are shown separately. Last month = the last full calendar month.", 0),
        card("Billed last month", f"""
SELECT round(sum(amount)) AS "Billed" FROM analytics.fact_billing WHERE service_group <> 'Optical' AND bill_date {LAST_MONTH}
""", "scalar", 2, 0, 6, 3, lakh("Billed"), "Clinic billing without optical."),
        card("Optical last month", f"""
SELECT round(sum(amount)) AS "Optical" FROM analytics.fact_billing WHERE service_group = 'Optical' AND bill_date {LAST_MONTH}
""", "scalar", 2, 6, 6, 3, lakh("Optical")),
        card("Collected last month", f"SELECT round(sum(paid)) AS \"Collected\" FROM analytics.fact_bill WHERE bill_date {LAST_MONTH}",
             "scalar", 2, 12, 6, 3, lakh("Collected"), "Clinic bills, without optical."),
        card("Billed per visit, last month", f"""
SELECT round((SELECT sum(amount) FROM analytics.fact_billing WHERE service_group <> 'Optical' AND bill_date {LAST_MONTH})
            / nullif((SELECT count(*) FROM analytics.fact_visit WHERE completed AND visit_date {LAST_MONTH}), 0)) AS "Per visit"
""", "scalar", 2, 18, 6, 3, money("Per visit")),
        card("Billed per month, by service", """
SELECT to_char(date_trunc('month', bill_date), 'Mon YYYY') AS "Month", service_group AS "Service", round(sum(amount)) AS "Billed"
FROM analytics.fact_billing
WHERE bill_date >= (date_trunc('month', current_date) - interval '12 months')::date
GROUP BY date_trunc('month', bill_date), 2 ORDER BY date_trunc('month', bill_date)
""", "bar", 5, 0, 16, 7, {**chart(["Month", "Service"], ["Billed"], stacked=True), **money("Billed")}),
        card("Billed per completed visit, by month", """
SELECT to_char(m.month, 'Mon YYYY') AS "Month", round(b.billed / nullif(v.visits, 0)) AS "Per visit"
FROM (SELECT generate_series((date_trunc('month', current_date) - interval '12 months')::date, date_trunc('month', current_date)::date, interval '1 month')::date AS month) m
LEFT JOIN (SELECT date_trunc('month', bill_date)::date AS month, sum(amount) AS billed FROM analytics.fact_billing WHERE service_group <> 'Optical' GROUP BY 1) b USING (month)
LEFT JOIN (SELECT date_trunc('month', visit_date)::date AS month, count(*) AS visits FROM analytics.fact_visit WHERE completed GROUP BY 1) v USING (month)
ORDER BY m.month
""", "line", 5, 16, 8, 7, {**chart(["Month"], ["Per visit"]), **money("Per visit")}),
        card("Collected per month, by payment mode", """
SELECT to_char(date_trunc('month', bill_date), 'Mon YYYY') AS "Month", round(sum(paid_cash)) AS "Cash", round(sum(paid_card)) AS "Card",
       round(sum(paid_other)) AS "Cheque / other"
FROM analytics.fact_bill WHERE bill_date >= (date_trunc('month', current_date) - interval '12 months')::date
GROUP BY date_trunc('month', bill_date) ORDER BY date_trunc('month', bill_date)
""", "bar", 12, 0, 12, 6, {**chart(["Month"], ["Cash", "Card", "Cheque / other"], stacked=True), **money("Cash", "Card", "Cheque / other")}),
        card("What patients owe now, by age", """
SELECT age_band AS "Owed for", count(*) AS "Patients", round(sum(due_total)) AS "Amount owed"
FROM analytics.fact_due GROUP BY 1
ORDER BY CASE age_band WHEN '0-30 days' THEN 1 WHEN '31-90 days' THEN 2 WHEN 'over 90 days' THEN 3 ELSE 4 END
""", "bar", 12, 12, 12, 6, {**chart(["Owed for"], ["Amount owed"]), **money("Amount owed")},
             "Age = days since the patient's due amount last changed in Yarago."),
        card("Top 15 billed items, last 90 days", """
SELECT item AS "Item", service_group AS "Service", count(*) AS "Times billed", round(sum(amount)) AS "Billed"
FROM analytics.fact_billing WHERE bill_date >= current_date - 90 AND service_group <> 'Optical'
GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 15
""", "table", 18, 0, 24, 10, money("Billed")),
    ],
}

FRONT_DESK = {
    "name": "Front desk",
    "description": "Confirmation calls, reschedules and cancellations, and where bookings come from.",
    "cards": [
        note("**Front desk.** From Sudarshan bookings (including those imported from the Google app). Cancellation reasons are grouped; "
             "bookings cancelled in the Google app carry no reason.", 0),
        card("Confirmation calls done, by week", """
SELECT to_char(date_trunc('week', appointment_date), 'FMDD Mon') AS "Week",
       round(100.0 * avg(confirmed_4day::int), 1) AS "4-day call done %", round(100.0 * avg(confirmed_1day::int), 1) AS "1-day call done %"
FROM analytics.fact_appointment
WHERE timed AND NOT cancelled AND appointment_date < current_date AND appointment_date >= date_trunc('week', current_date)::date - 12 * 7
GROUP BY date_trunc('week', appointment_date) ORDER BY date_trunc('week', appointment_date)
""", "line", 2, 0, 12, 6, chart(["Week"], ["4-day call done %", "1-day call done %"])),
        card("Rescheduled and cancelled, by week of appointment", """
SELECT to_char(date_trunc('week', appointment_date), 'FMDD Mon') AS "Week", sum(rescheduled_count) AS "Times rescheduled",
       count(*) FILTER (WHERE cancelled) AS "Cancelled"
FROM analytics.fact_appointment
WHERE appointment_date >= date_trunc('week', current_date)::date - 12 * 7 AND appointment_date < date_trunc('week', current_date)::date + 7
GROUP BY date_trunc('week', appointment_date) ORDER BY date_trunc('week', appointment_date)
""", "bar", 2, 12, 12, 6, chart(["Week"], ["Times rescheduled", "Cancelled"], **{"graph.y_axis.auto_split": False})),
        card("Why bookings were cancelled, last 90 days", """
SELECT coalesce(cancel_reason_group, 'No reason given') AS "Reason", count(*) AS "Cancelled"
FROM analytics.fact_appointment WHERE cancelled AND appointment_date >= current_date - 90
GROUP BY 1 ORDER BY 2 DESC
""", "row", 8, 0, 8, 6, chart(["Reason"], ["Cancelled"])),
        card("How early bookings were cancelled, last 90 days", """
SELECT CASE WHEN cancelled_days_before IS NULL THEN 'not known' WHEN cancelled_days_before <= 0 THEN 'on the day or after'
            WHEN cancelled_days_before = 1 THEN '1 day before' WHEN cancelled_days_before <= 3 THEN '2-3 days before'
            WHEN cancelled_days_before <= 7 THEN '4-7 days before' ELSE 'over a week before' END AS "Cancelled",
       count(*) AS "Bookings"
FROM analytics.fact_appointment WHERE cancelled AND appointment_date >= current_date - 90
GROUP BY 1 ORDER BY min(coalesce(cancelled_days_before, 999))
""", "bar", 8, 8, 8, 6, chart(["Cancelled"], ["Bookings"])),
        card("Bookings by source, by week", """
SELECT to_char(date_trunc('week', booked_date), 'FMDD Mon') AS "Week booked",
       CASE source WHEN 'import' THEN 'Google app' WHEN 'booking' THEN 'Booking' WHEN 'direct_call' THEN 'Direct call'
                   WHEN 'followup' THEN 'Follow-up call' WHEN 'cancel_list' THEN 'Cancel list' ELSE coalesce(source, 'Other') END AS "Source",
       count(*) AS "Bookings"
FROM analytics.fact_appointment
WHERE booked_date >= date_trunc('week', current_date)::date - 12 * 7
GROUP BY date_trunc('week', booked_date), 2 ORDER BY date_trunc('week', booked_date)
""", "bar", 8, 16, 8, 6, chart(["Week booked", "Source"], ["Bookings"], stacked=True)),
    ],
}

PHARMACY = {
    "name": "Pharmacy",
    "description": "Medicine sales, manufacturers, the wholesalers we buy from and what we owe them (Yarago pharmacy; optical not included).",
    "cards": [
        note("**Pharmacy.** Sales = what patients paid for medicines, after discount and returns, including GST. Purchases = wholesaler "
             "invoice amounts (what we pay), spread over each invoice's medicines. Yarago does not store a manufacturer on the medicine: it is the company most often named on that medicine's "
             "purchase invoices. Last month = the last full calendar month; 12 months = the last 365 days.", 0),
        card("Pharmacy sales last month", f"SELECT round(sum(amount)) AS \"Sales\" FROM analytics.fact_pharmacy_sale WHERE sale_date {LAST_MONTH}",
             "scalar", 2, 0, 6, 3, lakh("Sales")),
        card("Purchases last month", f"SELECT round(sum(amount)) AS \"Purchases\" FROM analytics.fact_pharmacy_purchase WHERE invoice_date {LAST_MONTH}",
             "scalar", 2, 6, 6, 3, lakh("Purchases"), "Wholesaler invoices dated last month."),
        card("Pharmacy bills last month", f"SELECT count(DISTINCT order_id) AS \"Bills\" FROM analytics.fact_pharmacy_sale WHERE sale_date {LAST_MONTH}",
             "scalar", 2, 12, 6, 3),
        card("Average pharmacy bill, last month", f"""
SELECT round(sum(amount) / nullif(count(DISTINCT order_id), 0)) AS "Per bill" FROM analytics.fact_pharmacy_sale WHERE sale_date {LAST_MONTH}
""", "scalar", 2, 18, 6, 3, money("Per bill")),
        card("Pharmacy sales per month, by category", """
SELECT to_char(date_trunc('month', sale_date), 'Mon YYYY') AS "Month", category AS "Category", round(sum(amount)) AS "Sales"
FROM analytics.fact_pharmacy_sale WHERE sale_date >= (date_trunc('month', current_date) - interval '12 months')::date
GROUP BY date_trunc('month', sale_date), 2 ORDER BY date_trunc('month', sale_date)
""", "bar", 5, 0, 14, 7, {**chart(["Month", "Category"], ["Sales"], stacked=True), **money("Sales")}),
        card("Sales and purchases per month", """
SELECT to_char(m.month, 'Mon YYYY') AS "Month", round(coalesce(s.sales, 0)) AS "Sales", round(coalesce(p.purchases, 0)) AS "Purchases"
FROM (SELECT generate_series((date_trunc('month', current_date) - interval '12 months')::date, date_trunc('month', current_date)::date, interval '1 month')::date AS month) m
LEFT JOIN (SELECT date_trunc('month', sale_date)::date AS month, sum(amount) AS sales FROM analytics.fact_pharmacy_sale GROUP BY 1) s USING (month)
LEFT JOIN (SELECT date_trunc('month', invoice_date)::date AS month, sum(amount) AS purchases FROM analytics.fact_pharmacy_purchase GROUP BY 1) p USING (month)
ORDER BY m.month
""", "bar", 5, 14, 10, 7, {**chart(["Month"], ["Sales", "Purchases"]), **money("Sales", "Purchases")},
             "Purchases come in invoices, so a month with a large order looks high; compare over several months."),
        card("Sales by manufacturer, last 12 months", """
SELECT m.manufacturer AS "Manufacturer", round(sum(s.amount)) AS "Sales"
FROM analytics.fact_pharmacy_sale s JOIN analytics.dim_medicine m USING (product_id)
WHERE s.sale_date >= current_date - 365 GROUP BY 1 ORDER BY 2 DESC
""", "row", 12, 0, 12, 7, {**chart(["Manufacturer"], ["Sales"]), **money("Sales")}),
        card("Purchases by wholesaler, last 12 months", """
SELECT coalesce(w.wholesaler, 'Not recorded') AS "Wholesaler", round(sum(p.amount)) AS "Purchases"
FROM analytics.fact_pharmacy_purchase p LEFT JOIN analytics.dim_wholesaler w USING (vendor_id)
WHERE p.invoice_date >= current_date - 365 GROUP BY 1 ORDER BY 2 DESC
""", "row", 12, 12, 12, 7, {**chart(["Wholesaler"], ["Purchases"]), **money("Purchases")}),
        card("Top 25 medicines by sales, last 12 months", """
SELECT m.medicine AS "Medicine", m.category AS "Category", m.manufacturer AS "Manufacturer", sum(s.quantity) AS "Quantity",
       round(sum(s.amount)) AS "Sales", round(100.0 * sum(s.amount) / sum(sum(s.amount)) OVER (), 1) AS "% of pharmacy sales",
       count(DISTINCT s.patient_key) AS "Patients"
FROM analytics.fact_pharmacy_sale s JOIN analytics.dim_medicine m USING (product_id)
WHERE s.sale_date >= current_date - 365 GROUP BY 1, 2, 3 ORDER BY 5 DESC LIMIT 25
""", "table", 19, 0, 24, 10, money("Sales"), "% is of all pharmacy sales in the 12 months, not only the top 25."),
        card("Who supplies which manufacturer, last 12 months", """
SELECT coalesce(w.wholesaler, 'Not recorded') AS "Wholesaler", p.manufacturer AS "Manufacturer",
       count(DISTINCT p.purchase_id) AS "Invoices", round(sum(p.amount)) AS "Purchased"
FROM analytics.fact_pharmacy_purchase p LEFT JOIN analytics.dim_wholesaler w USING (vendor_id)
WHERE p.invoice_date >= current_date - 365 GROUP BY 1, 2 ORDER BY 1, 4 DESC
""", "table", 29, 0, 12, 9, money("Purchased")),
        card("Manufacturers: bought and sold, last 12 months", """
SELECT coalesce(b.manufacturer, s.manufacturer) AS "Manufacturer", round(coalesce(b.purchased, 0)) AS "Purchased",
       round(coalesce(s.sold, 0)) AS "Sold", coalesce(s.medicines, 0) AS "Medicines sold"
FROM (SELECT manufacturer, sum(amount) AS purchased FROM analytics.fact_pharmacy_purchase WHERE invoice_date >= current_date - 365 GROUP BY 1) b
FULL JOIN (SELECT m.manufacturer, sum(f.amount) AS sold, count(DISTINCT f.product_id) AS medicines
             FROM analytics.fact_pharmacy_sale f JOIN analytics.dim_medicine m USING (product_id)
            WHERE f.sale_date >= current_date - 365 GROUP BY 1) s ON s.manufacturer = b.manufacturer
ORDER BY 3 DESC
""", "table", 29, 12, 12, 9, money("Purchased", "Sold"),
             "Purchased = invoice amounts; sold = what patients paid. The gap is not profit: stock carries over from month to month."),
        card("Bought in the last 6 months, not sold in the last 90 days", """
SELECT m.medicine AS "Medicine", m.manufacturer AS "Manufacturer", max(p.invoice_date) AS "Last bought", sum(p.quantity) AS "Quantity bought",
       round(sum(p.amount)) AS "Bought for", (SELECT max(s.sale_date) FROM analytics.fact_pharmacy_sale s WHERE s.product_id = p.product_id) AS "Last sold"
FROM analytics.fact_pharmacy_purchase p JOIN analytics.dim_medicine m USING (product_id)
WHERE p.invoice_date >= current_date - 182
  AND NOT EXISTS (SELECT 1 FROM analytics.fact_pharmacy_sale s WHERE s.product_id = p.product_id AND s.sale_date >= current_date - 90)
GROUP BY p.product_id, 1, 2 ORDER BY 5 DESC
""", "table", 38, 0, 24, 8, money("Bought for"), "Slow-moving stock to check before reordering."),
    ],
}

# What we owe wholesalers (D-033): live views, as of the last sync (purchase and payment tables sync every 150 s)
WHOLESALER_BALANCE = [
    note("**What we owe wholesalers, now.** Invoiced minus paid, adjusted and credit notes, per wholesaler (Yarago records a settlement "
         "as one adjustment covering many invoices, so the balance is per wholesaler). Open invoices assume the oldest are paid first. "
         "Minutes old, not a day: it reads Sudarshan's copy of Yarago, refreshed every 150 seconds.", 5),
    card("Owed to wholesalers now", "SELECT round(sum(pending)) AS \"Owed\" FROM analytics.wholesaler_balance WHERE pending > 0",
         "scalar", 7, 0, 6, 3, lakh("Owed")),
    card("Open invoices now", "SELECT count(*) AS \"Open invoices\" FROM analytics.wholesaler_open_invoice", "scalar", 7, 6, 6, 3),
    card("Oldest open invoice, days", "SELECT max(days_open) AS \"Days\" FROM analytics.wholesaler_open_invoice WHERE invoice_date >= current_date - 365",
         "scalar", 7, 12, 6, 3, None, "Within the last year; older leftovers are listed in the table below."),
    card("Settled in the last 30 days", """
SELECT round(sum(settled)) AS "Settled" FROM analytics.wholesaler_invoice WHERE settlement_entered_at >= current_date - 30
""", "scalar", 7, 18, 6, 3, lakh("Settled"), "Payments, adjustments and credit notes entered in the last 30 days (by entry date)."),
    card("Balance per wholesaler", """
SELECT b.wholesaler AS "Wholesaler", round(b.pending) AS "Owed now", coalesce(o.n, 0) AS "Open invoices", o.oldest AS "Oldest open",
       b.last_invoice AS "Last invoice", b.last_settlement_entered AS "Last settlement entered", round(b.invoiced) AS "Invoiced, all time"
FROM analytics.wholesaler_balance b
LEFT JOIN (SELECT wholesaler, count(*) AS n, min(invoice_date) AS oldest FROM analytics.wholesaler_open_invoice GROUP BY 1) o USING (wholesaler)
WHERE b.pending <> 0 OR b.last_invoice >= current_date - 365
ORDER BY b.pending DESC
""", "table", 10, 0, 12, 8, money("Owed now", "Invoiced, all time"), "A negative amount means we have paid ahead."),
    card("Open invoices, oldest first", """
SELECT wholesaler AS "Wholesaler", invoice_no AS "Invoice", invoice_date AS "Date", days_open AS "Days open",
       round(invoiced) AS "Invoice amount", round(open_amount) AS "Still open"
FROM analytics.wholesaler_open_invoice ORDER BY invoice_date
""", "table", 10, 12, 12, 8, money("Invoice amount", "Still open"), "Worked out oldest-paid-first from each wholesaler's balance."),
]
PHARMACY["cards"] = [c if c["row"] < 5 else {**c, "row": c["row"] + 13} for c in PHARMACY["cards"]] + WHOLESALER_BALANCE

DASHBOARDS = [CLINIC_WEEK, RETINA, MONEY, FRONT_DESK, PHARMACY]
