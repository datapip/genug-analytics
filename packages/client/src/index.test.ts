import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Reads the *compiled* output, not src/index.ts — this is the exact
// artifact server/index.ts serves at /client.js, so the test exercises
// what actually ships, not a separate transpilation of it.
const clientScriptSource = readFileSync(
  fileURLToPath(new URL("./index.js", import.meta.url)),
  "utf8",
);

interface BeaconCall {
  url: string;
  blob: Blob;
}

// runScripts: "outside-only" means jsdom builds a real window/document but
// won't auto-run any <script> tags — so mocks (sendBeacon, fetch) can be
// installed before the client script itself is executed via window.eval(),
// which runs it in that window's own global scope (document, navigator,
// etc. all resolve to this window, exactly like a real <script> would).
// document.currentScript is null under eval (no element is being parsed),
// which exercises the same "no <script src>" fallback path documented in
// the client's own endpoint-detection comment.
function loadClient(
  options: {
    htmlAttrs?: string;
    config?: Record<string, unknown>;
    withoutSendBeacon?: boolean;
    // What sendBeacon reports back. false means the browser refused to
    // queue the payload (transfer queue full, or body over the limit),
    // which is a real runtime case distinct from the API being absent.
    beaconResult?: boolean;
    // Simulates the script being inlined rather than loaded via
    // <script src>: document.currentScript is a real element, but its
    // `src` is the empty string.
    inlineScript?: boolean;
    // The pre-load stub's queue, as a hand-written stub on a real site
    // would have left it: calls made before this script finished
    // loading, waiting to be replayed.
    queued?: [string, unknown[]][];
  } = {},
) {
  const html = `<!doctype html><html ${options.htmlAttrs ?? ""}><head></head><body></body></html>`;
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://site.example/page",
  });
  const { window } = dom;

  if (options.config) {
    Object.assign(window, { genugAnalyticsConfig: options.config });
  }

  if (options.queued) {
    Object.assign(window, { genugAnalytics: { q: options.queued } });
  }

  const warnings: string[] = [];
  Object.assign(window, {
    console: { ...window.console, warn: (m: string) => warnings.push(m) },
  });

  const beaconCalls: BeaconCall[] = [];
  const fetchCalls: { url: string; init: Record<string, unknown> }[] = [];

  if (!options.withoutSendBeacon) {
    Object.assign(window.navigator, {
      sendBeacon: (url: string, blob: Blob) => {
        beaconCalls.push({ url, blob });
        return options.beaconResult ?? true;
      },
    });
  }

  if (options.inlineScript) {
    const inline = window.document.createElement("script");
    window.document.head.append(inline);
    // jsdom exposes currentScript as a getter that's null outside real
    // parsing, so it has to be overridden rather than assigned.
    Object.defineProperty(window.document, "currentScript", {
      configurable: true,
      get: () => inline,
    });
  }

  Object.assign(window, {
    fetch: (url: string, init: Record<string, unknown>) => {
      fetchCalls.push({ url, init });
      return Promise.resolve();
    },
  });

  window.eval(clientScriptSource);

  return { window, beaconCalls, fetchCalls, warnings };
}

async function beaconBodies(beaconCalls: BeaconCall[]): Promise<unknown[]> {
  return Promise.all(
    beaconCalls.map(async (call) => JSON.parse(await call.blob.text())),
  );
}

test("track() sends the given event and props via sendBeacon", async () => {
  const { window, beaconCalls } = loadClient();

  (
    window as unknown as {
      genugAnalytics: { track: (e: string, p?: object) => void };
    }
  ).genugAnalytics.track("custom_event", { foo: "bar" });

  assert.equal(beaconCalls.length, 1);
  assert.match(beaconCalls[0]!.url, /\/events$/);
  const [body] = await beaconBodies(beaconCalls);
  // No consent key at all — genugAnalyticsConfig.consent was never set,
  // so this is "not yet answered", not "no". JSON.stringify drops it.
  assert.deepEqual(body, {
    event: "custom_event",
    url: "http://site.example/page",
    referrer: "",
    props: { foo: "bar" },
  });
});

