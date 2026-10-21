// Temporary ID for a new patient who has no MRD yet (D-036): NDC_YYYYMMDD_HHMMSS_<booking id>, in clinic time (IST).
// The date and time are when the booking was first made; the real MRD (SPD...) is given at first registration in Yarago.
const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export function tempMrd(at: Date, bookingId: number): string {
  const p = Object.fromEntries(IST.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return `NDC_${p.year}${p.month}${p.day}_${hour}${p.minute}${p.second}_${bookingId}`;
}

/** True for a temporary ID (ours or the Google app's): a new patient not yet registered. */
export const isTempMrd = (mrd: string | null | undefined) => !!mrd && /^NDC_/i.test(mrd.trim());
