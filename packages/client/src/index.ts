interface GenugAnalyticsApi {
  // idempotencyKey: a value that uniquely identifies this occurrence,
  // such as an order id. Pass it for events that must not count twice
  // when the page is reloaded or revisited with the back button (a
  // purchase, not a page view). The script can't make one up: a random
  // id would be different after every reload.
  track(
    event: string,
    props?: Record<string, unknown>,
    idempotencyKey?: string,
  ): void;
  setConsent(consent: boolean): void;
  // Stops this script from sending anything from this browser until
  // optIn() is called. Not the same as setConsent(false), which only
  // changes how the visitor is identified and keeps counting without a
  // cookie. Opting out is how a visitor objects (GDPR Art. 21), which a
  // site relying on legitimate interest must offer.
  optOut(): void;
  optIn(): void;
  isOptedOut(): boolean;
  // Only exists on the stub, never on the real API. A site's own inline
  // code may call track() before this script has loaded, which would
  // throw. The stub from the README defines window.genugAnalytics early
  // with methods that just store their arguments here; this script
  // replays them when it starts and then replaces the stub. The arguments
  // are untyped because the stub is plain JavaScript on the site's page.
  q?: QueuedCall[];
}

type QueuedCall = [method: string, args: unknown[]];

// This file is compiled as a script, not a module (see tsconfig), so a
// top-level interface adds to the global Window type directly, without
// `declare global`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- global augmentation, not a local type
interface Window {
  genugAnalytics?: GenugAnalyticsApi;
  genugAnalyticsConfig?: {
    // Leave unset (not false) while your consent banner hasn't answered:
    // the server treats "unknown" differently from "no" (see "Embedding
    // the client script" in the README).
    consent?: boolean;
    // Default false: no automatic page_view on load. Call track()
    // yourself, or put data-genug-on-load on <html> (see below), which
    // works regardless of this flag. Set true to send the built-in
    // page_view event (title and language) automatically.
    enableAutoPageTracking?: boolean;
    // Default false: no automatic tracking of outbound links and file
    // downloads. Set true to send the built-in outbound_link_click and
    // file_download events (see below).
    enableAutoLinkTracking?: boolean;
    // Default false: in a single-page app, route changes send nothing, so
    // a visitor who browses ten routes counts as one page. Set true to
    // also send the page event on every route change. It repeats what
    // the page-load options above send, so on its own it sends nothing.
    enableAutoRouteTracking?: boolean;
  };
}

