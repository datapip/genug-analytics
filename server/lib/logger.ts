// Writes each log entry as one line of JSON, so log tools (and grep) can
// parse every entry the same way. Deliberately minimal: two levels,
// written with console.log and console.error.
export interface LogFields {
  [key: string]: unknown;
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function write(level: "info" | "error", msg: string, fields: LogFields): void {
  // JSON.stringify escapes newlines inside strings as \n, so a multi-line
  // stack trace still produces a single log line.
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