test("track() with an idempotencyKey includes it in the beacon body", async () => {
  const { window, beaconCalls } = loadClient();

  (
    window as unknown as {
      genugAnalytics: {
        track: (e: string, p?: object, idempotencyKey?: string) => void;
      };
    }
  ).genugAnalytics.track("order_completed", { value: 49.9 }, "ORD-1001");

  const [body] = await beaconBodies(beaconCalls);
  assert.deepEqual(body, {
    event: "order_completed",
    url: "http://site.example/page",
    referrer: "",
    idempotencyKey: "ORD-1001",
    props: { value: 49.9 },
  });
});

test("setConsent() changes consent on subsequent track() calls without a reload", async () => {
  const { window, beaconCalls } = loadClient();
  const api = (
    window as unknown as {
      genugAnalytics: {
        track: (e: string, p?: object) => void;
        setConsent: (c: boolean) => void;
      };
    }
  ).genugAnalytics;

  api.track("before");
  api.setConsent(true);
  api.track("after");

  const bodies = (await beaconBodies(beaconCalls)) as {
    consent: boolean | undefined;
  }[];
  assert.equal(bodies[0]!.consent, undefined);
  assert.equal(bodies[1]!.consent, true);
});

test("clicking an element with data-genug-on-click sends that event", async () => {
  const { window, beaconCalls } = loadClient();
  const button = window.document.createElement("button");
  button.setAttribute("data-genug-on-click", "cta_click");
  window.document.body.appendChild(button);

  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(beaconCalls.length, 1);
  const [body] = (await beaconBodies(beaconCalls)) as {
    event: string;
    props: unknown;
  }[];
  assert.equal(body!.event, "cta_click");
  assert.deepEqual(body!.props, {});
});

test("clicking with data-genug-props sends the parsed props", async () => {
  const { window, beaconCalls } = loadClient();
  const button = window.document.createElement("button");
  button.setAttribute("data-genug-on-click", "cta_click");
  button.setAttribute("data-genug-props", '{"plan":"pro"}');
  window.document.body.appendChild(button);

  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const [body] = (await beaconBodies(beaconCalls)) as { props: unknown }[];
  assert.deepEqual(body!.props, { plan: "pro" });
});

test("malformed data-genug-props sends empty props instead of crashing", async () => {
  const { window, beaconCalls } = loadClient();
  const button = window.document.createElement("button");
  button.setAttribute("data-genug-on-click", "cta_click");
  button.setAttribute("data-genug-props", "not json");
  window.document.body.appendChild(button);

  assert.doesNotThrow(() => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  const [body] = (await beaconBodies(beaconCalls)) as { props: unknown }[];
  assert.deepEqual(body!.props, {});
});

test("clicking a child of a tagged element still tracks it, via closest()", async () => {
  const { window, beaconCalls } = loadClient();
  const button = window.document.createElement("button");
  button.setAttribute("data-genug-on-click", "cta_click");
  const icon = window.document.createElement("span");
  button.appendChild(icon);
  window.document.body.appendChild(button);

  icon.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(beaconCalls.length, 1);
});

test("clicking an untagged element sends nothing", async () => {
  const { window, beaconCalls } = loadClient();
  const div = window.document.createElement("div");
  window.document.body.appendChild(div);

  div.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(beaconCalls.length, 0);
});

test("no config and no attribute: nothing fires automatically on load", () => {
  const { beaconCalls } = loadClient();
  assert.equal(beaconCalls.length, 0);
});

test("enableAutoPageTracking: true fires the built-in page_view event", async () => {
  const { beaconCalls } = loadClient({
    config: { enableAutoPageTracking: true },
  });

  assert.equal(beaconCalls.length, 1);
  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.equal(body!.auto, "pageView");
  assert.equal(body!.event, undefined);
});

test("data-genug-on-load on <html> fires that custom event automatically", async () => {
  const { beaconCalls } = loadClient({
    htmlAttrs:
      'data-genug-on-load="product_viewed" data-genug-props=\'{"sku":"abc"}\'',
  });

  assert.equal(beaconCalls.length, 1);
  const [body] = (await beaconBodies(beaconCalls)) as {
    event: string;
    props: unknown;
  }[];
  assert.equal(body!.event, "product_viewed");
  assert.deepEqual(body!.props, { sku: "abc" });
});

test("data-genug-on-load takes priority over enableAutoPageTracking, firing only once", async () => {
  const { beaconCalls } = loadClient({
    htmlAttrs: 'data-genug-on-load="product_viewed"',
    config: { enableAutoPageTracking: true },
  });

  assert.equal(beaconCalls.length, 1);
  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.equal(body!.event, "product_viewed");
});

test("falls back to fetch when sendBeacon is unavailable", async () => {
  const { window, fetchCalls } = loadClient({ withoutSendBeacon: true });

  Object.assign(window.navigator, { sendBeacon: undefined });
  (
    window as unknown as { genugAnalytics: { track: (e: string) => void } }
  ).genugAnalytics.track("custom_event");

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]!.url, /\/events$/);
  assert.equal(fetchCalls[0]!.init.method, "POST");
  assert.equal(fetchCalls[0]!.init.credentials, "include");
  assert.equal(fetchCalls[0]!.init.keepalive, true);
});

