import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";

const ROUNDS = 12;
// A real hash of a random string, so a login for an unknown user takes as long as a real one.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-" + randomInt(1e9), ROUNDS);

export const hashPassword = (pw: string) => bcrypt.hash(pw, ROUNDS);

export async function verifyPassword(pw: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) { await bcrypt.compare(pw, DUMMY_HASH); return false; }
  return bcrypt.compare(pw, hash);
}

/** Returns a reason the password is not acceptable, or null if it is fine. */
export function passwordProblem(pw: string, username: string): string | null {
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password is too long";
  if (pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain your username";
  if (/^(.)\1+$/.test(pw) || /^(12345678|password|sampada|sudarshan)/i.test(pw)) return "Password is too easy to guess";
  return null;
}

/** Temporary password an admin reads out to a staff member: easy to type, no look-alike characters. */
export function temporaryPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyz", digits = "23456789";
  const pick = (s: string) => s[randomInt(s.length)];
  return `${pick(letters).toUpperCase()}${pick(letters)}${pick(letters)}${pick(letters)}-${pick(digits)}${pick(digits)}${pick(digits)}${pick(digits)}`;
}
