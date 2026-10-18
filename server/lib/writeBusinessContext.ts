import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  contextPath,
  BUSINESS_CONTEXT_FILE,
  MAX_PROSE_FIELD_BYTES,
} from "./context.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Saves the cockpit's business-context text to about.md, replacing the
// whole file. Works like lib/writeGroundRules.ts: text over the size cap
// is refused, not cut short, so the owner can shorten it themselves.
export type WriteBusinessContextResult =
  { ok: true } | { ok: false; error: string };

export function writeBusinessContext(
  text: string,
  directory: string = contextPath,
): WriteBusinessContextResult {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PROSE_FIELD_BYTES) {
    return {
      ok: false,
      error:
        `That is ${bytes} bytes, ${bytes - MAX_PROSE_FIELD_BYTES} over ` +
        `the ${MAX_PROSE_FIELD_BYTES}-byte limit. Shorten it and save again.`,
    };
  }

  try {
    mkdirSync(directory, { recursive: true });
    writeFileAtomic(join(directory, BUSINESS_CONTEXT_FILE), text);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
