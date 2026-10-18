import { timingSafeEqual } from "node:crypto";

// Compares two secrets in constant time, so the response time doesn't
// reveal how many leading characters were right. timingSafeEqual throws
// when the lengths differ, so the length is checked first. That reveals
// the length but not the content, which is acceptable here.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
