interface GenugAnalyticsApi {
  // idempotencyKey: a value the site itself knows uniquely identifies
  // this occurrence (e.g. an order id) — pass it for events where a
  // refreshed or back-navigated page firing twice would double-count
  // (a purchase, not a page view). The tracker can't generate this
  // itself: a client-generated id would differ on every refresh and
  // defeat the point, since it has to identify the real-world event,
  // not the beacon.
  track(
    event: string,
    props?: Record<string, unknown>,
    idempotencyKey?: string,
  ): void;
  setConsent(consent: boolean): void;
  // Stops this script sending anything at all, for this browser, until
  // optIn() is called. Distinct from setConsent(false), which is about
  // *how* a visitor is identified and leaves consentless collection
  // running: an opt-out is the Art. 21 objection route a deployment
  // relying on legitimate interest has to offer.
  optOut(): void;
  optIn(): void;
  isOptedOut(): boolean;
  // Present only on the pre-load stub, never on the real API this script
  // installs. A site that calls track() from its own inline code can't
  // rely on this script having loaded yet — it's a separate <script src>
  // and may still be in flight — and calling a method on an undefined
  // object throws. The documented stub (see README) defines
  // window.genugAnalytics up front with methods that just push their
  // arguments here; this script replays them on init and then replaces
  // the stub outright. Untyped args because the stub is hand-written
  // plain JS on the site's own page, not compiled with this file.
  q?: QueuedCall[];
}

type QueuedCall = [method: string, args: unknown[]];

// A plain top-level interface merges directly with the real global
// Window type here (no `declare global` needed) since tsconfig forces
// this import-free file to be treated as a script, not a module.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- global augmentation, not a local type
interface Window {
  genugAnalytics?: GenugAnalyticsApi;
  genugAnalyticsConfig?: {
    // Left unset (rather than false) when your consent manager hasn't
    // answered yet — the server treats "unknown" differently from "no"
    // (see the README's "Embedding the client script").
    consent?: boolean;
    // Default false: no automatic page_view on load — call track()
    // yourself, or use data-genug-on-load on <html> (see below),
    // which fires regardless of this flag. Set true to get the
    // built-in page_view event (title + language) automatically.
    enableAutoPageTracking?: boolean;
    // Default false: no automatic outbound-link or file-download
    // tracking. Set true to fire the built-in outbound_link_click and
    // file_download events (see below).
    enableAutoLinkTracking?: boolean;
    // Default false: in a single-page app, route changes fire nothing,
    // so a visitor who browses ten routes is recorded as seeing one
    // page. Set true to fire a page event on every route change too.
    // Additive rather than a replacement: what fires is decided by the
    // page-load opt-ins above, so on its own this sends nothing.
    enableAutoRouteTracking?: boolean;
  };
}

// Extensions treated as a download when clicked. Necessarily a guess —
// a URL's extension is a hint, not a declaration — so this is
// best-effort in the same documented way as bot detection: it catches
// the ordinary cases and doesn't pretend to be exhaustive. A link
// carrying an explicit `download` attribute skips this list entirely,
// since that one isn't a guess at all.
const DOWNLOAD_EXTENSION =
  /\.(pdf|zip|rar|7z|tar|gz|tgz|doc|docx|xls|xlsx|ppt|pptx|csv|rtf|txt|dmg|exe|msi|pkg|deb|rpm|apk|iso|epub|mp3|wav|mp4|mov|avi|mkv)$/i;

// Long enough to identify which link was clicked, short enough that a
// whole paragraph wrapped in an <a> doesn't become the prop value.
const MAX_LINK_TEXT_LENGTH = 120;

function isDownloadLink(anchor: HTMLAnchorElement): boolean {
  return (
    anchor.hasAttribute("download") || DOWNLOAD_EXTENSION.test(anchor.pathname)
  );
}

function fileExtension(pathname: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  return match ? match[1]!.toLowerCase() : "";
}

