import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderClientScript } from "./clientScript.js";

// The real compiled client, as server/index.ts reads it, so a rename of
// the placeholder on either side fails here rather than at startup.
const compiled = readFileSync(
  fileURLToPath(
    new URL("../../../packages/client/dist/index.js", import.meta.url),
  ),
  "utf8",
);

test("renderClientScript writes the lists into the compiled client", () => {
  const rendered = renderClientScript(compiled, {
    params: ["utm_source", "gclid"],
    hashes: "*",
  });
  assert.ok(!rendered.includes("__GENUG_KEPT_URL_PARTS__"));
  assert.ok(
    rendered.includes('{"params":["utm_source","gclid"],"hashes":"*"}'),
  );
});

// Serving the file unchanged would not break it visibly: the client
// fails closed and drops every campaign parameter on every site.
test("renderClientScript refuses a script without exactly one placeholder", () => {
  const parts = { params: [], hashes: [] };
  assert.throws(() => renderClientScript("var x = 1;", parts), /exactly once/);
  assert.throws(
    () =>
      renderClientScript(
        '"__GENUG_KEPT_URL_PARTS__";"__GENUG_KEPT_URL_PARTS__"',
        parts,
      ),
    /exactly once/,
  );
});

// KEPT_QUERY_PARAMS/KEPT_HASH_VALUES only ban whitespace, commas and
// "*" (see parseKeptList) — a quote, backslash or "</script>" is a
// valid parameter name as far as that check is concerned. This is the
// operator's own env var, not visitor input, but the result still ends
// up as executable JS served to every visitor's browser, so it has to
// stay syntactically inert regardless. new Function throws on invalid
// syntax, which is a cheaper check than loading the whole thing in
// jsdom the way packages/client's own tests do.
test("renderClientScript stays valid, faithful JS for an adversarial value", () => {
  const tricky = ['a"b\\c', "</script><!--", "d'e"];
  const rendered = renderClientScript(compiled, {
    params: tricky,
    hashes: [],
  });
  assert.doesNotThrow(() => new Function(rendered));
  const match = rendered.match(/const KEPT_URL_PARTS = (.*?);/);
  assert.ok(match, "expected the assignment to still be findable");
  assert.deepEqual(JSON.parse(match![1]!), { params: tricky, hashes: [] });
});
