// Which of today's bookings belongs to a patient who came (D-036). A booking made for a new patient has no Yarago
// patient yet (only a temporary NDC_ ID), so the patient ID cannot match it. Order: Yarago patient ID, then the same
// MRD, then the same mobile number with a compatible name. A match is never written; staff link the booking.
export interface Bk { id: number; patientId: number | null; mrd: string | null; phone: string | null; name: string; slotTime?: string | null; planOfAction?: string | null }
export interface Arrived { patientId: number; mrd: string | null; phone: string | null; name: string | null }
export type MatchKind = "linked" | "mrd" | "phone_name";

const tail10 = (p: string | null | undefined) => { const d = (p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const words = (n: string | null | undefined) => (n ?? "").toLowerCase().replace(/\b(mr|mrs|ms|dr|master|baby|smt|shri)\b\.?/g, " ")
  .replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

/** Same person by name: equal, or they share a word of three or more letters (with a matching mobile as well). */
export function namesAgree(a: string | null, b: string | null): boolean {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return false;
  return x.some((w) => w.length >= 3 && y.includes(w));
}

export function matchBooking(v: Arrived, b: Bk): MatchKind | null {
  if (b.patientId != null) return b.patientId === v.patientId ? "linked" : null;
  if (b.mrd && v.mrd && b.mrd.trim().toUpperCase() === v.mrd.trim().toUpperCase()) return "mrd";
  const pv = tail10(v.phone), pb = tail10(b.phone);
  if (pv && pv === pb && namesAgree(v.name, b.name)) return "phone_name";
  return null;
}

/** One booking per patient who came, each booking used once; linked bookings first, then the looser matches. */
export function matchAll(came: Arrived[], bookings: Bk[]): Map<number, { booking: Bk; kind: MatchKind }> {
  const out = new Map<number, { booking: Bk; kind: MatchKind }>(), used = new Set<number>();
  for (const kinds of [["linked"], ["mrd"], ["phone_name"]] as MatchKind[][])
    for (const v of came) {
      if (out.has(v.patientId)) continue;
      for (const b of bookings) {
        if (used.has(b.id)) continue;
        const k = matchBooking(v, b);
        if (k && kinds.includes(k)) { out.set(v.patientId, { booking: b, kind: k }); used.add(b.id); break; }
      }
    }
  return out;
}