// Distinct from the case above: the API exists, but the browser refused
// to queue this particular payload. Before this was handled, those
// events were dropped with no fallback and no error.
test("falls back to fetch when sendBeacon returns false", async () => {
  const { window, beaconCalls, fetchCalls } = loadClient({
    beaconResult: false,
  });

  (
    window as unknown as { genugAnalytics: { track: (e: string) => void } }
  ).genugAnalytics.track("custom_event");

  assert.equal(beaconCalls.length, 1, "sendBeacon should still be attempted");
  assert.equal(fetchCalls.length, 1, "and the refusal should fall back");
  assert.match(fetchCalls[0]!.url, /\/events$/);
  assert.equal(fetchCalls[0]!.init.credentials, "include");
});

test("does not fall back to fetch when sendBeacon accepts the payload", () => {
  const { window, beaconCalls, fetchCalls } = loadClient();

  (
    window as unknown as { genugAnalytics: { track: (e: string) => void } }
  ).genugAnalytics.track("custom_event");

  assert.equal(beaconCalls.length, 1);
  assert.equal(fetchCalls.length, 0, "no double-send");
});

// An inlined <script> has a real currentScript whose src is "", and
// new URL("") throws — which used to escape the IIFE and leave
// window.genugAnalytics undefined, so nothing tracked at all.
test("still initialises when inlined, with no <script src> to read", async () => {
  const { window, beaconCalls } = loadClient({ inlineScript: true });

  const api = (
    window as unknown as {
      genugAnalytics?: { track: (e: string) => void };
    }
  ).genugAnalytics;

  assert.ok(
    api,
    "window.genugAnalytics should be defined for an inlined script",
  );
  api.track("custom_event");

  assert.equal(beaconCalls.length, 1);
  // No origin to derive, so the endpoint is relative to the current page.
  assert.equal(beaconCalls[0]!.url, "/events");
});

// The pre-load stub: a site's own inline code may call track() before
// this script has finished loading, which would otherwise throw on an
// undefined window.genugAnalytics.
function installStub(window: JSDOM["window"]) {
  window.eval(`
    window.genugAnalytics = {
      q: [],
      track: function () {
        window.genugAnalytics.q.push(["track", [].slice.call(arguments)]);
      },
      setConsent: function () {
        window.genugAnalytics.q.push(["setConsent", [].slice.call(arguments)]);
      },
    };
  `);
}

test("replays track() calls queued by the stub before the script loaded", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      runScripts: "outside-only",
      url: "http://site.example/page",
    },
  );
  const { window } = dom;
  const beaconCalls: BeaconCall[] = [];
  Object.assign(window.navigator, {
    sendBeacon: (url: string, blob: Blob) => {
      beaconCalls.push({ url, blob });
      return true;
    },
  });

  installStub(window);
  const early = window as unknown as {
    genugAnalytics: { track: (e: string, p?: object) => void };
  };
  early.genugAnalytics.track("early_event", { when: "before_load" });
  assert.equal(
    beaconCalls.length,
    0,
    "nothing sent while only the stub exists",
  );

  window.eval(clientScriptSource);

  assert.equal(beaconCalls.length, 1, "the queued call is replayed on init");
  const [body] = (await beaconBodies(beaconCalls)) as {
    event: string;
    props: unknown;
  }[];
  assert.equal(body!.event, "early_event");
  assert.deepEqual(body!.props, { when: "before_load" });
});

