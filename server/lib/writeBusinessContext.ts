import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  contextPath,
  BUSINESS_CONTEXT_FILE,
  MAX_PROSE_FIELD_BYTES,
} from "./context.js";

// The cockpit's only write to about.md — same shape as
// lib/writeGroundRules.ts (whole-file overwrite, refused rather than
// truncated over the cap) because the two fields are the same kind of
// thing: free prose with no shape to merge against. Kept as its own
// small module rather than a shared helper with the ground-rules
// writer — two call sites is not yet a pattern worth extracting, and
// each field's writer stays simple enough to read on its own.
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
    writeFileSync(join(directory, BUSINESS_CONTEXT_FILE), text, "utf8");
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
