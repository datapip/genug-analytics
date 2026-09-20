import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  contextPath,
  GROUND_RULES_FILE,
  MAX_PROSE_FIELD_BYTES,
} from "./context.js";

// The cockpit's only write to ground-rules.md: a whole-file overwrite,
// because the file is free prose with no shape to merge against (see
// lib/context.ts). Checked against the same cap the agent's document
// enforces at render time, but refused here rather than truncated —
// truncation is what render time does to a file that changed size after
// it was written; a save from a form has someone right there to shorten
// it instead.
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
    writeFileSync(join(directory, GROUND_RULES_FILE), text, "utf8");
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