// The ordering guarantee that actually matters: consent granted before
// the script loaded must apply to everything replayed after it.
test("a queued setConsent applies to calls queued after it", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      runScripts: "outside-only",
      url: "http://site.example/page",
    },
  );
  const { window } = dom;
  const beaconCalls: BeaconCall[] = [];
  Object.assign(window.navigator, {
    sendBeacon: (url: string, blob: Blob) => {
      beaconCalls.push({ url, blob });
      return true;
    },
  });

  installStub(window);
  const early = window as unknown as {
    genugAnalytics: {
      track: (e: string) => void;
      setConsent: (c: boolean) => void;
    };
  };
  early.genugAnalytics.track("before_consent");
  early.genugAnalytics.setConsent(true);
  early.genugAnalytics.track("after_consent");

  window.eval(clientScriptSource);

  const bodies = (await beaconBodies(beaconCalls)) as {
    event: string;
    consent: boolean | undefined;
  }[];
  assert.deepEqual(
    bodies.map((b) => [b.event, b.consent]),
    [
      ["before_consent", undefined],
      ["after_consent", true],
    ],
  );
});

test("the stub's queue is replaced by the real API once loaded", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      runScripts: "outside-only",
      url: "http://site.example/page",
    },
  );
  const { window } = dom;
  const beaconCalls: BeaconCall[] = [];
  Object.assign(window.navigator, {
    sendBeacon: (url: string, blob: Blob) => {
      beaconCalls.push({ url, blob });
      return true;
    },
  });

  installStub(window);
  window.eval(clientScriptSource);

  const api = window as unknown as {
    genugAnalytics: { track: (e: string) => void; q?: unknown[] };
  };
  assert.equal(api.genugAnalytics.q, undefined, "no queue on the real API");

  api.genugAnalytics.track("after_load");
  assert.equal(beaconCalls.length, 1, "sent directly, not queued");
});

test("still works with no stub present at all", () => {
  const { window, beaconCalls } = loadClient();
  (
    window as unknown as { genugAnalytics: { track: (e: string) => void } }
  ).genugAnalytics.track("normal");
  assert.equal(beaconCalls.length, 1);
});

// A tag manager alongside a hardcoded tag, or a CMS theme alongside a
// plugin, is how an analytics script routinely ends up on a page twice.
// Nothing on a stored row distinguishes the duplicate, so the inflation
// is both permanent and invisible — exactly the failure mode this
// project cares most about. The stub path is covered by the tests above:
// if the guard mistook a stub for an already-installed API, every one of
// them would stop firing.
// Stripped in the browser, so a token in the address bar never reaches
// the network at all. The server strips the same set again for callers
// that aren't this script.
test("track() strips non-campaign query parameters from the url", async () => {
  const { window, beaconCalls } = loadClient();
  window.history.replaceState(
    {},
    "",
    "/checkout?token=secret123&utm_source=news&q=typed",
  );
  (
    window as unknown as { genugAnalytics: { track: (e: string) => void } }
  ).genugAnalytics.track("page_view");

  const [body] = (await beaconBodies(beaconCalls)) as { url: string }[];
  assert.equal(body!.url, "http://site.example/checkout?utm_source=news");
});

test("a second copy of the script on the same page changes nothing", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoPageTracking: true },
  });
  assert.equal(beaconCalls.length, 1);

  window.eval(clientScriptSource);
  assert.equal(
    beaconCalls.length,
    1,
    "the second copy fired a page view of its own",
  );

  const button = window.document.createElement("button");
  button.setAttribute("data-genug-on-click", "cta_click");
  window.document.body.appendChild(button);
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(
    beaconCalls.length,
    2,
    "one click was picked up by two sets of listeners",
  );
  const bodies = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.equal(bodies[1]!.event, "cta_click");
});

