import { keptUrlParts, type KeptUrlParts } from "./url.js";

// The quoted string the client source declares its lists as (see
// packages/client/src/index.ts). Quotes included, so the replacement is
// a whole JS expression and not text spliced into a string literal.
const PLACEHOLDER = '"__GENUG_KEPT_URL_PARTS__"';

// Writes this deployment's query-parameter and fragment lists into the
// compiled client script, once at startup. The result is still the same
// bytes for every request, so the hour-long cache on /client.js holds.
//
// This is the one piece of deployment state client.js carries, and it
// is safe to cache where an event name was not (see AGENTS.md): a
// browser running a copy from before the lists changed strips with the
// old ones, and the server strips again with the current ones. A stale
// copy can lose an hour of a newly kept parameter, never store one the
// deployment stopped keeping.
//
// Throws rather than serving the file unchanged: the client fails closed
// without its lists, so a renamed placeholder would quietly drop every
// campaign parameter on every site using this deployment.
export function renderClientScript(
  source: string,
  parts: KeptUrlParts = keptUrlParts,
): string {
  const at = source.indexOf(PLACEHOLDER);
  if (at === -1 || source.indexOf(PLACEHOLDER, at + 1) !== -1) {
    throw new Error(
      `client script must contain ${PLACEHOLDER} exactly once — was packages/client rebuilt from a different source?`,
    );
  }
  return (
    source.slice(0, at) +
    JSON.stringify(parts) +
    source.slice(at + PLACEHOLDER.length)
  );
}
