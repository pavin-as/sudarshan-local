// Reserved slot blocks (the Google app's generalSettings columns, imported as app.settings 'general.*').
// Each entry is day-from-to-days, e.g. "W-09:00-12:20-0" = Wednesday 09:00-12:20; day D = every day; the last number
// was how far ahead the hold applied in the Google app (Code.js getSpecializedIntervals). In Sudarshan (Pavin, 19 Oct):
// a booking of another kind in a held slot is a warning that can be ignored; HFA slots are the exception - other plans
// are refused until 2 days before the appointment date (services/booking.ts).
import type { Db } from "../db.js";
import { q } from "../db.js";
import { toMin } from "../lib/time.js";

export type BlockKind = "HFA" | "ROP" | "INJECTION" | "LASER" | "DILATION" | "EMERGENCY" | "URGENT NEW";
export interface Block { kind: BlockKind; day: string; start: string; end: string; days: number }

/** setting name -> what the slots are held for ("General Block" is the HFA hold for general bookings, now the HFA rule) */
export const BLOCK_SETTINGS: Record<string, BlockKind> = {
  "general.HFA Slot": "HFA", "general.ROP Slot": "ROP", "general.Injection Slot": "INJECTION", "general.Laser": "LASER",
  "general.DILATATION": "DILATION", "general.Emergency slot": "EMERGENCY", "general.Urgent New": "URGENT NEW",
};
export const BLOCK_WORDS: Record<BlockKind, string> = {
  HFA: "HFA", ROP: "ROP", INJECTION: "injections", LASER: "laser", DILATION: "dilation", EMERGENCY: "emergencies", "URGENT NEW": "urgent new patients",
};
/** HFA slots open to other plans from this many days before the appointment date. */
export const HFA_OPEN_DAYS_BEFORE = 2;

const DAY_CODES = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];          // Google app getDayCode, Sunday first
export const dayCodeOf = (date: string) => DAY_CODES[new Date(date + "T00:00:00Z").getUTCDay()];

/** "W-09:00-12:20-0" -> block; "D-17:30-17:40--1" -> days -1. Anything else (lists, notes) -> null. */
export function parseBlock(kind: BlockKind, raw: string): Block | null {
  const m = /^\s*(D|M|Tu|W|Th|F|Sa|Su)\s*-\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*-\s*(-?\d+)\s*$/i.exec(raw);
  if (!m) return null;
  const pad = (t: string) => t.padStart(5, "0");
  const day = m[1].length === 1 ? m[1].toUpperCase() : m[1][0].toUpperCase() + m[1][1].toLowerCase();
  if (toMin(pad(m[3])) <= toMin(pad(m[2]))) return null;
  return { kind, day, start: pad(m[2]), end: pad(m[3]), days: Number(m[4]) };
}

export function blocksFromSettings(rows: { key: string; value: unknown }[]): Block[] {
  const out: Block[] = [];
  for (const r of rows) {
    const kind = BLOCK_SETTINGS[r.key];
    if (!kind) continue;
    const items = (Array.isArray(r.value) ? r.value : [r.value]).flatMap((x) => String(x ?? "").split(","));
    for (const it of items) { const b = parseBlock(kind, it); if (b) out.push(b); }
  }
  return out;
}

export async function loadBlocks(db?: Db): Promise<Block[]> {
  return blocksFromSettings(await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM app.settings WHERE key = ANY($1)`, [Object.keys(BLOCK_SETTINGS)], db));
}

/** Blocks that hold a slot on a date. */
export function blocksAt(blocks: Block[], date: string, slot: string): Block[] {
  const code = dayCodeOf(date), m = toMin(slot);
  return blocks.filter((b) => (b.day === "D" || b.day === code) && m >= toMin(b.start) && m < toMin(b.end));
}
