import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  contextPath,
  GROUND_RULES_FILE,
  MAX_PROSE_FIELD_BYTES,
} from "./context.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Saves the cockpit's ground-rules text to ground-rules.md, replacing the
// whole file (it is free prose, so there is nothing to merge). Text over
// the size cap is refused here rather than cut short: the owner is at the
// form and can shorten it. Only a file edited by hand to be too long gets
// cut, when lib/context.ts reads it.
export type WriteGroundRulesResult =
  { ok: true } | { ok: false; error: string };

export function writeGroundRules(
  text: string,
  directory: string = contextPath,
): WriteGroundRulesResult {
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
    writeFileAtomic(join(directory, GROUND_RULES_FILE), text);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