function clickLink(
  window: JSDOM["window"],
  attrs: Record<string, string>,
  text = "Link",
  eventInit: Record<string, unknown> = {},
) {
  const a = window.document.createElement("a");
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = text;
  window.document.body.appendChild(a);
  a.dispatchEvent(
    new window.MouseEvent((eventInit.type as string) ?? "click", {
      bubbles: true,
      ...eventInit,
    }),
  );
  return a;
}

test("auto link tracking is off unless enableAutoLinkTracking is set", () => {
  const { window, beaconCalls } = loadClient();
  clickLink(window, { href: "https://other.example/page" });
  assert.equal(beaconCalls.length, 0);
});

test("an outbound link fires outbound_link_click with its host", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(
    window,
    { href: "https://partner.example/pricing" },
    "  See\n  our partner  ",
  );

  assert.equal(beaconCalls.length, 1);
  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
    props: Record<string, string>;
  }[];
  assert.equal(body!.auto, "outboundClick");
  assert.equal(body!.props.target_url, "https://partner.example/pricing");
  assert.equal(body!.props.target_host, "partner.example");
  // whitespace collapsed, not passed through as authored
  assert.equal(body!.props.link_text, "See our partner");
});

test("a same-origin link fires nothing", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "/pricing" });
  assert.equal(beaconCalls.length, 0);
});

test("a link to a known file extension fires file_download", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "/docs/Price-List.PDF" }, "Download");

  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
    props: Record<string, string>;
  }[];
  assert.equal(body!.auto, "fileDownload");
  assert.equal(body!.props.file_extension, "pdf", "lowercased");
  assert.equal(body!.props.link_text, "Download");
});

// A signed download link or a partner link carrying ?email= is the same
// leak as a page URL carrying one, so both link props go through the
// page URL's allowlist.
test("link and download URLs keep only campaign parameters and no fragment", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, {
    href: "https://files.example/invoice.pdf?token=secret&utm_source=mail#sig=x",
  });
  clickLink(window, {
    href: "https://partner.example/signup?email=a%40b.example&ref=us#access_token=y",
  });

  const [download, outbound] = (await beaconBodies(beaconCalls)) as {
    props: Record<string, string>;
  }[];
  assert.equal(
    download!.props.file_url,
    "https://files.example/invoice.pdf?utm_source=mail",
  );
  assert.equal(
    outbound!.props.target_url,
    "https://partner.example/signup?ref=us",
  );
});

test("a download attribute fires file_download even with no extension", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "/generate/report", download: "" });

  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
    props: Record<string, string>;
  }[];
  assert.equal(body!.auto, "fileDownload");
  assert.equal(body!.props.file_extension, "");
});

// The documented precedence: downloading the file is what the visitor
// did; whose server it sat on is incidental.
test("an outbound file link is a download, not an outbound click", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "https://other.example/whitepaper.pdf" });

  assert.equal(beaconCalls.length, 1, "one event, not both");
  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.equal(body!.auto, "fileDownload");
});

test("non-navigation protocols are ignored", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  for (const href of ["mailto:hi@example.com", "tel:+441234", "#section"]) {
    clickLink(window, { href });
  }
  assert.equal(beaconCalls.length, 0);
});

test("clicking an icon inside an outbound link still tracks it", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  const a = window.document.createElement("a");
  a.href = "https://other.example/";
  const icon = window.document.createElement("span");
  a.appendChild(icon);
  window.document.body.appendChild(a);

  icon.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(beaconCalls.length, 1);
});

// Middle-click ("open in new tab") never fires a plain click event, so
// without auxclick a common way of following outbound links is invisible.
test("middle-click on an outbound link is tracked", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "https://other.example/" }, "Link", {
    type: "auxclick",
    button: 1,
  });
  assert.equal(beaconCalls.length, 1);
});

test("right-click on an outbound link is NOT tracked", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "https://other.example/" }, "Link", {
    type: "auxclick",
    button: 2,
  });
  assert.equal(beaconCalls.length, 0, "opening a context menu is not a visit");
});

