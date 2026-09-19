import { timingSafeEqual } from "node:crypto";

// timingSafeEqual throws on mismatched buffer lengths rather than
// returning false, so the length check has to happen first — it only
// leaks length, not content, which is an accepted tradeoff here.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
