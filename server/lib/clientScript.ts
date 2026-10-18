import { keptUrlParts, type KeptUrlParts } from "./url.js";

// The placeholder the client script uses for its lists (see
// packages/client/src/index.ts). The quotes are part of it, so the
// replacement is a complete JS value, not text inserted into a string.
const PLACEHOLDER = '"__GENUG_KEPT_URL_PARTS__"';

// Writes this deployment's kept query parameters and fragments into the
// client script, once at startup. Every request gets the same bytes, so
// /client.js can be cached for an hour.
//
// These lists are the only deployment setting in client.js, because a
// cached old copy does no harm: the server filters again with the
// current lists. At worst a newly kept parameter is lost for up to an
// hour; a parameter the deployment stopped keeping is never stored.
//
// Throws instead of serving the script without the lists: without them
// the client drops every campaign parameter, and nobody would notice.
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