// Both the data-attribute listener and the link listener match a tagged
// outbound link. Before this, one click produced two rows.
test("a tagged link fires only its tagged event, not also the automatic one", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, {
    href: "https://other.example/x",
    "data-genug-on-click": "partner_cta",
    "data-genug-props": '{"plan":"pro"}',
  });

  assert.equal(beaconCalls.length, 1, "one click, one event");
  const [body] = (await beaconBodies(beaconCalls)) as {
    event: string;
    props: unknown;
  }[];
  assert.equal(body!.event, "partner_cta");
  assert.deepEqual(body!.props, { plan: "pro" });
});

test("tagging a link with the same event name doesn't double-count it", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, {
    href: "https://other.example/x",
    "data-genug-on-click": "outbound_link_click",
    "data-genug-props":
      '{"target_url":"https://other.example/x","target_host":"other.example","link_text":"Partner"}',
  });

  assert.equal(beaconCalls.length, 1);
});

// The deliberate boundary: a tagged *ancestor* describes something other
// than the link click, so both are still recorded.
test("an outbound link inside a tagged container fires both events", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  const card = window.document.createElement("div");
  card.setAttribute("data-genug-on-click", "card_click");
  const a = window.document.createElement("a");
  a.href = "https://other.example/x";
  a.textContent = "Read more";
  card.appendChild(a);
  window.document.body.appendChild(card);

  a.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const events = (
    (await beaconBodies(beaconCalls)) as { event?: string; auto?: string }[]
  ).map((b) => b.event);
  assert.deepEqual(events, ["card_click", undefined]);
});

test("an untagged link still fires the automatic event", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, { href: "https://other.example/x" });
  assert.equal(beaconCalls.length, 1);
});

// An empty attribute fires nothing from the tagged listener, so it must
// not suppress the automatic one either — otherwise the click vanishes.
test("an empty data-genug-on-click does not suppress the automatic event", () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoLinkTracking: true },
  });
  clickLink(window, {
    href: "https://other.example/x",
    "data-genug-on-click": "",
  });
  assert.equal(beaconCalls.length, 1);
});

// --- what the client sends for the events it fires itself ----------

// The point of the role: this script does not know what a deployment
// calls these three, and no longer needs to. It used to be told, by a
// preamble the server prepended to the file — which made the file
// deployment-specific, capped how long it could be cached, and meant a
// cached copy went on firing a name that a rename had made invalid.
test("the three auto-fired events send a role and never a name", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoPageTracking: true, enableAutoLinkTracking: true },
  });

  clickLink(window, { href: "https://other.example/x" });
  clickLink(window, { href: "/report.pdf" });

  const bodies = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.deepEqual(
    bodies.map((b) => b.auto),
    ["pageView", "outboundClick", "fileDownload"],
  );
  for (const body of bodies) {
    assert.equal(body.event, undefined, "a role and a name are exclusive");
  }
});

// The other direction: anything the deployment names itself still
// travels as a name, because only these three roles exist.
test("a tracked or tagged event sends its name and no role", async () => {
  const { window, beaconCalls } = loadClient();

  (
    window as unknown as {
      genugAnalytics: { track: (event: string) => void };
    }
  ).genugAnalytics.track("newsletter_signup");
  const [body] = (await beaconBodies(beaconCalls)) as {
    event?: string;
    auto?: string;
  }[];
  assert.equal(body!.event, "newsletter_signup");
  assert.equal(body!.auto, undefined);
});

// The flags being off must stay silent — a warning would fire on every
// page of every deployment that simply doesn't use these features.
test("no warnings when the auto-tracking flags are off", () => {
  const { warnings } = loadClient();
  assert.deepEqual(warnings, []);
});

// --- SPA route tracking (enableAutoRouteTracking) ---

// Two waits, because a test expecting an event and a test expecting
// silence need opposite things from the clock.
//
// Both delays here are real: the client defers its route event by a
// tick on purpose (see installRouteTracking), and jsdom dispatches
// popstate asynchronously on top of that. Measured, jsdom's traversal
// lands anywhere between 8ms and 31ms — so the single fixed 20ms wait
// these tests used to share was a coin flip. It failed ~8 runs in 10
// locally for the back/forward case, and passed on CI only by landing
// on the fast side of the same race.
const TRAVERSAL_CEILING_MS = 250;

