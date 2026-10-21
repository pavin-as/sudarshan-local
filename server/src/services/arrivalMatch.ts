// Which of today's bookings belongs to a patient who came (D-036). A booking made for a new patient has no Yarago
// patient yet (only a temporary NDC_ ID), so the patient ID cannot match it. Order: Yarago patient ID, then the same
// MRD, then the same mobile number with a compatible name. A match is never written; staff link the booking.
export interface Bk { id: number; patientId: number | null; mrd: string | null; phone: string | null; name: string; slotTime?: string | null; planOfAction?: string | null }
export interface Arrived { patientId: number; mrd: string | null; phone: string | null; name: string | null }
export type MatchKind = "linked" | "mrd" | "phone_name";

const tail10 = (p: string | null | undefined) => { const d = (p ?? "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const words = (n: string | null | undefined) => (n ?? "").toLowerCase().replace(/\b(mr|mrs|ms|dr|master|baby|smt|shri)\b\.?/g, " ")
  .replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

const lev = (a: string, b: string) => {
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};

/** 0 to 1: how alike two names are, by their best pair of words of three or more letters. The Yarago desk and the
 *  booking often spell a name differently (SAIDALI / SAIDALAVI, ZAINABA / SAINABA), so near spellings count. */
export function nameScore(a: string | null, b: string | null): number {
  const x = words(a).filter((w) => w.length >= 3), y = words(b).filter((w) => w.length >= 3);
  let best = 0;
  for (const u of x) for (const v of y) best = Math.max(best, 1 - lev(u, v) / Math.max(u.length, v.length));
  return best;
}
export const NAME_OK = 0.7;
export const namesAgree = (a: string | null, b: string | null) => nameScore(a, b) >= NAME_OK;

export function matchBooking(v: Arrived, b: Bk): MatchKind | null {
  if (b.patientId != null) return b.patientId === v.patientId ? "linked" : null;
  if (b.mrd && v.mrd && b.mrd.trim().toUpperCase() === v.mrd.trim().toUpperCase()) return "mrd";
  const pv = tail10(v.phone), pb = tail10(b.phone);
  if (pv && pv === pb && namesAgree(v.name, b.name)) return "phone_name";
  return null;
}

/** One booking per patient who came, each booking used once: linked, then same MRD, then same mobile with the most
 *  alike names first (so two bookings on one family phone go to the right two people). */
export function matchAll(came: Arrived[], bookings: Bk[]): Map<number, { booking: Bk; kind: MatchKind }> {
  const out = new Map<number, { booking: Bk; kind: MatchKind }>(), used = new Set<number>();
  const take = (v: Arrived, b: Bk, kind: MatchKind) => { out.set(v.patientId, { booking: b, kind }); used.add(b.id); };
  for (const kind of ["linked", "mrd"] as MatchKind[])
    for (const v of came) {
      if (out.has(v.patientId)) continue;
      const b = bookings.find((x) => !used.has(x.id) && matchBooking(v, x) === kind);
      if (b) take(v, b, kind);
    }
  const pairs: { v: Arrived; b: Bk; score: number }[] = [];
  for (const v of came) if (!out.has(v.patientId))
    for (const b of bookings) if (!used.has(b.id) && matchBooking(v, b) === "phone_name") pairs.push({ v, b, score: nameScore(v.name, b.name) });
  for (const { v, b } of pairs.sort((p, q) => q.score - p.score))
    if (!out.has(v.patientId) && !used.has(b.id)) take(v, b, "phone_name");
  return out;
}
