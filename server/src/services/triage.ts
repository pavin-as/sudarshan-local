// Urgency triage for patients who call or walk in (Google app identification.html + Code.js submitTriageAssessment).
// Seven questions, each answer scored 3 (serious), 2 (moderate) or 1 (mild). The HIGHEST score decides, not the sum:
// any 3 = Emergency, else any 2 = Urgent, else Not Urgent. Questions and wording are the Google app's, unchanged.

export interface TriageQuestion { key: string; text: string; options: { score: 1 | 2 | 3; label: string }[] }

export const TRIAGE_QUESTIONS: TriageQuestion[] = [
  { key: "onset", text: "Onset of the problem (when did it start?)", options: [
    { score: 3, label: "Started suddenly within the last 24 hours" },
    { score: 2, label: "Started gradually in the last few days" },
    { score: 1, label: "Ongoing for weeks or months" }] },
  { key: "vision", text: "Vision status", options: [
    { score: 3, label: "Vision suddenly dropped / missing / very blurry" },
    { score: 2, label: "Vision gradually became blurry" },
    { score: 1, label: "Vision normal" }] },
  { key: "pain", text: "Level of pain", options: [
    { score: 3, label: "Severe pain" },
    { score: 2, label: "Moderate discomfort" },
    { score: 1, label: "No pain" }] },
  { key: "floaters", text: "New flashes or floaters", options: [
    { score: 3, label: "Yes, many floaters OR flashes OR curtain-like shadow" },
    { score: 2, label: "Few floaters but no flashes" },
    { score: 1, label: "No flashes or floaters" }] },
  { key: "redness", text: "Redness and light sensitivity", options: [
    { score: 3, label: "Strong redness + sensitive to light" },
    { score: 2, label: "Mild to moderate redness" },
    { score: 1, label: "No redness" }] },
  { key: "injury", text: "Injury or chemical exposure", options: [
    { score: 3, label: "Chemical splash or direct injury" },
    { score: 2, label: "Small foreign body or rubbing injury" },
    { score: 1, label: "No injury" }] },
  { key: "symptoms", text: "Other symptoms", options: [
    { score: 3, label: "Nausea + headache + halos around lights" },
    { score: 2, label: "Mild headache or discomfort" },
    { score: 1, label: "No additional symptoms" }] },
];

export type TriageCategory = "Emergency" | "Urgent" | "Not Urgent";

/** Decisions recorded after the assessment (Google app triageView.html). */
export const TRIAGE_DECISIONS = ["Pending Action", "Booked: Today", "Booked: Tomorrow", "Booked: Later Date",
  "Declined: Wanted Today Only", "Declined: Other Reason", "Other Action (See Remarks)"] as const;

/** Every question must be answered with 1, 2 or 3. Returns the highest score and the category it gives. */
export function scoreTriage(answers: Record<string, number>): { maxScore: number; category: TriageCategory; missing: string[] } {
  const missing = TRIAGE_QUESTIONS.filter((q) => ![1, 2, 3].includes(Number(answers[q.key]))).map((q) => q.key);
  const maxScore = Math.max(0, ...TRIAGE_QUESTIONS.map((q) => Number(answers[q.key]) || 0));
  const category: TriageCategory = maxScore === 3 ? "Emergency" : maxScore === 2 ? "Urgent" : "Not Urgent";
  return { maxScore, category, missing };
}

/** "Booked: Today / Tomorrow / Later Date" from the date booked and the date of the assessment. */
export function bookedDecision(bookedFor: string, assessedOn: string): (typeof TRIAGE_DECISIONS)[number] {
  const days = Math.round((Date.parse(bookedFor + "T00:00:00Z") - Date.parse(assessedOn + "T00:00:00Z")) / 86_400_000);
  return days <= 0 ? "Booked: Today" : days === 1 ? "Booked: Tomorrow" : "Booked: Later Date";
}