// Expecting an event: poll until it arrives, so the test is as fast as
// the run allows and only fails if the event genuinely never comes.
async function waitForBeacons(
  beaconCalls: readonly unknown[],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + TRAVERSAL_CEILING_MS;
  while (beaconCalls.length < expected) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${expected} beacon(s); saw ${beaconCalls.length}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // One more turn, so an unwanted extra beacon has a chance to show up
  // and fail the count assertion rather than arriving after it.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// Expecting silence: there is nothing to poll for, so this has to be a
// fixed wait, and it has to clear the ceiling above. At 20ms these
// tests could assert before jsdom had even run the traversal — passing
// without exercising the thing they exist to check.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TRAVERSAL_CEILING_MS));
}

const ROUTE_CONFIG = {
  enableAutoPageTracking: true,
  enableAutoRouteTracking: true,
};

type PageBody = {
  event?: string;
  auto?: string;
  url: string;
  props: { page_title: string };
};

test("route tracking is off unless enableAutoRouteTracking is set", async () => {
  const { window, beaconCalls } = loadClient({
    config: { enableAutoPageTracking: true },
  });

  window.history.pushState({}, "", "/pricing");
  await settle();

  assert.equal(beaconCalls.length, 1, "only the initial load");
});

test("a pushState route change fires a page event at the new URL", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });
  assert.equal(beaconCalls.length, 1, "the initial load");

  window.history.pushState({}, "", "/pricing");
  await waitForBeacons(beaconCalls, 2);

  const bodies = (await beaconBodies(beaconCalls)) as PageBody[];
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.auto, "pageView");
  assert.equal(bodies[1]!.url, "http://site.example/pricing");
});

test("back and forward navigation fires a page event", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.pushState({}, "", "/pricing");
  await waitForBeacons(beaconCalls, 2);
  window.history.back();
  await waitForBeacons(beaconCalls, 3);

  const bodies = (await beaconBodies(beaconCalls)) as PageBody[];
  assert.deepEqual(
    bodies.map((b) => b.url),
    [
      "http://site.example/page",
      "http://site.example/pricing",
      "http://site.example/page",
    ],
  );
});

// replaceState means "rewrite the current entry" — canonicalising a URL,
// stripping a token, storing filter state — not a visit.
test("replaceState fires nothing", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.replaceState({}, "", "/page?sort=price");
  await settle();

  assert.equal(beaconCalls.length, 1, "only the initial load");
});

test("pushing the route already showing fires nothing", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.pushState({}, "", "/page");
  await settle();

  assert.equal(beaconCalls.length, 1, "only the initial load");
});

// An anchor jump is not a navigation — counting it would fire a page
// event for every "back to top" link, on the way there and on the way
// back through history.
test("a hash-only change fires nothing, in either direction", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.pushState({}, "", "/page#faq");
  await settle();
  window.history.back();
  await settle();

  assert.equal(beaconCalls.length, 1, "only the initial load");
});

// A route guard redirecting /old to /new pushes twice in one tick. The
// visitor never saw /old, so recording it would be a page view that
// didn't happen.
test("two pushes in one tick fire one event, at the final URL", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.pushState({}, "", "/old");
  window.history.pushState({}, "", "/new");
  await waitForBeacons(beaconCalls, 2);

  const bodies = (await beaconBodies(beaconCalls)) as PageBody[];
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]!.url, "http://site.example/new");
});

// The main reason the event is deferred: frameworks update the title in
// an effect that runs after the route change, so firing inline would
// record the previous page's title against the new URL.
test("the title is read after the framework has updated it", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });
  window.document.title = "Home";

  window.history.pushState({}, "", "/pricing");
  window.document.title = "Pricing";
  await waitForBeacons(beaconCalls, 2);

  const bodies = (await beaconBodies(beaconCalls)) as PageBody[];
  assert.equal(bodies[1]!.props.page_title, "Pricing");
});