// Link text arrives with whatever indentation the page's HTML happens to
// have, so it's collapsed to single spaces — otherwise the same link
// yields different prop values on different pages and fragments any
// grouping by it.
function collapseLinkText(text: string | null): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LINK_TEXT_LENGTH);
}

// Query parameters worth keeping. Everything else is dropped before the
// URL leaves the browser at all: a newsletter link's ?email=, a magic
// link's single-use token, a search page's typed query. The server drops
// the same set again for anything POSTing to /events directly (see
// server/lib/url.ts) — this copy is what keeps it out of the request in
// the first place. The two lists can't be shared: this file is an
// import-free classic script.
const KEPT_QUERY_PARAMS =
  /^(utm_(?:source|medium|campaign|term|content|id)|gclid|fbclid|msclkid|ttclid|ref|source)$/i;

function strippedUrl(href: string): string {
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (!KEPT_QUERY_PARAMS.test(key)) url.searchParams.delete(key);
  }
  // Dropped for the same reason as the parameters above, and kept in
  // step with server/lib/url.ts: an OAuth implicit response, and some
  // reset and unsubscribe links, carry their token in the fragment.
  url.hash = "";
  return url.toString();
}

(function (): void {
  // A second copy of this script on the same page — a tag manager
  // alongside a hardcoded tag, a theme alongside a plugin — would
  // install a second set of listeners and fire a second page event,
  // permanently doubling every count with nothing on the stored row to
  // show it happened. The pre-load stub carries `q`; the API installed
  // below never does, so "present, but with no queue" means an earlier
  // copy already ran and this one must do nothing at all.
  const installed = window.genugAnalytics;
  if (installed && !installed.q) return;

  const scriptEl = document.currentScript as HTMLScriptElement | null;
  // Falls back to a relative path when there's no <script src> URL to
  // read an origin from. Both halves of that check matter: an inlined
  // <script> gives a non-null element whose `src` is the empty string,
  // and `new URL("")` throws — which would escape this IIFE and leave
  // window.genugAnalytics undefined, killing tracking entirely rather than
  // falling back.
  const scriptSrc = scriptEl?.src;
  const endpoint = scriptSrc ? new URL(scriptSrc).origin : "";

  // A real third state, not coerced to a boolean: `undefined` means
  // "not yet answered" and must reach the server as such, since it's
  // handled differently from an explicit `false` (see events.ts).
  // JSON.stringify below drops it from the body entirely when it's
  // undefined, the same way it already drops idempotencyKey.
  let consent = window.genugAnalyticsConfig?.consent;

  // Either a literal event name — what track() and data-genug-on-click
  // carry — or one of the three roles this script fires on its own. A
  // role travels instead of a name because this script does not know
  // what this deployment calls those events, and deliberately no longer
  // has to: the server resolves the role against its own registry, so
  // renaming one of them can never leave a cached copy of this file
  // sending a name that no longer exists.
  type EventIdentity =
    | { event: string; auto?: never }
    | { auto: "pageView" | "outboundClick" | "fileDownload"; event?: never };

  // The opt-out cookie is read before every send and written by
  // optOut()/optIn(). First-party on the tracked site's own domain and
  // deliberately not httpOnly: this script has to be able to read it
  // before deciding to stay silent, and it holds a flag, not an
  // identifier.
  //
  // Storing it is itself writing to the device, which is the thing
  // consentless mode otherwise avoids — but a record of "this person
  // asked not to be tracked" is the one thing you cannot honour
  // without remembering it, and it is exactly the case § 25(2) TDDDG
  // exempts as strictly necessary for a service the user asked for.
  const OPT_OUT_COOKIE = "genug_optout";

  // Chrome caps a JS-set cookie at 400 days regardless, so asking for
  // more would only make the code look like it promised longer.
  const OPT_OUT_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

  function optedOut(): boolean {
    return document.cookie
      .split(";")
      .some((entry) => entry.trim().startsWith(`${OPT_OUT_COOKIE}=1`));
  }

  function writeOptOutCookie(maxAgeSeconds: number): void {
    // Secure only over https: a Secure cookie set on http is discarded
    // silently, which would make opting out fail without saying so on
    // a local or plain-http site.
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie =
      `${OPT_OUT_COOKIE}=1; Max-Age=${maxAgeSeconds}; Path=/; ` +
      `SameSite=Lax${secure}`;
  }

  function send(
    identity: EventIdentity,
    props: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): void {
    // One check, at the single point every event goes through: track(),
    // the automatic page view, link clicks and route changes all end up
    // here, so opting out cannot be defeated by a path that forgot to
    // ask.
    if (optedOut()) return;

    // JSON.stringify drops a key entirely when its value is undefined,
    // so idempotencyKey is simply absent from the body when not given —
    // no separate branch needed for the common (undefined) case. The
    // same is true of whichever half of `identity` isn't set.
    const body = JSON.stringify({
      ...identity,
      consent,
      url: strippedUrl(location.href),
      // "" for a direct visitor, which new URL() would throw on — and an
      // internal navigation's referrer is one of this site's own pages,
      // so it carries exactly the same query strings worth dropping.
      referrer: document.referrer ? strippedUrl(document.referrer) : "",
      idempotencyKey,
      props,
    });
    const blob = new Blob([body], { type: "application/json" });
    post(blob);
  }

  // sendBeacon where it works, fetch where it does not. Shared with
  // optOut(), whose own beacon call used to be unguarded — so on a
  // browser without sendBeacon it threw into the site's own code, after
  // setting the local flag but before the server could clear the
  // httpOnly visitor-id cookie. That is the route a visitor exercises
  // their right to object through, so it is the last one that should
  // depend on an optional API.
  function post(blob: Blob): void {
    const url = `${endpoint}/events`;

    // sendBeacon doesn't only fail by being absent: it returns false
    // when the browser refuses to queue the payload (its transfer queue
    // is full, or the body is over the per-origin limit). Treating that
    // the same as "unavailable" means those events fall back to fetch
    // instead of being dropped without a trace.
    if (!navigator.sendBeacon || !navigator.sendBeacon(url, blob)) {
      // sendBeacon includes cookies by default; fetch needs this
      // explicitly for the cross-subdomain visitor-id cookie to ride along.
      fetch(url, {
        method: "POST",
        body: blob,
        keepalive: true,
        credentials: "include",
      }).catch(() => {});
    }
  }

  // Shared by both data-genug-props call sites (click and load) —
  // a hand-authored JSON attribute is a plausible typo target, so this
  // warns instead of either crashing or failing silently.
  function parsePropsAttribute(
    raw: string | undefined,
  ): Record<string, unknown> {
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn(
        `genug: invalid JSON in data-genug-props, ignoring — "${raw}"`,
      );
      return {};
    }
  }

  // Captured before the stub is replaced below — anything the site
  // called while this script was still loading is waiting in here.
  const queued = window.genugAnalytics?.q;

  const api: GenugAnalyticsApi = {
    // A public call always names its event: the role form exists only
    // for the three this script fires itself.
    track(
      event: string,
      props?: Record<string, unknown>,
      idempotencyKey?: string,
    ): void {
      send({ event }, props, idempotencyKey);
    },
    setConsent(value: boolean): void {
      consent = value;
    },
    optOut(): void {
      writeOptOutCookie(OPT_OUT_MAX_AGE_SECONDS);
      // The last request this script will make, and the reason opting
      // out is not simply "stop sending": the visitor-id cookie is
      // httpOnly, so only a response from the collector can remove it.
      // This body carries no event, no url and no referrer — the server
      // stores nothing for it (see routes/events.ts).
      post(
        new Blob([JSON.stringify({ optOut: true })], {
          type: "application/json",
        }),
      );
    },
    optIn(): void {
      writeOptOutCookie(0);
    },
    isOptedOut(): boolean {
      return optedOut();
    },
  };
  window.genugAnalytics = api;

  // Replayed in the order the calls were originally made, and before any
  // automatic page-load event fires below. Order matters for more than
  // tidiness: a cookie banner that called setConsent(true) before this
  // script finished loading has to take effect *before* the page_view it
  // precedes, or that first event would be recorded as consentless when
  // the visitor had in fact already agreed.
  if (queued) {
    for (const [method, args] of queued) {
      if (method === "track") {
        api.track(
          args[0] as string,
          args[1] as Record<string, unknown> | undefined,
          args[2] as string | undefined,
        );
      } else if (method === "setConsent") {
        api.setConsent(args[0] === true);
      } else if (method === "optOut") {
        api.optOut();
      } else if (method === "optIn") {
        api.optIn();
      } else {
        // A typo in the hand-written stub, most likely. Warn rather than
        // throw, same as malformed data-genug-props below: one bad
        // entry shouldn't take the rest of the queue down with it.
        console.warn(
          `genug: ignoring queued call to unknown method "${method}"`,
        );
      }
    }
  }

  // Zero-JS tracking for simple cases: tag any element with
  // data-genug-on-click (and optionally data-genug-props, a
  // JSON string) and a click anywhere inside it fires that event.
  // closest() means clicking an icon/span *inside* a tagged button
  // still counts, not just the exact tagged element.
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const el = target?.closest<HTMLElement>("[data-genug-on-click]");
    if (!el) return;

    const eventName = el.dataset.genugOnClick;
    if (!eventName) return;

    send({ event: eventName }, parsePropsAttribute(el.dataset.genugProps));
  });

  // Opt-in automatic outbound-link and file-download tracking. This
  // exists despite data-genug-on-click already covering "track this
  // click" because links inside CMS or user-generated content can't be
  // hand-tagged — which is exactly where outbound links tend to live.
  if (window.genugAnalyticsConfig?.enableAutoLinkTracking === true) {
    const handleLinkActivation = (event: MouseEvent): void => {
      // auxclick covers middle-click ("open in new tab"), a common way
      // to follow an outbound link that never fires a plain click.
      // Button 1 only — button 2 is the context menu, which isn't a
      // navigation and shouldn't be counted as one.
      if (event.type === "auxclick" && event.button !== 1) return;

      const target = event.target as Element | null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      // An explicit data-genug-on-click on this link supersedes the
      // automatic one. Without this, both listeners match the same click
      // — the tagged one and this one — and a single click is recorded
      // twice, silently inflating the count.
      //
      // Same precedence data-genug-on-load already takes over
      // enableAutoPageTracking, for the same reason: one action, one
      // event, and an explicit tag is a statement of intent that beats a
      // blanket fallback.
      //
      // Scoped with contains() so it only applies when the tag is on the
      // link itself (or something inside it). A tagged *ancestor* — an
      // outbound link inside a <div data-genug-on-click="card_click">
      // — still fires both, because those describe two genuinely
      // different things rather than the same click twice.
      const tagged = target?.closest<HTMLElement>("[data-genug-on-click]");
      if (tagged?.dataset.genugOnClick && anchor.contains(tagged)) return;

      // Anything that isn't a web navigation — mailto:, tel:, a bare
      // #anchor, javascript: — is neither an outbound visit nor a
      // download, so it's left alone rather than guessed at.
      if (anchor.protocol !== "http:" && anchor.protocol !== "https:") return;

      const linkText = collapseLinkText(anchor.textContent);

      // Download wins when a link is both (an outbound PDF): what the
      // visitor did was download a file; whose server it sat on is
      // incidental. See file_download.json.
      if (isDownloadLink(anchor)) {
        send(
          { auto: "fileDownload" },
          {
            file_url: strippedUrl(anchor.href),
            file_extension: fileExtension(anchor.pathname),
            link_text: linkText,
          },
        );
        return;
      }

      if (anchor.host !== location.host) {
        send(
          { auto: "outboundClick" },
          {
            target_url: strippedUrl(anchor.href),
            target_host: anchor.host,
            link_text: linkText,
          },
        );
      }
    };

    document.addEventListener("click", handleLinkActivation);
    document.addEventListener("auxclick", handleLinkActivation);
  }

  // Read off <html>, not <body> — <html> exists the instant parsing
  // starts, so this works even if the script runs before <body> has
  // been parsed yet (e.g. placed in <head> without defer). Presence of
  // the attribute is itself the opt-in, same as data-genug-on-click
  // for clicks — no config flag needed, and it takes priority over
  // enableAutoPageTracking so a page doesn't fire both.
  const root = document.documentElement;
  const autoPageTracking =
    window.genugAnalyticsConfig?.enableAutoPageTracking === true;

  // Called once at load and, when enableAutoRouteTracking is on, again
  // on every route change. Deliberately one function rather than two
  // similar ones: the attribute-beats-flag precedence above then applies
  // to a route change by construction, instead of being a second set of
  // rules that could drift out of step with this one. The dataset is
  // re-read per call, so a framework that updates data-genug-on-load
  // between routes is honoured rather than replayed stale.
  function firePageEvent(): void {
    const customLoadEvent = root.dataset.genugOnLoad;
    if (customLoadEvent) {
      send(
        { event: customLoadEvent },
        parsePropsAttribute(root.dataset.genugProps),
      );
      return;
    }
    if (autoPageTracking) {
      send(
        { auto: "pageView" },
        {
          page_title: document.title,
          document_language: document.documentElement.lang,
        },
      );
    }
  }

  firePageEvent();

  // The hash is deliberately excluded: #faq -> #pricing is an in-page
  // jump, not a navigation, and counting it would fire a page event for
  // every anchor link and "back to top" button — the same line the
  // automatic link tracking already draws by ignoring bare #anchor
  // links. The cost is that hash-routed SPAs (#/about) aren't tracked
  // at all; a documented gap rather than an oversight.
  function currentRoute(): string {
    return location.pathname + location.search;
  }

  function installRouteTracking(): void {
    let lastRoute = currentRoute();
    let scheduled = false;

    // Deferred to the next tick rather than fired inline, for three
    // reasons. Frameworks set document.title *after* the route change,
    // so firing immediately captures the previous page's title. A route
    // guard redirecting /old to /new calls pushState twice in one tick,
    // and coalescing records one event at the URL the visitor actually
    // landed on instead of two, one of which they never saw. And it
    // gives the unchanged-route check somewhere to sit, so a router
    // re-pushing the current URL doesn't count as a second visit.
    const scheduleRouteEvent = (): void => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        const route = currentRoute();
        if (route === lastRoute) return;
        lastRoute = route;
        firePageEvent();
      }, 0);
    };

    // The History API fires no event of its own when a router navigates
    // — popstate covers only back/forward — so pushState is wrapped to
    // report it. replaceState is left alone deliberately: it means
    // "rewrite the current entry" (canonicalising a URL, stripping a
    // token, storing filter state), which isn't a visit.
    const originalPushState = history.pushState.bind(history);
    history.pushState = (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void => {
      originalPushState(data, unused, url);
      scheduleRouteEvent();
    };

    window.addEventListener("popstate", scheduleRouteEvent);
  }

  // Opt-in, and separate from enableAutoPageTracking on purpose. Plenty
  // of sites call pushState for things that aren't navigation — a
  // lightbox, a wizard step, filter state — and firing page events for
  // those would inflate the stored numbers permanently, with nothing on
  // the row to tell a phantom view from a real one. A deployment that
  // misses this flag under-collects, but every number it does report is
  // true; one that over-collects reports false numbers forever. This
  // also patches a global the site owns, which shouldn't happen unasked.
  if (window.genugAnalyticsConfig?.enableAutoRouteTracking === true) {
    // Additive, so with no page-load opt-in there is nothing for a route
    // change to repeat and this would silently do nothing at all.
    if (!root.dataset.genugOnLoad && !autoPageTracking) {
      console.warn(
        "genug: enableAutoRouteTracking is enabled, but no page-load tracking is configured for it to repeat — set enableAutoPageTracking, or add data-genug-on-load to <html>. Those events will not be sent.",
      );
    } else {
      installRouteTracking();
    }
  }
})();
