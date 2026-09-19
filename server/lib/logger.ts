// A single-line JSON object per log line, instead of free-text
// console.error/console.log — no dependency added (still just
// console.error/console.log underneath), but now something a real log
// aggregator (or a person grepping raw logs) can parse reliably instead
// of guessing at each call site's own message format. Deliberately
// minimal: two levels, no transports/formatters — this project doesn't
// need more than "every failure path logs the same shape."
export interface LogFields {
  [key: string]: unknown;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function write(level: "info" | "error", msg: string, fields: LogFields): void {
  // JSON.stringify never emits a raw newline for a string field (a stack
  // trace included) — it escapes it as \n — so the line as a whole stays
  // single-line even when `fields.error` spans multiple logical lines.
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logInfo(msg: string, fields: LogFields = {}): void {
  write("info", msg, fields);
}

export function logError(
  msg: string,
  error: unknown,
  fields: LogFields = {},
): void {
  write("error", msg, { ...fields, error: serializeError(error) });
}