// The attribute is the load opt-in on its own, so it's also enough for
// route tracking — and its props are re-read, not replayed from load.
test("route changes re-fire data-genug-on-load, with fresh props", async () => {
  const { window, beaconCalls } = loadClient({
    htmlAttrs:
      'data-genug-on-load="screen_open" data-genug-props=\'{"section":"home"}\'',
    config: { enableAutoRouteTracking: true },
  });

  window.document.documentElement.dataset.genugProps = '{"section":"pricing"}';
  window.history.pushState({}, "", "/pricing");
  await waitForBeacons(beaconCalls, 2);

  const bodies = (await beaconBodies(beaconCalls)) as {
    event: string;
    props: unknown;
  }[];
  assert.deepEqual(
    bodies.map((b) => b.event),
    ["screen_open", "screen_open"],
  );
  assert.deepEqual(bodies[1]!.props, { section: "pricing" });
});

// It repeats a page load; with no page load configured there's nothing
// for it to repeat.
test("route tracking warns and tracks nothing with no load opt-in", async () => {
  const { window, beaconCalls, warnings } = loadClient({
    config: { enableAutoRouteTracking: true },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /enableAutoRouteTracking/);
  assert.match(warnings[0]!, /enableAutoPageTracking/);

  window.history.pushState({}, "", "/pricing");
  await settle();
  assert.equal(beaconCalls.length, 0);
});

// Wrapping pushState must not change what it does for the site itself.
test("the wrapped pushState still stores the state the site passed", async () => {
  const { window, beaconCalls } = loadClient({ config: ROUTE_CONFIG });

  window.history.pushState({ step: 2 }, "", "/checkout");
  await waitForBeacons(beaconCalls, 2);

  assert.deepEqual(window.history.state, { step: 2 });
  assert.equal(beaconCalls.length, 2);
});

interface OptOutApi {
  track: (e: string, p?: object) => void;
  optOut: () => void;
  optIn: () => void;
  isOptedOut: () => boolean;
}

function optOutApi(window: { genugAnalytics?: unknown }): OptOutApi {
  return (window as { genugAnalytics?: unknown })
    .genugAnalytics as unknown as OptOutApi;
}

test("optOut() stops every later send, and sends one request to clear the cookie", async () => {
  const { window, beaconCalls } = loadClient();
  const api = optOutApi(window);

  api.optOut();

  // The one request opting out is allowed to make: no event, no url, no
  // referrer. The server stores nothing for it and only clears the
  // visitor-id cookie, which page JavaScript cannot delete itself.
  assert.equal(beaconCalls.length, 1);
  assert.deepEqual(await beaconBodies(beaconCalls), [{ optOut: true }]);

  api.track("after_opt_out");
  assert.equal(beaconCalls.length, 1, "nothing may be sent after opting out");
});

// Re-running the script in the same document is what a reload does to
// this file: everything in its closure starts over, and the only thing
// carried across is the cookie — which is the whole reason a cookie is
// what holds the decision.
test("opting out survives a reload, and opting back in resumes sending", () => {
  const { window, beaconCalls } = loadClient();
  optOutApi(window).optOut();
  const afterOptOut = beaconCalls.length;

  window.eval(clientScriptSource);

  assert.equal(optOutApi(window).isOptedOut(), true);
  optOutApi(window).track("still_opted_out");
  assert.equal(beaconCalls.length, afterOptOut);

  optOutApi(window).optIn();
  assert.equal(optOutApi(window).isOptedOut(), false);
  optOutApi(window).track("opted_back_in");
  assert.equal(beaconCalls.length, afterOptOut + 1);
});

// The automatic trackers don't go through track(), so a gate that only
// covered the public method would still send exactly the events a
// visitor objecting is most likely to mean.
test("opting out silences the automatic page view too", () => {
  const { window, beaconCalls } = loadClient();
  optOutApi(window).optOut();
  const afterOptOut = beaconCalls.length;

  Object.assign(window, {
    genugAnalyticsConfig: { enableAutoPageTracking: true },
  });
  window.eval(clientScriptSource);

  assert.equal(beaconCalls.length, afterOptOut);
});

test("a queued optOut() from the pre-load stub is honoured, not warned about", async () => {
  const { window, beaconCalls, warnings } = loadClient({
    queued: [["optOut", []]],
  });

  assert.deepEqual(warnings, []);
  assert.equal(optOutApi(window).isOptedOut(), true);
  assert.deepEqual(await beaconBodies(beaconCalls), [{ optOut: true }]);
});
