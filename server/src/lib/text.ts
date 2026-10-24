// Small wording helpers shared by the follow-up board and the Patients lists.
export const titleWords = (s: string | null) => (s ? s.toLowerCase().replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase()).replace(/\b(Prp|Yag|Pi)\b/g, (w) => w.toUpperCase()) : null);
// For queries over app.appointments (alias `a`): the linked patient's age in days / months when under a year, else NULL
export const APPT_AGE_TEXT = `(SELECT cp.age_text FROM clinical.patient cp WHERE cp.patient_id = a.patient_id)`;
export const ordinal = (n: number) => { const t = ["th", "st", "nd", "rd"], v = n % 100; return n + (t[(v - 20) % 10] || t[v] || t[0]); };