// Everything, helpers included, is inside this function. In a classic
// script, a top-level const or function becomes a global on the site: a
// name the site already uses would either throw (and stop tracking) or
// replace the site's own. Only window.genugAnalytics should be global.
(function (): void {
  // File extensions that count as a download when clicked. This is a
  // guess, since an extension is only a hint, so it covers the common
  // cases and isn't complete. A link with a `download` attribute always
  // counts, whatever its extension.
  const DOWNLOAD_EXTENSION =
    /\.(pdf|zip|rar|7z|tar|gz|tgz|doc|docx|xls|xlsx|ppt|pptx|csv|rtf|txt|dmg|exe|msi|pkg|deb|rpm|apk|iso|epub|mp3|wav|mp4|mov|avi|mkv)$/i;

  // Long enough to tell which link was clicked, short enough that a whole
  // paragraph inside an <a> doesn't become the prop value.
  const MAX_LINK_TEXT_LENGTH = 120;

  function isDownloadLink(anchor: HTMLAnchorElement): boolean {
    return (
      anchor.hasAttribute("download") ||
      DOWNLOAD_EXTENSION.test(anchor.pathname)
    );
  }

  function fileExtension(pathname: string): string {
    const match = /\.([a-z0-9]+)$/i.exec(pathname);
    return match ? match[1]!.toLowerCase() : "";
  }

  // Link text includes the HTML's indentation, so whitespace is reduced
  // to single spaces. Otherwise the same link would have different
  // values on different pages.
  function collapseLinkText(text: string | null): string {
    return (text ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LINK_TEXT_LENGTH);
  }

  // The query parameters and fragments to keep. Everything else is
  // removed before the URL leaves the browser: a newsletter link's
  // ?email=, a login link's one-time token, a search page's query, an
  // access_token in the fragment. The server removes them again (see
  // server/lib/url.ts) for requests that don't come from this script.
  //
  // This script can't import the server's lists, so the server writes
  // them in, replacing the placeholder below when it serves the file
  // (server/lib/clientScript.ts). "*" keeps everything; a list keeps only
  // those values. If the placeholder isn't replaced, it is neither, so
  // everything is removed, which is the safe way to fail.
  interface KeptUrlParts {
    params: "*" | string[];
    hashes: "*" | string[];
  }
  const KEPT_URL_PARTS = "__GENUG_KEPT_URL_PARTS__" as unknown as KeptUrlParts;

  function keeps(kept: KeptUrlParts["params"] | undefined, value: string) {
    return kept === "*" || (Array.isArray(kept) && kept.includes(value));
  }

  function strippedUrl(href: string): string {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      // Parameter names are lowercase in the list and compared ignoring
      // case. Fragments must match exactly.
      if (!keeps(KEPT_URL_PARTS.params, key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    if (!keeps(KEPT_URL_PARTS.hashes, url.hash.slice(1))) url.hash = "";
    return url.toString();
  }

  // A second copy of this script on the same page (a tag manager plus a
  // hard-coded tag, say) would add a second set of listeners and send
  // every event twice, with nothing in the data to show it. The stub has
  // `q`, the real API never does, so an API without a queue means an
  // earlier copy already ran, and this one stops.
  const installed = window.genugAnalytics;
  if (installed && !installed.q) return;

  const scriptEl = document.currentScript as HTMLScriptElement | null;
  // Uses a relative path when there is no <script src> to take the server
  // from. Both checks are needed: an inline <script> exists but has an
  // empty `src`, and `new URL("")` throws, which would stop the script
  // before window.genugAnalytics exists.
  const scriptSrc = scriptEl?.src;
  const endpoint = scriptSrc ? new URL(scriptSrc).origin : "";

  // Three states, not a boolean: `undefined` means "not answered yet",
  // which the server handles differently from `false` (see events.ts).
  // When undefined, JSON.stringify leaves it out of the body.
  let consent = window.genugAnalyticsConfig?.consent;

  // Either an event name (from track() or data-genug-on-click) or one of
  // the three roles this script sends by itself. A role is sent because
  // this script doesn't know what the deployment calls those events; the
  // server looks the name up, so a cached copy of this file can't send a
  // name that was renamed.
  type EventIdentity =
    | { event: string; auto?: never }
    | { auto: "pageView" | "outboundClick" | "fileDownload"; event?: never };

  // The opt-out cookie, read before every send and written by optOut()
  // and optIn(). It is set on the site's own domain and is not httpOnly,
  // because this script must read it; it holds a flag, not an
  // identifier.
  //
  // Setting it writes to the device, which consentless mode otherwise
  // never does. But "this person asked not to be tracked" can't be
  // respected without remembering it, and § 25(2) TDDDG allows storage
  // that is strictly necessary for something the user asked for.
  const OPT_OUT_COOKIE = "genug_optout";

  // Chrome limits cookies to 400 days anyway, so asking for more would
  // only look like a longer promise.
  const OPT_OUT_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

  function optedOut(): boolean {
    return document.cookie
      .split(";")
      .some((entry) => entry.trim().startsWith(`${OPT_OUT_COOKIE}=1`));
  }

  function writeOptOutCookie(maxAgeSeconds: number): void {
    // Secure only over https: the browser silently drops a Secure cookie
    // set over http, so opting out would quietly fail on a plain-http or
    // local site.
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
    // Every event passes through here (track(), automatic page views,
    // link clicks, route changes), so checking the opt-out once here
    // covers all of them.
    if (optedOut()) return;

    // JSON.stringify leaves out keys whose value is undefined, so an
    // unset idempotencyKey (or the unused half of `identity`) is simply
    // missing from the body.
    const body = JSON.stringify({
      ...identity,
      consent,
      url: strippedUrl(location.href),
      // "" for a direct visitor, which new URL() would throw on. For a
      // click within the site, the referrer is one of its own pages, so
      // its query string is cleaned the same way.
      referrer: document.referrer ? strippedUrl(document.referrer) : "",
      idempotencyKey,
      props,
    });
    const blob = new Blob([body], { type: "application/json" });
    post(blob);
  }

  // Sends with sendBeacon where it works, otherwise with fetch. optOut()
  // uses it too: opting out must also work in browsers without
  // sendBeacon, because only the server's answer can delete the httpOnly
  // visitor cookie.
  function post(blob: Blob): void {
    const url = `${endpoint}/events`;

    // sendBeacon can also return false when the browser won't queue the
    // data (its queue is full, or the body is too large). Then use fetch
    // too, instead of losing the event.
    if (!navigator.sendBeacon || !navigator.sendBeacon(url, blob)) {
      // sendBeacon sends cookies by default; fetch needs this to send the
      // visitor cookie to the collector's subdomain.
      fetch(url, {
        method: "POST",
        body: blob,
        keepalive: true,
        credentials: "include",
      }).catch(() => {});
    }
  }

  // Reads data-genug-props (for clicks and page loads). It is JSON typed
  // by hand, so typos are likely; this warns instead of crashing or
  // failing silently.
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

  // Saved before the stub is replaced below: it holds every call the site
  // made while this script was loading.
  const queued = window.genugAnalytics?.q;

  const api: GenugAnalyticsApi = {
    // A track() call always names its event; roles are only for the
    // three events this script sends by itself.
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
      // The last request this script sends. Opting out can't just mean
      // "stop sending": the visitor cookie is httpOnly, so only a
      // response from the collector can delete it. The body has no event,
      // url or referrer, and the server stores nothing (see
      // routes/events.ts).
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

  // Replay the saved calls in their original order, before the automatic
  // page-load event below. The order matters: if the cookie banner called
  // setConsent(true) while this script was loading, that must apply
  // before the page_view, or the first event would be stored without
  // consent although the visitor had agreed.
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
        // Probably a typo in the hand-written stub. Warn instead of
        // throwing, so one bad entry doesn't stop the rest of the queue.
        console.warn(
          `genug: ignoring queued call to unknown method "${method}"`,
        );
      }
    }
  }

  // Tracking without writing JavaScript: give any element
  // data-genug-on-click (and optionally data-genug-props, a JSON string),
  // and a click anywhere inside it sends that event. closest() makes a
  // click on an icon inside a tagged button count too.
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const el = target?.closest<HTMLElement>("[data-genug-on-click]");
    if (!el) return;

    const eventName = el.dataset.genugOnClick;
    if (!eventName) return;

    send({ event: eventName }, parsePropsAttribute(el.dataset.genugProps));
  });

  // Optional automatic tracking of outbound links and file downloads.
  // Needed in addition to data-genug-on-click, because links in CMS or
  // user content can't be tagged by hand, and that is where most outbound
  // links are.
  if (window.genugAnalyticsConfig?.enableAutoLinkTracking === true) {
    const handleLinkActivation = (event: MouseEvent): void => {
      // auxclick covers the middle mouse button ("open in new tab"), a
      // common way to open an outbound link that fires no normal click.
      // Only button 1: button 2 opens the context menu, which isn't a
      // navigation.
      if (event.type === "auxclick" && event.button !== 1) return;

      const target = event.target as Element | null;
      const anchor = target?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      // A data-genug-on-click on this link replaces the automatic event.
      // Otherwise both listeners would handle the same click and it would
      // be counted twice. (data-genug-on-load likewise wins over
      // enableAutoPageTracking: one action, one event.)
      //
      // contains() limits this to a tag on the link itself or inside it.
      // An outbound link inside a <div data-genug-on-click="card_click">
      // still sends both, because they describe two different things.
      const tagged = target?.closest<HTMLElement>("[data-genug-on-click]");
      if (tagged?.dataset.genugOnClick && anchor.contains(tagged)) return;

      // Links that don't open a web page (mailto:, tel:, #anchor,
      // javascript:) are neither outbound visits nor downloads, so they
      // are ignored.
      if (anchor.protocol !== "http:" && anchor.protocol !== "https:") return;

      const linkText = collapseLinkText(anchor.textContent);

      // A link that is both (a PDF on another site) counts as a download:
      // the visitor downloaded a file, wherever it was. See
      // file_download.json.
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

  // Read from <html>, not <body>: <html> exists from the start, so this
  // works even when the script runs before <body> exists (in <head>
  // without defer). The attribute alone turns it on, like
  // data-genug-on-click, and it wins over enableAutoPageTracking so a
  // page doesn't send both.
  const root = document.documentElement;
  const autoPageTracking =
    window.genugAnalyticsConfig?.enableAutoPageTracking === true;

  // Called once at load and, with enableAutoRouteTracking, again on
  // every route change. One function for both, so the rule that the
  // attribute wins over the flag also applies to route changes. The
  // attribute is read again on each call, so a framework that changes
  // data-genug-on-load between routes is respected.
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

  // The fragment is ignored on purpose: #faq -> #pricing is a jump within
  // the page, and counting it would send a page event for every anchor
  // link and "back to top" button. The downside, which is documented:
  // apps that route with the fragment (#/about) aren't tracked.
  function currentRoute(): string {
    return location.pathname + location.search;
  }

  function installRouteTracking(): void {
    let lastRoute = currentRoute();
    let scheduled = false;

    // Wait until the next tick instead of sending right away, for three
    // reasons. Frameworks set document.title after the route change, so
    // sending now would use the previous page's title. A redirect from
    // /old to /new calls pushState twice at once, and waiting records only
    // the page the visitor ended up on. And a router pushing the same URL
    // again isn't counted as a second visit.
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

    // The browser fires no event when a router navigates (popstate is
    // only for back/forward), so pushState is wrapped to notice it.
    // replaceState isn't wrapped on purpose: it changes the current entry
    // (tidying a URL, removing a token, saving filters), which isn't a
    // new page.
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

  // Optional, and separate from enableAutoPageTracking on purpose. Many
  // sites call pushState for things that aren't new pages (a lightbox, a
  // form step, filters), and counting those would inflate the numbers
  // for good, with no way to tell them apart later. Missing some page
  // views is better than counting false ones. It also changes a browser
  // function the site owns, which shouldn't happen without being asked.
  if (window.genugAnalyticsConfig?.enableAutoRouteTracking === true) {
    // It only repeats the page-load event, so without a page-load option
    // there is nothing to repeat.
    if (!root.dataset.genugOnLoad && !autoPageTracking) {
      console.warn(
        "genug: enableAutoRouteTracking is enabled, but no page-load tracking is configured for it to repeat — set enableAutoPageTracking, or add data-genug-on-load to <html>. Those events will not be sent.",
      );
    } else {
      installRouteTracking();
    }
  }
})();
