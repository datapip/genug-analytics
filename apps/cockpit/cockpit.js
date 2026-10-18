(function () {
  // A note for the sign-in page about why it is being shown. One
  // sessionStorage key, read and cleared by whichever page loads next
  // (see login.js).
  const NOTICE = "genug-cockpit-notice";
  function leaveNotice(value) {
    try {
      if (value === null) sessionStorage.removeItem(NOTICE);
      else sessionStorage.setItem(NOTICE, value);
    } catch {
      // Private mode or blocked storage. Only a message is lost.
    }
  }

  // If this script runs, the browser kept the session cookie, so the
  // sign-in page's "cookie refused" note is removed here. Otherwise it
  // would stay for the whole tab, and every normal sign-out would show a
  // red warning about an https problem that doesn't exist.
  leaveNotice(null);

  const compactNumber = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const fullNumber = new Intl.NumberFormat("en");
  // Every date and time on the page uses this, not the browser's
  // language: the page is in English, so a German browser would otherwise
  // show "vor 1 Minute" next to "just now". en-GB for the 24-hour clock
  // and day-first dates.
  const DATE_LOCALE = "en-GB";

  // Every request this page makes goes through here, so an expired
  // session is handled in one place: a 401 sends the owner to the sign-in
  // page instead of showing "HTTP 401".
  //
  // The page is already leaving when the thrown error is caught, so the
  // error banner it causes is never seen.
  async function cockpitFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      leaveNotice("expired");
      window.location.replace("login.html");
      throw new Error("Your session has expired.");
    }
    return res;
  }

  // A reverse proxy answers a timeout, a body that is too large or a
  // stopped server with its own HTML page. Parsing that as JSON would
  // throw "Unexpected token '<'", so say what happened instead, with the
  // status code.
  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      // Retrying a body that is too large always fails again, so this
      // case says what to change.
      if (res.status === 413) {
        throw new Error(
          "The text is larger than the proxy in front of the server " +
            "accepts. Shorten it, or raise the proxy's body size limit.",
        );
      }
      throw new Error(
        "The server sent back a page instead of data (HTTP " +
          res.status +
          "). Something in front of it, such as a proxy, may have " +
          "refused or timed out. Try again in a moment.",
      );
    }
  }

  // The steps shared by the schema registry card's writes (save, add a
  // prop, delete, create): disable the button, show a "working" message
  // and send the request. Only on success (errors go to `message`), pass
  // the result to `onSuccess`, reload the page's data, and show what
  // `onSuccess` returned in the card's note.
  //
  // `onSuccess` runs before the reload: it closes the open form (sets
  // `editing` or a similar variable to null). Reloading first would
  // render the card while that variable still points at the old form,
  // leaving stray form elements in the page.
  //
  // Reload and the two danger-zone resets don't use this, because they
  // write their message at a different point relative to load().
  async function submitEventWrite(
    button,
    message,
    pending,
    url,
    init,
    onSuccess,
  ) {
    button.disabled = true;
    message.classList.remove("is-critical");
    message.textContent = pending;
    try {
      const res = await cockpitFetch(url, init);
      const result = await readJson(res);
      if (!result.ok) {
        failWith(message, result.error || "HTTP " + res.status);
        return;
      }
      const noteText = onSuccess(result);
      await load();
      const note = document.getElementById("reload-note");
      note.classList.remove("is-critical");
      note.textContent = noteText;
    } catch (err) {
      failWith(message, err.message);
    } finally {
      button.disabled = false;
    }
  }

  // Like submitEventWrite above, for the deployment context card. The
  // success text goes to this form's own `message`, not to the schema
  // card's #reload-note, and there is no form to close, so no onSuccess.
  async function submitContextWrite(button, message, pending, url, init) {
    button.disabled = true;
    message.hidden = false;
    message.classList.remove("is-critical");
    message.textContent = pending;
    try {
      const res = await cockpitFetch(url, init);
      const result = await readJson(res);
      if (!result.ok) {
        failWith(message, result.error || "HTTP " + res.status);
        return null;
      }
      await load();
      message.classList.remove("is-critical");
      return result;
    } catch (err) {
      failWith(message, err.message);
      return null;
    } finally {
      button.disabled = false;
    }
  }

  // Disabling the button that was clicked moves focus to <body> in Chrome
  // and Firefox, so keyboard and screen-reader users would miss the
  // error. `message` has aria-live="polite", so the error is announced;
  // tabIndex lets it receive focus, so it can be read again.
  function failWith(message, text) {
    message.classList.add("is-critical");
    message.textContent = text;
    message.tabIndex = -1;
    message.focus();
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) Object.assign(node, props);
    for (const child of children || []) {
      node.append(
        child instanceof Node ? child : document.createTextNode(child),
      );
    }
    return node;
  }

  // Connects a label to its input. Without that, clicking the label does
  // nothing and screen readers announce the input without a name. The id
  // is generated because these forms can appear more than once.
  let fieldSeq = 0;
  function field(labelText, control) {
    if (!control.id) control.id = "field-" + ++fieldSeq;
    return el("div", { className: "edit-field" }, [
      el("label", { htmlFor: control.id }, [labelText]),
      control,
    ]);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  // SVG elements need createElementNS. document.createElement("svg")
  // would create an unknown HTML element that isn't drawn.
  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      node.setAttribute(key, value);
    }
    for (const child of children || []) {
      node.append(child);
    }
    return node;
  }

  // The open/close triangle for a summary row, used by the registry and
  // the tool list.
  function summaryChevron() {
    return svgEl(
      "svg",
      {
        class: "summary-chevron",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      [svgEl("polyline", { points: "9 18 15 12 9 6" }, [])],
    );
  }

  function dot(color) {
    return el("span", {
      className: "dot",
      style: `background:${color}`,
    });
  }

  function clear(node) {
    node.replaceChildren();
  }

  // All events in a period or bucket: interactions plus page views, as
  // in get_traffic_summary.
  function totalEvents(row) {
    return row.interactionEvents + row.viewEvents;
  }

  // Shown as it is: the release tag already has its "v" (v0.2.0), and a
  // git clone reports "dev", which would become "vdev" with a prefix.
  function renderVersion(version, latestVersion) {
    document.getElementById("version").textContent = version || "";
    // The version in the header is small on purpose. It is repeated in
    // the danger zone, more visibly, so an owner with several Genug tabs
    // open doesn't reset the wrong one.
    document.getElementById("danger-zone-instance").textContent = version
      ? `You are about to act on ${location.host}, running ${version}.`
      : "";
    // null means "no newer version" or "not checked yet" (see
    // lib/updateCheck.ts); the hint stays hidden in both cases.
    document.getElementById("version-pill").hidden = !latestVersion;
  }

  // Dates are shown in the site's time zone (TIMEZONE on the server), not
  // the browser's: 7d and 30d are whole days in that zone (see
  // windowPeriod), so a viewer elsewhere would otherwise see dates that
  // don't match the chart below.
  //
  // What each period covers is written next to the dates, not only in
  // tooltips: tooltips need a mouse, and nobody would guess that "7d"
  // leaves out today.
  function renderPeriod(period, timezone, range) {
    const opts = { timeZone: timezone };
    const date = (iso) => new Date(iso).toLocaleDateString(DATE_LOCALE, opts);
    const dateTime = (iso) =>
      new Date(iso).toLocaleString(DATE_LOCALE, {
        ...opts,
        dateStyle: "short",
        timeStyle: "short",
      });
    const span = date(period.from) + " – " + date(period.to);
    const text = {
      today: "Since midnight, " + date(period.from),
      "24h": "Rolling 24 hours, since " + dateTime(period.from),
      "7d": "7 full days before today: " + span,
      "30d": "30 full days before today: " + span,
    }[range];
    document.getElementById("period").textContent = text || span;
    // Its own span, so it can be hidden on a phone: the sticky header has
    // no room there, and the chart caption names the time zone too.
    document.getElementById("period-zone").textContent =
      " (" + zoneLabel(timezone) + ")";
  }

  // The time zone name as the owner set it, with spaces instead of
  // underscores ("Buenos_Aires" looks like a setting). Intl's long names
  // ("Central European Summer Time") change with the season and the
  // viewer's language, so they aren't used.
  function zoneLabel(timezone) {
    return timezone.replace(/_/g, " ");
  }

  // Read-only mode hides every editing control instead of disabling it:
  // a disabled button makes people ask why, and on the public demo a
  // disabled Reset database button with a password field invites trying.
  // The server refuses writes anyway; this only stops the page offering
  // them.
  //
  // Elements are only shown or hidden here, never given text. The
  // explanations are written in index.html, so they can't be left behind
  // when the mode is turned off, and aren't announced by the live region
  // #reload-note.
  function renderReadOnly(readOnly) {
    document.getElementById("read-only-note").hidden = !readOnly;
    document.getElementById("schema-read-only-note").hidden = !readOnly;
    document.getElementById("tools-read-only-note").hidden = !readOnly;
    document.getElementById("reload-schemas").hidden = readOnly;
    document.getElementById("danger-zone").hidden = readOnly;
    // It is about the button above it, which is hidden.
    document.getElementById("reload-note").hidden = readOnly;
    document.getElementById("context-read-only-note").hidden = !readOnly;
    // The two text boxes also show text people want to read, so only
    // their Save buttons are hidden; the boxes stay, made read-only.
    document.getElementById("ground-rules-text").readOnly = readOnly;
    document.getElementById("save-ground-rules").hidden = readOnly;
    document.getElementById("business-context-text").readOnly = readOnly;
    document.getElementById("save-business-context").hidden = readOnly;
    document.getElementById("history-form").hidden = readOnly;
    document.getElementById("recent-read-only-note").hidden = !readOnly;
    document.getElementById("recent-table").hidden = readOnly;
    document.getElementById("recent-period-note").hidden = readOnly;
  }

  function renderRetentionNote(retentionDays) {
    document.getElementById("retention-note").textContent =
      retentionDays == null
        ? "Retention: no limit configured — events are kept forever."
        : "Retention: events older than " +
          retentionDays +
          " days are automatically deleted.";
  }

  // One line, not a stat card: on a site without a consent banner, a card
  // would always read "100% without consent". Counted in events, not
  // sessions: a visitor who accepts during a visit keeps the same session
  // (see "Visitor identification" in docs/decisions.md), so a session
  // can have both modes. The counts are shown with the percentage,
  // because 100% of two events and of two thousand mean different things.
  function renderConsentNote(breakdown) {
    const node = document.getElementById("consent-note");
    const consentful = breakdown.consentful.events;
    const total = consentful + breakdown.consentless.events;
    // No events at all: 0% would look like a consent problem instead of
    // an empty period.
    node.hidden = total === 0;
    if (total === 0) return;
    node.textContent =
      "Consent: " +
      Math.round((consentful / total) * 100) +
      "% of events collected with consent (" +
      fullNumber.format(consentful) +
      " of " +
      fullNumber.format(total) +
      ").";
  }

  function setStat(id, value, attention) {
    const node = document.getElementById(id);
    node.textContent = compactNumber.format(value);
    node.title = fullNumber.format(value);
    node.classList.toggle("attention", Boolean(attention) && value > 0);
  }

  function renderSummary(summary, rejectedEventCount, botActivityCount) {
    setStat("stat-sessions", summary.sessions, false);
    setStat("stat-events", totalEvents(summary), false);
    setStat("stat-rejected", rejectedEventCount, true);
    setStat("stat-bots", botActivityCount, false);
    // Link the red number to the card that explains it, which is further
    // down the page.
    document.getElementById("stat-rejected-hint").textContent =
      rejectedEventCount > 0
        ? "Failed validation — listed below"
        : "Failed validation";
    document.getElementById("stat-events-hint").textContent =
      fullNumber.format(summary.viewEvents) +
      " views · " +
      fullNumber.format(summary.interactionEvents) +
      " interactions";
  }

  /* ---------- trend chart ---------- */

  const TREND_HEIGHT = 210;
  // The right margin fits half of the last x-axis label, which is
  // centred on the last point and would otherwise be cut off.
  const TREND_PADDING = { top: 12, right: 24, bottom: 26, left: 46 };
  const GRID_LINES = 4;

  function formatDayLabel(dateStr) {
    // dateStr is a date the server already worked out in the site's time
    // zone. It is parsed and printed in UTC only so the viewer's time zone
    // can't move it by a day.
    return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(DATE_LOCALE, {
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  // One renderer for the three trend views. "day" is a time series, drawn
  // as lines; "weekday" and "hour" are categories with no meaning between
  // them, drawn as pairs of bars. The data has the same shape in all
  // three.
  const TREND_MODES = {
    day: {
      getLabel: (row) => formatDayLabel(row.date),
      getFullLabel: (row) =>
        new Date(`${row.date}T00:00:00Z`).toLocaleDateString(DATE_LOCALE, {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
      chart: "line",
      caption: "Traffic by day",
    },
    weekday: {
      getLabel: (row) => row.day.slice(0, 3),
      getFullLabel: (row) => row.day,
      chart: "bar",
      caption: "Traffic by day of week",
    },
    hour: {
      getLabel: (row) => String(row.hour),
      getFullLabel: (row) => String(row.hour).padStart(2, "0") + ":00",
      chart: "bar",
      caption: "Traffic by hour of day",
    },
  };

  // Picks an axis maximum with round gridline labels (0/20/40/60/80)
  // instead of the data maximum split into quarters (0/13/26/39/52).
  //
  // The step between gridlines is rounded to 1, 2 or 5 × 10ⁿ, not the
  // maximum: a round maximum divided by GRID_LINES can still give odd
  // steps. The step is at least 1, so small charts don't show halves.
  function niceMax(value) {
    const rawStep = value / GRID_LINES;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const normalized = rawStep / magnitude;
    const niceStep =
      (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
      magnitude;
    return Math.max(1, niceStep) * GRID_LINES;
  }

  const tooltip = document.getElementById("trend-tooltip");
  // The width the chart was last drawn at, so the ResizeObserver below
  // only redraws when the width changes, not when drawing changes the
  // height.
  let lastTrendWidth = null;
  // Which bucket has the chart's single tab stop. Kept when the chart is
  // redrawn (on resize), reset when the data changes, since the same
  // position then means a different day or hour. null means the newest
  // bucket, which is most often wanted.
  let trendFocus = { index: null, key: null };

  function showTooltip(x, label, sessions, events) {
    clear(tooltip);
    tooltip.append(
      el("div", { className: "tooltip-label" }, [label]),
      el("div", { className: "tooltip-row" }, [
        dot("var(--series-sessions)"),
        "Sessions",
        el("b", null, [fullNumber.format(sessions)]),
      ]),
      el("div", { className: "tooltip-row" }, [
        dot("var(--series-events)"),
        "Events",
        el("b", null, [fullNumber.format(events)]),
      ]),
    );
    tooltip.style.left = x + "px";
    tooltip.classList.add("visible");
  }

  function hideTooltip() {
    tooltip.classList.remove("visible");
  }

  // A tap opens a bucket's tooltip (see the click handler below). On a
  // touchscreen mouseleave never fires, so tapping outside the chart is
  // the way to close it.
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".chart-wrap")) hideTooltip();
  });

  // An empty chart says which period is empty. A plain "No data yet."
  // sounds like nothing ever arrived, and a healthy site shows an empty
  // Today shortly after midnight. Uses the period of the data shown, not
  // the picker, which changes before the data arrives.
  const EMPTY_PERIOD_TEXT = {
    today: "No traffic yet today.",
    "24h": "No traffic in the last 24 hours.",
    "7d": "No traffic in the 7 days before today.",
    "30d": "No traffic in the 30 days before today.",
  };
  let shownRange = "today";

  function emptyPeriodNote() {
    return el("p", { className: "empty" }, [
      EMPTY_PERIOD_TEXT[shownRange] || "No traffic in this period.",
    ]);
  }

  function renderTrend(rows, mode) {
    const container = document.getElementById("trend-chart");
    // Remember focus before redrawing removes the focused bucket, so it
    // can be put back on the new one instead of falling to <body>.
    const hadFocus = container.contains(document.activeElement);
    hideTooltip();
    clear(container);

    if (rows.length === 0) {
      container.append(emptyPeriodNote());
      return;
    }

    // Drawn at the container's real width in pixels. A fixed viewBox
    // stretched with preserveAspectRatio="none" would also stretch the
    // text and lines on a wide screen.
    lastTrendWidth = container.clientWidth;
    const width = Math.max(320, Math.round(lastTrendWidth));
    const { getLabel, getFullLabel, chart } = TREND_MODES[mode];
    document.getElementById("trend-caption").textContent = trendCaption(mode);
    const innerWidth = width - TREND_PADDING.left - TREND_PADDING.right;
    const innerHeight = TREND_HEIGHT - TREND_PADDING.top - TREND_PADDING.bottom;
    const maxValue = niceMax(
      Math.max(1, ...rows.map((r) => Math.max(r.sessions, totalEvents(r)))),
    );
    const baselineY = TREND_PADDING.top + innerHeight;
    const valueY = (value) =>
      TREND_PADDING.top + innerHeight - (value / maxValue) * innerHeight;

    const slotWidth = innerWidth / rows.length;
    const slotX = (i) => TREND_PADDING.left + i * slotWidth;
    const pointX = (i) =>
      rows.length === 1
        ? TREND_PADDING.left + innerWidth / 2
        : TREND_PADDING.left + (i / (rows.length - 1)) * innerWidth;
    const centerX = (i) =>
      chart === "line" ? pointX(i) : slotX(i) + slotWidth / 2;

    // The visual parts (gridlines, lines or bars, axis labels) are in one
    // aria-hidden group, so a screen reader skips them and reads the hit
    // areas below, which carry the same numbers.
    const children = [];

    // Horizontal gridlines and y-axis labels, so values can be read off.
    for (let g = 0; g <= GRID_LINES; g++) {
      const value = (maxValue / GRID_LINES) * g;
      const y = valueY(value);
      children.push(
        svgEl("line", {
          class: "trend-grid",
          x1: TREND_PADDING.left,
          x2: width - TREND_PADDING.right,
          y1: y,
          y2: y,
        }),
        svgEl(
          "text",
          {
            class: "trend-label-y",
            x: TREND_PADDING.left - 8,
            y: y + 4,
            "text-anchor": "end",
          },
          [compactNumber.format(value)],
        ),
      );
    }

    if (chart === "line") {
      const linePoints = (get) =>
        rows.map((r, i) => `${pointX(i)},${valueY(get(r))}`).join(" ");
      const areaPoints = (get) =>
        `${pointX(0)},${baselineY} ${linePoints(get)} ${pointX(rows.length - 1)},${baselineY}`;
      for (const [get, color] of [
        [(r) => r.sessions, "var(--series-sessions)"],
        [totalEvents, "var(--series-events)"],
      ]) {
        children.push(
          svgEl("polygon", {
            class: "trend-area",
            style: `fill:${color}`,
            points: areaPoints(get),
          }),
          svgEl("polyline", {
            class: "trend-line",
            style: `stroke:${color}`,
            points: linePoints(get),
          }),
        );
        // Dots on the points. A single point has no line, so it always
        // gets a larger dot; otherwise Today would look empty. With more
        // points, dots are only drawn when there is room: 30 days on a
        // phone would hide the line under dots.
        if (rows.length === 1 || innerWidth / rows.length >= 16) {
          rows.forEach((r, i) => {
            children.push(
              svgEl("circle", {
                class: "trend-point",
                style: `fill:${color}`,
                cx: pointX(i),
                cy: valueY(get(r)),
                r: rows.length === 1 ? 5 : 3,
              }),
            );
          });
        }
      }
    } else {
      const barGap = 3;
      const barWidth = Math.max(1, (slotWidth - barGap * 3) / 2);
      const series = [
        [(r) => r.sessions, "var(--series-sessions)"],
        [totalEvents, "var(--series-events)"],
      ];
      for (let i = 0; i < rows.length; i++) {
        series.forEach(([get, color], seriesIndex) => {
          const value = get(rows[i]);
          children.push(
            svgEl("rect", {
              class: "trend-bar",
              style: `fill: ${color}`,
              x: slotX(i) + barGap + seriesIndex * (barWidth + barGap),
              y: valueY(value),
              width: barWidth,
              height: baselineY - valueY(value),
            }),
          );
        });
      }
    }

    // Only as many x-axis labels as fit, so 30 days or 24 hours don't
    // overlap.
    const labelStep = Math.max(
      1,
      Math.ceil(rows.length / Math.max(1, Math.floor(innerWidth / 52))),
    );
    // The last row always gets a label, so a regular label less than one
    // step before it is dropped. Otherwise, with 30 days and a step of 2,
    // "26/09" and "27/09" would overlap.
    const lastIndex = rows.length - 1;
    rows.forEach((row, i) => {
      const regular = i % labelStep === 0 && lastIndex - i >= labelStep;
      if (!regular && i !== lastIndex) return;
      children.push(
        svgEl(
          "text",
          {
            class: "trend-label",
            x: centerX(i),
            y: TREND_HEIGHT - 8,
            "text-anchor": "middle",
          },
          [getLabel(row)],
        ),
      );
    });

    // One invisible full-height area per bucket, so hovering anywhere in
    // a column shows its values, not only on the thin line or the bar.
    // These areas can be focused and have labels, so keyboard users can
    // read the values too.
    //
    // The whole chart is one tab stop, moved with the arrow keys (a
    // "roving tabindex"). One stop per bucket would put 24 or 30 stops
    // between the period picker and the rest of the page.
    const focusKey = mode + ":" + rows.length;
    if (trendFocus.key !== focusKey)
      trendFocus = { index: null, key: focusKey };
    const activeIndex =
      trendFocus.index === null ? rows.length - 1 : trendFocus.index;
    const interactive = [];
    const hits = [];
    rows.forEach((row, i) => {
      const label = `${getFullLabel(row)}: ${fullNumber.format(row.sessions)} sessions, ${fullNumber.format(totalEvents(row))} events`;
      const hit = svgEl("rect", {
        class: "trend-hit",
        x: slotX(i),
        y: TREND_PADDING.top,
        width: slotWidth,
        height: innerHeight,
        tabindex: i === activeIndex ? "0" : "-1",
        role: "img",
        "aria-label": label,
      });
      // Must come right after the hit area, as a direct child of the
      // svg, so the CSS rule .trend-hit:hover + .trend-hit-bg matches.
      const highlight = svgEl("rect", {
        class: "trend-hit-bg",
        x: slotX(i),
        y: TREND_PADDING.top,
        width: slotWidth,
        height: innerHeight,
        rx: 4,
        "aria-hidden": "true",
      });
      const show = () =>
        showTooltip(
          centerX(i),
          getFullLabel(row),
          row.sessions,
          totalEvents(row),
        );
      hit.addEventListener("mouseenter", show);
      // Touchscreens have no hover, so a tap does the same.
      hit.addEventListener("click", show);
      hit.addEventListener("focus", () => {
        moveTabStop(i);
        show();
      });
      hit.addEventListener("blur", hideTooltip);
      interactive.push(hit, highlight);
      hits.push(hit);
    });

    function moveTabStop(i) {
      hits[
        trendFocus.index === null ? hits.length - 1 : trendFocus.index
      ]?.setAttribute("tabindex", "-1");
      hits[i].setAttribute("tabindex", "0");
      trendFocus.index = i;
    }

    const svg = svgEl(
      "svg",
      {
        viewBox: `0 0 ${width} ${TREND_HEIGHT}`,
        width,
        height: TREND_HEIGHT,
        class: "trend-svg",
        role: "group",
        // Only the caption, without "use the arrow keys": screen readers
        // move through the buckets with their own keys; the arrow keys
        // are for sighted keyboard users.
        "aria-label": TREND_MODES[mode].caption,
      },
      [svgEl("g", { "aria-hidden": "true" }, children), ...interactive],
    );
    svg.addEventListener("mouseleave", hideTooltip);
    svg.addEventListener("keydown", (event) => {
      const current = hits.indexOf(document.activeElement);
      if (current === -1) return;
      const next = {
        ArrowLeft: current - 1,
        ArrowRight: current + 1,
        Home: 0,
        End: hits.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      hits[Math.max(0, Math.min(hits.length - 1, next))].focus();
    });
    container.append(svg);
    if (hadFocus) hits[activeIndex].focus();

    // The same numbers as a table, hidden visually, so a screen reader can
    // read them all at once. Built from the same `rows`.
    container.append(trendTable(rows, mode));
  }

  // The buckets are in the site's time zone, which may differ from the
  // viewer's, so the note and the table caption name it.
  function trendCaption(mode) {
    return (
      TREND_MODES[mode].caption + " (" + zoneLabel(latestData.timezone) + ")"
    );
  }

  function trendTable(rows, mode) {
    const { getFullLabel } = TREND_MODES[mode];
    const head = el("tr", null, [
      el("th", { scope: "col" }, ["Period"]),
      el("th", { scope: "col" }, ["Sessions"]),
      el("th", { scope: "col" }, ["Events"]),
    ]);
    const body = rows.map((row) =>
      el("tr", null, [
        el("th", { scope: "row" }, [getFullLabel(row)]),
        el("td", null, [String(row.sessions)]),
        el("td", null, [String(totalEvents(row))]),
      ]),
    );
    // Hidden with a wrapper, not on the table itself: tables ignore
    // `overflow`, so the hidden table would still widen the page on a
    // narrow phone and make it scroll sideways.
    return el("div", { className: "visually-hidden" }, [
      el("table", null, [
        el("caption", null, [trendCaption(mode)]),
        el("thead", null, [head]),
        el("tbody", null, body),
      ]),
    ]);
  }

  /* ---------- ranked bar lists ---------- */

  // Used by top pages, top referrers and devices: a label, an optional
  // second line, and a count shown as a number and as a bar.
  function renderBarList(containerId, rows, getLabel, getValue, options) {
    const { getSubLabel } = options || {};
    const container = document.getElementById(containerId);
    clear(container);
    if (rows.length === 0) {
      container.append(emptyPeriodNote());
      return;
    }
    const max = Math.max(...rows.map(getValue));
    for (const row of rows) {
      const value = getValue(row);
      const sub = getSubLabel && getSubLabel(row);
      container.append(
        el("div", { className: "bar-row" }, [
          el("div", {
            className: "bar-fill",
            style: `width:${max === 0 ? 0 : (value / max) * 100}%`,
          }),
          el(
            "div",
            {
              className: "bar-label",
              title: sub ? `${getLabel(row)} on ${sub}` : getLabel(row),
            },
            // Two lines, each shortened separately: on one line, a long
            // site name could push the path off a phone's screen. The
            // hidden " on " lets screen readers read it as one phrase
            // ("/cart on shop.example.com").
            sub
              ? [
                  el("span", { className: "bar-main" }, [getLabel(row)]),
                  el("span", { className: "bar-sub" }, [
                    el("span", { className: "visually-hidden" }, [" on "]),
                    sub,
                  ]),
                ]
              : [getLabel(row)],
          ),
          el("div", { className: "bar-value" }, [compactNumber.format(value)]),
        ]),
      );
    }
  }

  // A row is a path on one site (lib/content.ts). With several sites,
  // every row shows its site, even when the top rows are all from one
  // site, so nobody reads them as both sites together. With one site it
  // would only repeat the same name.
  function renderTopPages(topPages, siteHosts) {
    const severalSites = siteHosts.length > 1;
    renderBarList(
      "top-pages",
      topPages,
      (page) => page.path,
      (page) => page.views,
      { getSubLabel: severalSites ? (page) => page.host : undefined },
    );
  }

  function renderTopReferrers(topReferrers) {
    renderBarList(
      "top-referrers",
      topReferrers,
      (referrer) => referrer.host ?? "Direct",
      (referrer) => referrer.sessions,
    );
  }

  // Readable names for the device types. "other" is a real category (a
  // smart TV, a game console; see lib/userAgent.ts), so its label says
  // so instead of looking like a bug.
  const DEVICE_TYPE_LABELS = {
    desktop: "Desktop",
    mobile: "Mobile",
    tablet: "Tablet",
    other: "Other / unrecognised",
  };

  function renderDeviceBreakdown(devices) {
    renderBarList(
      "device-breakdown",
      devices,
      (row) => DEVICE_TYPE_LABELS[row.deviceType] || row.deviceType,
      (row) => row.sessions,
    );
  }

  /* ---------- reference sections ---------- */

  function renderMcpTools(toolManifest) {
    document.getElementById("tool-count-note").textContent =
      toolManifest.length + " registered";
    const container = document.getElementById("mcp-tools");
    clear(container);
    // One closed section per tool, showing only the name. Descriptions
    // are written for the agent and are often a paragraph long, so they
    // are shown only when opened, to keep the list of names easy to
    // scan.
    for (const tool of toolManifest) {
      container.append(
        el("details", { className: "tool-item" }, [
          el("summary", { className: "tool-title" }, [
            summaryChevron(),
            el("code", { className: "prop-code" }, [tool.name]),
          ]),
          el("p", { className: "tool-desc" }, [tool.description]),
        ]),
      );
    }
  }

  let schemaRegistryCache = {};

  // Readable text for the reasons routes/events.ts rejects a request
  // with, since "invalid_props" says less than a sentence. An unknown
  // reason is shown as it is, not as an empty cell.
  const REJECTION_REASONS = {
    invalid_envelope: "Malformed request",
    unknown_event_type: "Event not registered",
    invalid_props: "Props failed validation",
  };

  // unknown_event_type has no detail (the name just isn't registered),
  // which would leave the column empty for the most common rejection. So
  // the detail column explains it. The valid names are in the Schema
  // registry card on the same page.
  const REJECTION_FALLBACK_DETAIL = {
    unknown_event_type: "No registered event file declares this name.",
  };

  // Only shown when there is something to show; otherwise the card is
  // hidden (see index.html). Anyone can send to /events, so the event
  // name and detail may contain anything. That is why they are set with
  // el()/textContent and never innerHTML.
  function renderRejectedEvents(rejected) {
    const rows = rejected || [];
    document.getElementById("rejected-card").hidden = rows.length === 0;
    const body = document.getElementById("rejected-events");
    clear(body);
    for (const row of rows) {
      body.append(
        el("tr", null, [
          el("td", null, [REJECTION_REASONS[row.reason] || row.reason]),
          el("td", null, [
            // Missing when the request was too broken to read a name;
            // say so instead of leaving the cell empty.
            row.event
              ? el("span", { className: "event-name" }, [row.event])
              : el("span", { className: "unnamed" }, ["not readable"]),
          ]),
          el("td", { className: "num count-cell" }, [
            fullNumber.format(row.requests),
          ]),
          el("td", { className: "detail-cell" }, [
            row.lastDetail || REJECTION_FALLBACK_DETAIL[row.reason] || "—",
            // Without a date, three rejections in a week could be a live
            // problem or one already fixed on Monday.
            el("span", { className: "detail-when" }, [
              "Last seen " + new Date(row.lastSeen).toLocaleString(DATE_LOCALE),
            ]),
          ]),
        ]),
      );
    }
  }

  // "3 days ago, 09:10" rather than just a time: on a quiet site the
  // recent events can span days, and "14:02" alone would look like
  // today. The time is in the text, not only in a tooltip, which phones,
  // keyboards and screen readers can't reach.
  const relativeFormat = new Intl.RelativeTimeFormat(DATE_LOCALE, {
    numeric: "auto",
  });
  const clockFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
    dateStyle: "medium",
  });
  function localMidnight(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  function relativeTime(ts) {
    const when = new Date(ts);
    const now = new Date();
    // If the browser's clock is behind the server's, this would
    // otherwise say "in 2 minutes".
    const ago = Math.max(now.getTime() - when.getTime(), 0);
    // Count calendar days, not 24-hour blocks: 36 hours before 01:00 is
    // the day before yesterday, not "yesterday".
    const days = Math.round(
      (localMidnight(now) - localMidnight(when)) / 86_400_000,
    );
    let text;
    if (ago < 60_000) text = "just now";
    else if (ago < 3_600_000) {
      text = relativeFormat.format(-Math.floor(ago / 60_000), "minute");
    } else if (days === 0) {
      text =
        relativeFormat.format(-Math.floor(ago / 3_600_000), "hour") +
        ", " +
        clockFormat.format(when);
    } else if (days < 7) {
      text =
        relativeFormat.format(-days, "day") + ", " + clockFormat.format(when);
    } else {
      text = dateFormat.format(when) + ", " + clockFormat.format(when);
    }
    return el(
      "time",
      { dateTime: ts, title: when.toLocaleString(DATE_LOCALE) },
      [text],
    );
  }

  function renderRecentEvents(recentEvents) {
    const body = document.getElementById("recent-events");
    clear(body);
    if (recentEvents.length === 0) {
      body.append(
        el("tr", null, [
          el("td", { className: "empty", colSpan: 4 }, [
            "No events recorded yet.",
          ]),
        ]),
      );
      return;
    }
    for (const event of recentEvents) {
      body.append(
        el("tr", null, [
          el("td", { className: "ts" }, [relativeTime(event.ts)]),
          el("td", null, [
            el("span", { className: "event-name" }, [event.event]),
          ]),
          el("td", { className: "url-cell", title: event.url }, [event.url]),
          el("td", { className: "props-cell" }, [
            el("pre", null, [JSON.stringify(event.props)]),
          ]),
        ]),
      );
    }
  }

  // Fills a text box with the saved text, unless the owner has typed in
  // it since. Saving one box reloads the data, and overwriting the other
  // box would lose what they were writing there. The saved text is kept
  // on the element, so "edited" means "differs from what the server last
  // sent".
  function fillProse(id, stored) {
    const box = document.getElementById(id);
    const edited =
      box.dataset.stored !== undefined &&
      box.value !== box.dataset.stored &&
      box.value !== stored;
    if (!edited) box.value = stored;
    box.dataset.stored = stored;
  }

  // Fills the two text boxes (ground rules, business context) and their
  // size counters.
  let proseFieldMaxBytes = 0;
  function renderContext(groundRules, businessContext, maxBytes, history) {
    proseFieldMaxBytes = maxBytes;
    fillProse("ground-rules-text", groundRules.text || "");
    updateByteCount("ground-rules-text", "ground-rules-count");
    fillProse("business-context-text", businessContext.text || "");
    updateByteCount("business-context-text", "business-context-count");
    renderHistoryList(history);
    document.getElementById("context-count-note").textContent =
      history.entries.length +
      (history.entries.length === 1 ? " history entry" : " history entries");
  }

  // Counts UTF-8 bytes like the server does, not JavaScript string
  // length, so the number shown matches the limit the save is checked
  // against.
  function updateByteCount(textareaId, counterId) {
    const bytes = new TextEncoder().encode(
      document.getElementById(textareaId).value,
    ).length;
    const counter = document.getElementById(counterId);
    counter.textContent =
      fullNumber.format(bytes) +
      " / " +
      fullNumber.format(proseFieldMaxBytes) +
      " bytes";
    counter.classList.toggle("is-critical", bytes > proseFieldMaxBytes);
  }

  function formatHistoryDate(dateStr) {
    // Parsed in UTC like formatDayLabel, and formatted with DATE_LOCALE
    // like the rest of the page.
    return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(DATE_LOCALE, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  // Newest first, as the server sorts them. Entries that couldn't be
  // read are listed with a note instead of silently missing.
  function renderHistoryList(history) {
    const list = document.getElementById("history-list");
    const emptyNote = document.getElementById("history-empty-note");
    clear(list);

    if (!history.error && history.entries.length === 0) {
      emptyNote.hidden = false;
      emptyNote.textContent = "Nothing written down yet.";
    } else if (history.error) {
      emptyNote.hidden = false;
      emptyNote.textContent =
        "The history file could not be read: " + history.error;
    } else {
      emptyNote.hidden = true;
    }

    for (const entry of history.entries) {
      const when = entry.to
        ? formatHistoryDate(entry.from) + " – " + formatHistoryDate(entry.to)
        : formatHistoryDate(entry.from);
      list.append(
        el("li", { className: "history-item" }, [
          el("time", { dateTime: entry.from }, [when]),
          entry.note,
        ]),
      );
    }

    const notes = [];
    if (history.skipped && history.skipped.length > 0) {
      notes.push(
        history.skipped.length +
          (history.skipped.length === 1
            ? " entry could not be read: "
            : " entries could not be read: ") +
          history.skipped.join(" / "),
      );
    }
    if (history.dropped > 0) {
      notes.push(
        history.dropped +
          " older " +
          (history.dropped === 1 ? "entry" : "entries") +
          " omitted, over the log's limit.",
      );
    }
    for (const note of notes) {
      list.append(el("li", { className: "history-item is-note" }, [note]));
    }
  }

  // Stored events whose name no registered event has. Only renaming or
  // deleting an event creates them; an unknown name is rejected before
  // it is stored.
  //
  // Worth a warning because the effect is easy to miss: these rows still
  // count in totals, so nothing looks missing, but every panel that uses
  // a registered name leaves them out. Renaming the page-view event is
  // the worst case: its old page views count as interactions, so the
  // trend and top pages are quietly wrong rather than visibly empty.
  function renderOrphanedEvents(orphanedEvents) {
    const node = document.getElementById("orphaned-events");
    clear(node);
    const orphans = orphanedEvents || [];
    node.hidden = orphans.length === 0;
    if (orphans.length === 0) return;

    node.append(
      el("p", { className: "schema-errors-title" }, [
        orphans.length === 1
          ? "1 event type is stored but no longer registered:"
          : orphans.length +
            " event types are stored but no longer registered:",
      ]),
    );
    for (const orphan of orphans) {
      node.append(
        el("p", null, [
          el("code", null, [orphan.event]),
          " " +
            fullNumber.format(orphan.events) +
            (orphan.events === 1 ? " event, last on " : " events, last on ") +
            orphan.lastSeen.slice(0, 10),
        ]),
      );
    }
    node.append(
      el("p", null, [
        "These still count toward totals, but every panel keyed on an " +
          "event name leaves them out — so numbers above may be wrong " +
          "rather than obviously missing. Usually a renamed event: see " +
          "“Renaming an event” in docs/recipe-add-event.md.",
      ]),
    );
  }

  // Event files on the volume that the server couldn't load. Shown above
  // the registry and counted in the card's summary, because the card is
  // closed by default. Otherwise nobody would notice: the file's events
  // keep arriving and are rejected, with nothing saying why.
  function renderSchemaErrors(schemaErrors) {
    const node = document.getElementById("schema-errors");
    clear(node);
    const all = schemaErrors || [];
    node.hidden = all.length === 0;
    if (all.length === 0) return;

    // A folder that couldn't be prepared isn't a rejected file: nothing
    // was refused, the deployment reads from the image instead. Listing
    // it under "N event files were rejected" would describe the wrong
    // problem.
    const rejected = all.filter((error) => !error.directory);
    const directories = all.filter((error) => error.directory);

    const list = (errors, title) => {
      if (errors.length === 0) return;
      node.append(el("p", { className: "schema-errors-title" }, [title]));
      for (const error of errors) {
        node.append(
          el("p", null, [
            el("code", null, [error.file]),
            " " + error.messages.join(" "),
          ]),
        );
      }
    };

    list(
      directories,
      directories.length === 1
        ? "The events directory could not be prepared:"
        : "These events directories could not be prepared:",
    );
    list(
      rejected,
      rejected.length === 1
        ? "1 event file was rejected and is not registered:"
        : rejected.length +
            " event files were rejected and are not registered:",
    );
  }

  // Schema errors and orphaned rows both mean "numbers on this page are
  // wrong", and both are inside a card that starts closed. So the card's
  // title shows a red count, and the card opens by itself the first time
  // a problem is found. Only the first time: reopening a card someone
  // closed on every refresh would be annoying.
  let schemaProblemOpened = false;
  // Kept so renderSchemaRegistry can show it again: opening a form
  // redraws the card and its count.
  let schemaProblemNote = "";

  function flagOrphansInOverview(orphanedEvents) {
    const orphans = orphanedEvents || [];
    document.getElementById("orphan-note").hidden = orphans.length === 0;
    if (orphans.length === 0) return;
    document.getElementById("orphan-note-text").textContent =
      (orphans.length === 1
        ? "1 event type that is no longer registered still has "
        : orphans.length +
          " event types that are no longer registered still have ") +
      "stored events. They count toward the totals above but are left " +
      "out of every per-event panel.";
  }

  function flagSchemaProblems(schemaErrors, orphanedEvents) {
    const errors = schemaErrors || [];
    const orphans = orphanedEvents || [];
    const rejected = errors.filter((error) => !error.directory).length;
    const unwritable = errors.length - rejected;

    const notes = [];
    if (unwritable > 0) notes.push("events read from the image");
    if (rejected > 0) {
      notes.push(
        rejected + (rejected === 1 ? " file rejected" : " files rejected"),
      );
    }
    if (orphans.length > 0) {
      notes.push(
        orphans.length +
          (orphans.length === 1 ? " type orphaned" : " types orphaned"),
      );
    }

    const count = document.getElementById("schema-count-note");
    count.classList.toggle("is-critical", notes.length > 0);
    schemaProblemNote = notes.length > 0 ? " · " + notes.join(" · ") : "";
    if (notes.length === 0) return;

    if (schemaProblemOpened) return;
    schemaProblemOpened = true;
    document.getElementById("schema-card").open = true;
  }

  const plural = (n) => (n === 1 ? "event" : "events");

  // Which form is open is kept here, not in the page: the card is redrawn
  // on every data load, and an open form must survive that.
  let editing = null;
  let creating = false;
  // The open forms' elements, kept across redraws. Refresh and the period
  // buttons redraw the whole page, and building a form again from server
  // data would replace what the owner had typed. Keyed by form and event.
  // A form the latest redraw didn't ask for is dropped, so opening
  // another event, or reopening after Cancel, builds a fresh form. A Map,
  // because an edit form and another event's add-prop form can be open
  // at the same time.
  const openForms = new Map();
  let formKeysThisRender = new Set();
  let schemaEditable = false;
  let storedEventCounts = {};
  let pageViewEventType = null;
  // The other two roles, { outboundClick, fileDownload }; either may be
  // missing. There is always a page-view event (see AGENTS.md), so it has
  // its own field.
  let roleEventNames = {};
  // Which event has its "Add a prop" form open, and which has its delete
  // confirmation open. These appear inside the event's row instead of
  // replacing it as Edit does, so they have their own variables.
  let addingPropTo = null;
  let confirmDeleteName = null;

  function renderSchemaRegistry(schemaRegistry) {
    schemaRegistryCache = schemaRegistry;
    const container = document.getElementById("schema-registry");
    clear(container);
    const entries = Object.entries(schemaRegistry);
    document.getElementById("schema-count-note").textContent =
      entries.length +
      (entries.length === 1 ? " event" : " events") +
      schemaProblemNote;

    // Like the Edit buttons: hidden when the server can't write to the
    // events folder, rather than shown and failing.
    document.getElementById("new-event").hidden = !schemaEditable;

    formKeysThisRender = new Set();
    if (creating) container.append(openOrBuildForm("create", createForm));
    for (const [eventName, def] of entries) {
      container.append(
        editing && editing.name === eventName
          ? openOrBuildForm("edit:" + eventName, () =>
              eventForm(eventName, def),
            )
          : eventItem(
              eventName,
              def,
              pageViewEventType,
              storedEventCounts[eventName] || 0,
            ),
      );
    }
    for (const key of openForms.keys()) {
      if (!formKeysThisRender.has(key)) openForms.delete(key);
    }
  }

  // Where Cancel returns focus. The Edit button is inside the row's
  // <details>, which a redraw closes, and a button in a closed <details>
  // can't take focus. So the row is opened again and its summary
  // focused, which also keeps the event on screen.
  function reopenEventItem(eventName) {
    for (const item of document.querySelectorAll(
      "#schema-registry .schema-item",
    )) {
      if (item.dataset.event !== eventName) continue;
      item.open = true;
      item.querySelector("summary").focus();
      return;
    }
  }

  // Builds the form the first time this key is asked for, and returns the
  // same element, with what was typed, on every later redraw.
  function openOrBuildForm(key, build) {
    formKeysThisRender.add(key);
    if (!openForms.has(key)) openForms.set(key, build());
    return openForms.get(key);
  }

  // A short summary for the closed row, so it still shows which events
  // are actually arriving.
  function eventMeta(propCount, storedCount) {
    const props = propCount === 1 ? "1 prop" : propCount + " props";
    const stored =
      storedCount > 0
        ? fullNumber.format(storedCount) + " stored"
        : "none stored";
    return props + " · " + stored;
  }

  // One closed section per event, like the tool list. Showing every
  // event's prop table at once would fill screens even with only the
  // built-in events.
  function eventItem(eventName, def, pageViewEventType, storedCount) {
    const propEntries = Object.entries(def.props);
    const propRows = propEntries.map(([propName, prop]) =>
      el("tr", null, [
        el("td", { className: "prop-name-cell" }, [
          el("code", { className: "prop-code" }, [propName]),
        ]),
        el("td", { className: "prop-desc-cell" }, [prop.description]),
        el("td", { className: "prop-type-cell" }, [
          el("code", { className: "prop-code" }, [prop.type]),
        ]),
        el("td", { className: "prop-required-cell" }, [
          prop.required ? "Required" : "Optional",
        ]),
        el("td", { className: "prop-example-cell" }, [
          el("code", { className: "prop-code" }, [
            JSON.stringify(prop.example),
          ]),
        ]),
      ]),
    );

    const summaryChildren = [
      summaryChevron(),
      el("code", { className: "prop-code" }, [eventName]),
    ];
    // Which role this event has, if any. A deployment can rename the
    // built-in events, so the name doesn't say which is which (see
    // AGENTS.md), and editing the wrong page-view event can quietly stop
    // collection. Not labelled "built-in": once copied to the volume, a
    // built-in file looks like any other; only the role tag is known.
    if (eventName === pageViewEventType) {
      summaryChildren.push(
        el("span", { className: "schema-badge" }, ["flagged as page view"]),
      );
    } else if (eventName === roleEventNames.outboundClick) {
      summaryChildren.push(
        el("span", { className: "schema-badge" }, [
          "flagged as automatic outbound click",
        ]),
      );
    } else if (eventName === roleEventNames.fileDownload) {
      summaryChildren.push(
        el("span", { className: "schema-badge" }, [
          "flagged as automatic file download",
        ]),
      );
    }
    // Separate from the role badges above: each role belongs to at most
    // one event, but any number of events can be conversions.
    if (def.conversion) {
      summaryChildren.push(
        el("span", { className: "schema-badge" }, ["conversion"]),
      );
    }
    summaryChildren.push(
      el("span", { className: "schema-meta" }, [
        eventMeta(propEntries.length, storedCount),
      ]),
    );

    const body = [el("p", { className: "schema-desc" }, [def.description])];

    // In the opened part, not on the summary row: a button inside a
    // <summary> would also open or close the section when clicked.
    if (schemaEditable) {
      const editButton = el(
        "button",
        { type: "button", className: "link-button" },
        ["Edit"],
      );
      editButton.addEventListener("click", () => {
        editing = { name: eventName };
        creating = false;
        addingPropTo = null;
        confirmDeleteName = null;
        renderSchemaRegistry(schemaRegistryCache);
        document.getElementById("edit-name").focus();
      });

      const addPropButton = el(
        "button",
        { type: "button", className: "link-button" },
        ["Add a prop"],
      );
      addPropButton.addEventListener("click", () => {
        addingPropTo = eventName;
        confirmDeleteName = null;
        renderSchemaRegistry(schemaRegistryCache);
        document.getElementById("add-prop-name").focus();
      });

      const actions = [editButton, addPropButton];

      // Events with a role tag can be deleted too. The server (the
      // DELETE handler in routes/cockpit/events.ts) restores the file if
      // the registry can't load without it. See deleteConfirm() below for
      // the warning shown instead.
      const deleteButton = el(
        "button",
        { type: "button", className: "link-button is-critical" },
        ["Delete"],
      );
      deleteButton.addEventListener("click", () => {
        confirmDeleteName = eventName;
        addingPropTo = null;
        renderSchemaRegistry(schemaRegistryCache);
        // The card is redrawn, so the clicked button no longer exists and
        // focus would fall to <body>; a keyboard user would have to tab
        // from the top of the page. So move focus to the confirmation.
        //
        // Focus the text box, not "Delete forever": on a destructive
        // button, one stray Space press would delete.
        document.getElementById("delete-reason")?.focus();
      });
      actions.push(deleteButton);

      body.push(el("div", { className: "schema-actions" }, actions));

      // The role is part of the key because it changes the whole
      // warning. The row count isn't: it grows between refreshes, and
      // rebuilding the form would clear a typed reason, so the kept form
      // just updates the number.
      if (confirmDeleteName === eventName) {
        const isPageView = eventName === pageViewEventType;
        const form = openOrBuildForm(
          "delete:" + eventName + ":" + isPageView,
          () => deleteConfirm(eventName, isPageView),
        );
        form.setStoredCount(storedCount);
        body.push(form);
      } else if (addingPropTo === eventName) {
        body.push(
          openOrBuildForm("add-prop:" + eventName, () =>
            addPropForm(eventName),
          ),
        );
      }
    }

    body.push(
      el("div", { className: "subtable-wrap" }, [
        el("table", null, [
          el("thead", null, [
            el("tr", null, [
              el("th", null, ["Prop"]),
              el("th", null, ["Description"]),
              el("th", null, ["Type"]),
              el("th", null, ["Required"]),
              el("th", null, ["Example"]),
            ]),
          ]),
          el("tbody", null, propRows),
        ]),
      ]),
    );

    const item = el("details", { className: "schema-item" }, [
      el("summary", { className: "schema-title" }, summaryChildren),
      ...body,
    ]);
    // Set separately, because el() can't set dataset. Cancel uses it to
    // find the right row.
    item.dataset.event = eventName;
    // Add a prop and Delete open inside this <details>, and opening them
    // redraws the card. A new <details> starts closed, which would close
    // the row on the very click meant to show the form, so keep it open.
    if (addingPropTo === eventName || confirmDeleteName === eventName) {
      item.open = true;
    }
    return item;
  }

  // Only the wording can be edited. A prop's name, type and whether it is
  // required are shown as text, because changing them changes which
  // events are accepted; that needs a file edit (see lib/editEvent.ts).
  function eventForm(eventName, def) {
    const nameInput = el("input", {
      type: "text",
      className: "edit-input",
      value: eventName,
      id: "edit-name",
    });
    const descInput = el("textarea", {
      className: "edit-input",
      rows: 2,
      value: def.description,
    });
    const propInputs = {};
    const propRows = Object.entries(def.props).map(([propName, prop]) => {
      // A table row has no <label>, so each box gets an aria-label;
      // otherwise a screen reader would only say "edit text".
      const description = el("input", {
        type: "text",
        className: "edit-input",
        value: prop.description,
        ariaLabel: "Description of " + propName,
      });
      // A string example is plain text; anything else is typed as JSON,
      // which is how the server reads it.
      const example = el("input", {
        type: "text",
        className: "edit-input",
        ariaLabel: "Example for " + propName,
        value:
          prop.type === "string" && !prop.list
            ? prop.example
            : JSON.stringify(prop.example),
      });
      propInputs[propName] = { description, example };
      return el("tr", null, [
        el("td", null, [el("code", { className: "prop-code" }, [propName])]),
        el("td", null, [description]),
        el("td", null, [
          el("code", { className: "prop-code" }, [
            prop.type + (prop.list ? ".list" : ""),
          ]),
        ]),
        el("td", null, [prop.required ? "Required" : "Optional"]),
        el("td", null, [example]),
      ]);
    });

    // The two notices below only appear once the name differs; until
    // then there is nothing to move or take over.
    const stored = storedEventCounts[eventName] || 0;
    const migrateBox = el("input", { type: "checkbox", checked: true });
    const migrateRow = el("label", { className: "edit-migrate" }, [
      migrateBox,
      el("span", null, [""]),
    ]);

    // The other direction, easy to miss: rows may already be stored under
    // the new name, left over from an earlier rename. Renaming gives them
    // to this event whether or not the box above is ticked. Usually that
    // is wanted (undoing an earlier rename), but it shouldn't be a
    // surprise.
    const adoptRow = el("p", { className: "edit-migrate edit-adopt" }, [""]);

    // Only shown for a rename, because only renames are written to the
    // history log. Asked here because this is when the reason is known.
    const reasonInput = el("input", {
      type: "text",
      className: "edit-input",
      maxLength: 500,
      placeholder: "Optional — e.g. the German relaunch renamed it",
    });
    const reasonRow = field("Why the rename?", reasonInput);
    reasonRow.className += " edit-reason";
    // The reason isn't private and can't be undone from the cockpit: it is
    // shown to the agent, maybe months later. Say so before anyone types.
    //
    // Linked with aria-describedby rather than placed nearby: in forms
    // mode a screen reader reads the label and the description, and skips
    // other text between fields.
    const reasonHint = el("p", null, [
      "The rename is written to the history log your agent reads either " +
        "way. What you type is added to that line, and can only be changed " +
        "afterwards by editing history.json on the server.",
    ]);
    reasonHint.id = "rename-reason-hint";
    reasonInput.setAttribute("aria-describedby", reasonHint.id);
    reasonRow.append(reasonHint);

    const updateRenameNotices = () => {
      const typed = nameInput.value.trim();
      const renaming = typed !== eventName;
      const inherited = renaming ? storedEventCounts[typed] || 0 : 0;

      // The server refuses a name another event already has, so say that
      // instead of showing the two notices below, which describe a rename
      // that can't happen.
      if (renaming && Object.hasOwn(schemaRegistryCache, typed)) {
        migrateRow.hidden = true;
        reasonRow.hidden = true;
        adoptRow.hidden = false;
        adoptRow.textContent =
          `“${typed}” is already an event of its own. Renaming onto it ` +
          `would replace it, so this save will be refused — pick a name ` +
          `nothing else uses.`;
        return;
      }

      migrateRow.hidden = !renaming;
      adoptRow.hidden = !renaming || inherited === 0;
      reasonRow.hidden = !renaming;

      if (renaming && inherited > 0) {
        adoptRow.textContent =
          `“${typed}” already holds ${fullNumber.format(inherited)} ` +
          `${plural(inherited)} left behind by an earlier rename. After this ` +
          `rename they count as this event again.`;
      }

      if (!renaming) return;

      // Moving rows onto existing rows would merge two histories for
      // good, so it isn't offered (and the server refuses it too).
      if (inherited > 0 && stored > 0) {
        migrateBox.checked = false;
        migrateBox.disabled = true;
        migrateRow.lastChild.textContent =
          `The ${fullNumber.format(stored)} ${plural(stored)} stored as ` +
          `“${eventName}” cannot be moved across, because ` +
          `“${typed}” already has its own. Merging two histories ` +
          `cannot be undone, so move them yourself if that is what you want.`;
        return;
      }

      migrateBox.disabled = stored === 0;
      migrateRow.lastChild.textContent = stored
        ? `Also rename the ${fullNumber.format(stored)} ${plural(stored)} ` +
          `already stored as “${eventName}”. Left behind, they keep ` +
          `counting toward totals but match nothing that asks for an event ` +
          `by name.`
        : `Nothing is stored under “${eventName}” yet, so there is ` +
          `nothing to move.`;
    };
    updateRenameNotices();
    nameInput.addEventListener("input", updateRenameNotices);

    const message = el("p", { className: "edit-message" }, [""]);
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const save = el("button", { type: "button" }, ["Save"]);
    const cancel = el("button", { type: "button", className: "link-button" }, [
      "Cancel",
    ]);

    cancel.addEventListener("click", () => {
      editing = null;
      renderSchemaRegistry(schemaRegistryCache);
      // Back to the Edit button that opened the form, which the redraw
      // has just created again; otherwise focus would fall to <body>.
      reopenEventItem(eventName);
    });

    save.addEventListener("click", () => {
      const props = {};
      for (const [propName, inputs] of Object.entries(propInputs)) {
        props[propName] = {
          description: inputs.description.value.trim(),
          example: inputs.example.value,
        };
      }

      // The registry changes, so on success the whole card is reloaded.
      submitEventWrite(
        save,
        message,
        "Saving…",
        "/cockpit/events/" + encodeURIComponent(eventName),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({
            name: nameInput.value.trim(),
            description: descInput.value.trim(),
            props,
            renameStoredEvents: !migrateBox.disabled && migrateBox.checked,
            // Only sent when filled in; an empty string would produce an
            // empty "Reason given:".
            ...(reasonInput.value.trim()
              ? { reason: reasonInput.value.trim() }
              : {}),
          }),
        },
        (result) => {
          editing = null;
          return (
            "Saved " +
            result.name +
            "." +
            (result.movedRows
              ? " " +
                fullNumber.format(result.movedRows) +
                " stored events moved with it."
              : "")
          );
        },
      );
    });

    return el("div", { className: "schema-item schema-item-editing" }, [
      field("Name", nameInput),
      migrateRow,
      adoptRow,
      reasonRow,
      field("Description", descInput),
      el("div", { className: "subtable-wrap" }, [
        el("table", null, [
          el("thead", null, [
            el("tr", null, [
              el("th", null, ["Prop"]),
              el("th", null, ["Description"]),
              el("th", null, ["Type"]),
              el("th", null, ["Required"]),
              el("th", null, ["Example"]),
            ]),
          ]),
          el("tbody", null, propRows),
        ]),
      ]),
      message,
      el("div", { className: "edit-actions" }, [save, cancel]),
    ]);
  }

  // One prop's inputs, as a block rather than a table row, because a list
  // prop's example has one row per value.
  //
  // Only the name and description are free text. The type is chosen from
  // four, and "long text" is one of them rather than a checkbox, because
  // `long` only works for strings (parseRule rejects "number.long").
  // `showRequired: false` is for adding a prop to an existing event
  // (addPropForm below), which can only add an optional prop (see
  // server/lib/addEventProp.ts). The checkbox is then hidden, and
  // `read()` always returns `optional: true`.
  function propBlock(onRemove, { showRequired = true, nameInputId } = {}) {
    const nameInput = el("input", {
      type: "text",
      className: "edit-input edit-input-short",
      ...(nameInputId ? { id: nameInputId } : {}),
    });
    const typeSelect = el(
      "select",
      { className: "edit-input edit-input-short" },
      [
        el("option", { value: "text" }, ["Text"]),
        el("option", { value: "longText" }, ["Long text"]),
        el("option", { value: "number" }, ["Number"]),
        el("option", { value: "boolean" }, ["True or false"]),
      ],
    );
    const requiredBox = el("input", { type: "checkbox", checked: true });
    const listBox = el("input", { type: "checkbox" });
    const descInput = el("input", { type: "text", className: "edit-input" });

    // The input matches the type, so a number prop can't get "about
    // fifty" and a boolean only true or false. The server still checks.
    const makeControl = () => {
      if (typeSelect.value === "number") {
        return el("input", {
          type: "number",
          step: "any",
          className: "edit-input edit-input-short",
          ariaLabel: "Example value",
        });
      }
      if (typeSelect.value === "boolean") {
        return el(
          "select",
          {
            className: "edit-input edit-input-short",
            ariaLabel: "Example value",
          },
          [
            el("option", { value: "true" }, ["true"]),
            el("option", { value: "false" }, ["false"]),
          ],
        );
      }
      return el("input", {
        type: "text",
        className: "edit-input",
        ariaLabel: "Example value",
      });
    };

    let controls = [makeControl()];
    const examples = el("div", null, []);

    const renderExamples = () => {
      clear(examples);
      controls.forEach((control, index) => {
        const row = el("div", { className: "create-example-row" }, [control]);
        // Not offered for the last one: a prop without an example would
        // be rejected.
        if (listBox.checked && controls.length > 1) {
          const drop = el(
            "button",
            { type: "button", className: "link-button" },
            ["Remove"],
          );
          drop.addEventListener("click", () => {
            controls.splice(index, 1);
            renderExamples();
          });
          row.append(drop);
        }
        examples.append(row);
      });

      if (listBox.checked) {
        const add = el("button", { type: "button", className: "link-button" }, [
          "Add a value",
        ]);
        add.addEventListener("click", () => {
          controls.push(makeControl());
          renderExamples();
        });
        examples.append(add);
      }
    };

    // A value for the old type doesn't fit the new one, so the example
    // starts empty instead of keeping text the server would reject.
    typeSelect.addEventListener("change", () => {
      controls = [makeControl()];
      renderExamples();
    });
    listBox.addEventListener("change", () => {
      if (!listBox.checked) controls = controls.slice(0, 1);
      renderExamples();
    });
    renderExamples();

    const remove = el("button", { type: "button", className: "link-button" }, [
      "Remove",
    ]);
    remove.addEventListener("click", onRemove);

    // Numbered, because server errors name the prop by number
    // ("prop 3: ...").
    const heading = el("span", null, ["Prop"]);

    const checks = [el("label", null, [listBox, "Holds several values"])];
    if (showRequired) {
      checks.unshift(el("label", null, [requiredBox, "Required"]));
    }

    const node = el("div", { className: "create-prop" }, [
      el("p", { className: "create-prop-head" }, [heading, remove]),
      field("Name", nameInput),
      field("Type", typeSelect),
      el("div", { className: "create-checks" }, checks),
      field("Description", descInput),
      // Not `field()`: the examples can be several inputs, and a label
      // can only point at one, so each input has its own aria-label.
      el("div", { className: "edit-field" }, [
        el("p", { className: "edit-label" }, ["Example"]),
        examples,
      ]),
    ]);

    return {
      node,
      setNumber: (n) => {
        heading.textContent = "Prop " + n;
      },
      read: () => ({
        name: nameInput.value.trim(),
        type: typeSelect.value,
        optional: showRequired ? !requiredBox.checked : true,
        list: listBox.checked,
        description: descInput.value.trim(),
        example: controls.map((control) => control.value),
      }),
    };
  }

  // Adds one optional prop to an existing event, the only change to an
  // event's props the cockpit allows (see server/lib/addEventProp.ts).
  function addPropForm(eventName) {
    const block = propBlock(closeAddPropForm, {
      showRequired: false,
      nameInputId: "add-prop-name",
    });

    const message = el("p", { className: "edit-message" }, [""]);
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const save = el("button", { type: "button" }, ["Add prop"]);
    const cancel = el("button", { type: "button", className: "link-button" }, [
      "Cancel",
    ]);

    function closeAddPropForm() {
      addingPropTo = null;
      renderSchemaRegistry(schemaRegistryCache);
      reopenEventItem(eventName);
    }
    cancel.addEventListener("click", closeAddPropForm);

    save.addEventListener("click", () => {
      const spec = block.read();
      // The registry changes, so on success the whole card is reloaded.
      submitEventWrite(
        save,
        message,
        "Adding…",
        "/cockpit/events/" + encodeURIComponent(eventName) + "/props",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify(spec),
        },
        () => {
          addingPropTo = null;
          return (
            `Added "${spec.name}" to ${eventName}. It is optional, so ` +
            `events already arriving without it keep being accepted.`
          );
        },
      );
    });

    return el("div", { className: "schema-item-editing" }, [
      block.node,
      message,
      el("div", { className: "edit-actions" }, [save, cancel]),
    ]);
  }

  // The confirmation a Delete click opens, in place of the buttons. It
  // shows how many stored rows will be left without an event, since the
  // number helps decide more than a general warning would, and needs one
  // more click.
  function deleteConfirm(eventName, isPageView) {
    const rowsNote = (storedCount) =>
      storedCount > 0
        ? `${fullNumber.format(storedCount)} stored ${plural(storedCount)} ` +
          `will be left behind. They keep counting toward totals but ` +
          `match nothing once "${eventName}" is gone — the orphaned ` +
          `events panel below will list them.`
        : `Nothing is stored under "${eventName}" yet, so there is ` +
          `nothing left behind.`;
    // Page views can't be turned off (one event must always have the
    // tag), so deleting the page-view event means going back to the
    // built-in one. Say so before the click: props added to it will then
    // be rejected, which can quietly lose data.
    // It has an id so the reason box's aria-describedby can point at it:
    // focus moves straight to #delete-reason (see below), so a screen
    // reader would otherwise skip this warning.
    const warningText = (storedCount) =>
      isPageView
        ? `This does not stop page views being tracked — it can't be: ` +
          `every page-scoped number on this page depends on some event ` +
          `carrying this role, so nothing here can leave none. What it ` +
          `does is revert to the built-in page_view definition ` +
          `(page_title, document_language) under this same name, which ` +
          `the Schema registry card will flag as a stand-in. If this ` +
          `event carries any prop beyond those two, sites still sending ` +
          `it get invalid_props rejections from the moment this file is ` +
          `gone — not a change any client redeploy caused. ` +
          `${rowsNote(storedCount)} ` +
          `If some other event already uses the built-in's name, the ` +
          `stand-in has nowhere to go and the delete is refused instead, ` +
          `leaving this file exactly as it was.`
        : rowsNote(storedCount);
    const warning = el("p", {
      className: "edit-migrate",
      id: "delete-warning",
    });
    const reasonInput = el("input", {
      type: "text",
      className: "edit-input",
      maxLength: 500,
      placeholder: "Optional — e.g. replaced by checkout_started",
      // A fixed id, so the Delete button can find it to move focus. Only
      // one confirmation is open at a time, so it is unique.
      id: "delete-reason",
    });
    const reasonRow = field("Why delete it?", reasonInput);
    reasonRow.className += " edit-reason";
    const reasonHint = el("p", null, [
      "The deletion is written to the history log your agent reads either " +
        "way. What you type is added to that line, and can only be changed " +
        "afterwards by editing history.json on the server.",
    ]);
    reasonHint.id = "delete-reason-hint";
    reasonInput.setAttribute(
      "aria-describedby",
      warning.id + " " + reasonHint.id,
    );
    reasonRow.append(reasonHint);

    const message = el("p", { className: "edit-message" }, [""]);
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const confirmButton = el(
      "button",
      { type: "button", className: "danger-button" },
      ["Delete forever"],
    );
    const cancel = el("button", { type: "button", className: "link-button" }, [
      "Cancel",
    ]);

    cancel.addEventListener("click", () => {
      confirmDeleteName = null;
      renderSchemaRegistry(schemaRegistryCache);
      reopenEventItem(eventName);
    });

    confirmButton.addEventListener("click", () => {
      // The registry changes, so on success the whole card is reloaded.
      submitEventWrite(
        confirmButton,
        message,
        "Deleting…",
        "/cockpit/events/" + encodeURIComponent(eventName),
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify(
            reasonInput.value.trim()
              ? { reason: reasonInput.value.trim() }
              : {},
          ),
        },
        (result) => {
          confirmDeleteName = null;
          return (
            "Deleted " +
            eventName +
            "." +
            (result.storedCount
              ? " " +
                fullNumber.format(result.storedCount) +
                " stored " +
                plural(result.storedCount) +
                " left behind."
              : "")
          );
        },
      );
    });

    const form = el("div", { className: "schema-item-editing" }, [
      warning,
      reasonRow,
      message,
      el("div", { className: "edit-actions" }, [confirmButton, cancel]),
    ]);
    // Called on every redraw: the form is kept, but the count changes.
    form.setStoredCount = (storedCount) => {
      warning.textContent = warningText(storedCount);
    };
    return form;
  }

  // Creating an event defines its props, while editing only changes the
  // wording: nothing sends a new event yet, so a mistake can be fixed
  // before it costs data. See server/lib/createEvent.ts.
  function createForm() {
    const nameInput = el("input", {
      type: "text",
      className: "edit-input",
      id: "create-name",
      placeholder: "outbound_link_click",
    });
    const descInput = el("textarea", {
      className: "edit-input",
      rows: 2,
      placeholder: "Fired when a visitor clicks a link that leaves the site",
    });
    // The name and description are all the agent knows about what an
    // event means. Vague ones ("click" / "tracks clicks") make every
    // answer a guess; specific ones ("outbound_link_click" / "Sent when
    // a visitor clicks a link that leaves the site") don't. The same goes
    // for each prop's description and example below.
    const semanticHint = el("p", { className: "create-empty" }, [
      "Name and description are what the AI agent reads to understand " +
        "this event — write them as if explaining it to someone with no " +
        "other context. Prefer a specific, concrete pair (“outbound_link" +
        "_click” / “Fired when a visitor clicks a link that leaves the " +
        "site”) over a vague one (“click” / “tracks clicks”). The same " +
        "goes for each prop's description and example below.",
    ]);

    // As for a rename: rows left under this name by an earlier rename
    // become this event's history as soon as it exists.
    const adoptRow = el("p", { className: "edit-migrate edit-adopt" }, [""]);
    adoptRow.hidden = true;
    const updateAdoptNotice = () => {
      const typed = nameInput.value.trim();
      const inherited = storedEventCounts[typed] || 0;
      adoptRow.hidden = inherited === 0;
      if (inherited > 0) {
        adoptRow.textContent =
          `“${typed}” already holds ${fullNumber.format(inherited)} ` +
          `${plural(inherited)} left behind by an earlier rename or ` +
          `deletion. Creating it hands them back to this event.`;
      }
    };
    nameInput.addEventListener("input", updateAdoptNotice);

    let blocks = [];
    const propsContainer = el("div", null, []);
    const empty = el("p", { className: "create-empty" }, [
      "No props yet. An event can have none — the envelope already " +
        "records the URL, the referrer and the time.",
    ]);

    const renderProps = () => {
      clear(propsContainer);
      if (blocks.length === 0) propsContainer.append(empty);
      blocks.forEach((block, index) => {
        block.setNumber(index + 1);
        propsContainer.append(block.node);
      });
    };
    const addProp = () => {
      const block = propBlock(() => {
        blocks = blocks.filter((candidate) => candidate !== block);
        renderProps();
      });
      blocks.push(block);
      renderProps();
    };
    renderProps();

    const addButton = el("button", { type: "button" }, ["Add a prop"]);
    addButton.addEventListener("click", addProp);

    const message = el("p", { className: "edit-message" }, [""]);
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const save = el("button", { type: "button" }, ["Create"]);
    const cancel = el("button", { type: "button", className: "link-button" }, [
      "Cancel",
    ]);

    cancel.addEventListener("click", () => {
      creating = false;
      renderSchemaRegistry(schemaRegistryCache);
      document.getElementById("new-event").focus();
    });

    save.addEventListener("click", () => {
      // The registry changes, so on success the whole card is reloaded.
      submitEventWrite(
        save,
        message,
        "Creating…",
        "/cockpit/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({
            name: nameInput.value.trim(),
            description: descInput.value.trim(),
            props: blocks.map((block) => block.read()),
          }),
        },
        (result) => {
          creating = false;
          return (
            "Created " +
            result.name +
            "." +
            (result.adoptedRows
              ? " " +
                fullNumber.format(result.adoptedRows) +
                " stored " +
                plural(result.adoptedRows) +
                " under that name now count as this event."
              : "")
          );
        },
      );
    });

    return el("div", { className: "schema-item schema-item-editing" }, [
      el("p", { className: "schema-title" }, ["New event"]),
      semanticHint,
      field("Name", nameInput),
      adoptRow,
      field("Description", descInput),
      propsContainer,
      addButton,
      message,
      el("div", { className: "edit-actions" }, [save, cancel]),
    ]);
  }

  /* ---------- wiring ---------- */

  let latestData = null;
  // Hourly, to match the default period: Today is one day, which the
  // daily view would show as a single point. The period picker below
  // keeps the two in step.
  let trendMode = "hour";
  // The view to return to when leaving Today. Daily if the page opened on
  // Today and nothing was chosen before.
  let trendModeBeforeToday = "day";
  const TREND_DATA_KEY = {
    day: "trafficByDay",
    weekday: "trafficByDayOfWeek",
    hour: "trafficByHour",
  };

  function renderCurrentTrend() {
    if (!latestData) return;
    renderTrend(latestData[TREND_DATA_KEY[trendMode]], trendMode);
  }

  function render(data) {
    hideError();
    latestData = data;
    renderVersion(data.version, data.latestVersion);
    renderPeriod(data.period, data.timezone, shownRange);
    renderRetentionNote(data.retentionDays);
    renderReadOnly(data.readOnly === true);
    // Close open forms when the server is now read-only:
    // renderSchemaRegistry would still draw them, and Cancel would then
    // focus a hidden button, dropping focus to <body>.
    if (data.readOnly === true) {
      editing = null;
      creating = false;
      addingPropTo = null;
      confirmDeleteName = null;
    }
    renderSummary(
      data.trafficSummary,
      data.rejectedEventCount,
      data.botActivityCount,
    );
    renderConsentNote(data.consentBreakdown);
    renderRejectedEvents(data.topRejectedEvents);
    renderCurrentTrend();
    renderTopPages(data.topPages, data.siteHosts);
    renderTopReferrers(data.topReferrers);
    renderDeviceBreakdown(data.deviceBreakdown);
    schemaEditable = data.schemaEditable === true;
    storedEventCounts = data.storedEventCounts || {};
    pageViewEventType = data.pageViewEventType || null;
    roleEventNames = data.roleEventNames || {};
    // Before the registry, because it sets the note the count uses.
    flagSchemaProblems(data.schemaErrors, data.orphanedEvents);
    renderSchemaRegistry(data.schemaRegistry);
    renderSchemaErrors(data.schemaErrors);
    renderOrphanedEvents(data.orphanedEvents);
    flagOrphansInOverview(data.orphanedEvents);
    renderMcpTools(data.toolManifest);
    renderRecentEvents(data.recentEvents);
    renderContext(
      data.groundRules || { text: "", error: null },
      data.businessContext || { text: "", error: null },
      data.proseFieldMaxBytes || 0,
      data.history || { entries: [], skipped: [], dropped: 0, error: null },
    );
    // In the site's time zone, like the dates above, so an owner abroad
    // doesn't see "Updated 14:22" above an hourly chart ending at 20.
    document.getElementById("updated-at").textContent =
      "Updated " +
      new Date().toLocaleTimeString(DATE_LOCALE, { timeZone: data.timezone }) +
      " · " +
      lastEventText(data.lastEventAt, data.timezone);
  }

  // A clock time, not "3 min ago": the page doesn't refresh by itself, so
  // "just now" would still be shown an hour later. Compare it with the
  // load time next to it.
  function lastEventText(lastEventAt, timezone) {
    // "Stored", not "received": after Reset database, or when retention
    // has deleted everything, events may still have arrived before.
    if (!lastEventAt) return "no events stored";
    const at = new Date(lastEventAt);
    const opts = { timeZone: timezone, hour: "2-digit", minute: "2-digit" };
    const sameDay =
      at.toLocaleDateString(DATE_LOCALE, { timeZone: timezone }) ===
      new Date().toLocaleDateString(DATE_LOCALE, { timeZone: timezone });
    return (
      "last event " +
      (sameDay
        ? at.toLocaleTimeString(DATE_LOCALE, opts)
        : at.toLocaleString(DATE_LOCALE, {
            ...opts,
            day: "2-digit",
            month: "2-digit",
          }))
    );
  }

  function showError(message) {
    const banner = document.getElementById("error-banner");
    // Show it before setting the text: a live region that is hidden when
    // its text changes usually isn't announced.
    banner.classList.add("visible");
    document.getElementById("error-banner-text").textContent =
      "Failed to load cockpit data: " + message;
    // The error banner is at the top of a long page. After a refresh
    // from far down, the owner would otherwise only see the spinner stop,
    // while every number above is out of date. So scroll to it.
    //
    // The offset is measured: the header is sticky and would cover the
    // banner, and it is taller on a phone when it wraps. An inline style
    // for a computed value, like the bar widths (see
    // docs/recipe-change-cockpit.md).
    const header = document.querySelector(".topbar");
    banner.style.scrollMarginTop =
      Math.round(header.getBoundingClientRect().height) + 16 + "px";
    banner.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function hideError() {
    document.getElementById("error-banner").classList.remove("visible");
  }

  let windowRange = "today";

  async function load() {
    const button = document.getElementById("refresh");
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      const range = windowRange;
      const res = await cockpitFetch(`/cockpit/data?range=${range}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await readJson(res);
      shownRange = range;
      render(data);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }

  // There is one password, so signing out signs out every browser. The
  // page goes to the sign-in page whatever the server answers, so it
  // never looks signed in after a failed sign-out.
  //
  // Only a valid session can sign out the others. If this tab's session
  // had already ended, or no answer arrived, the sign-in page says other
  // browsers may still be signed in.
  document.getElementById("logout").addEventListener("click", async () => {
    let revoked = false;
    try {
      const res = await fetch("/cockpit/logout", {
        method: "POST",
        headers: { "X-Genug-Cockpit": "1" },
      });
      revoked = (await res.json()).revoked === true;
    } catch {
      // No answer: the sign-in page says other browsers may still be
      // signed in.
    }
    // The sign-in page explains that every browser was signed out, not
    // only this one.
    leaveNotice(revoked ? "signed-out" : "signed-out-this-tab");
    window.location.replace("login.html");
  });

  // Loads the event files as they are now on the volume (for example
  // after editing one over SSH), then reloads the page's data.
  document.getElementById("new-event").addEventListener("click", () => {
    creating = true;
    editing = null;
    addingPropTo = null;
    confirmDeleteName = null;
    renderSchemaRegistry(schemaRegistryCache);
    document.getElementById("create-name").focus();
  });

  document
    .getElementById("reload-schemas")
    .addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const note = document.getElementById("reload-note");
      button.disabled = true;
      note.classList.remove("is-critical");
      note.textContent = "Reloading…";
      try {
        const res = await cockpitFetch("/cockpit/reload", {
          method: "POST",
          // Required: it stops other sites from sending this request in
          // the owner's browser (CSRF). See the route.
          headers: { "X-Genug-Cockpit": "1" },
        });
        const result = await readJson(res);
        if (!result.ok) {
          // Say that the old registry is still in use; "failed" alone
          // sounds like the server is down.
          note.classList.add("is-critical");
          note.textContent =
            "Nothing changed — the event files could not be loaded, so the " +
            "previous ones are still in use. " +
            (result.error || "HTTP " + res.status);
          return;
        }
        note.textContent =
          result.eventCount +
          (result.eventCount === 1
            ? " event registered"
            : " events registered") +
          (result.errorCount === 0
            ? "."
            : ", " +
              result.errorCount +
              (result.errorCount === 1 ? " file" : " files") +
              " rejected — see above.");
        await load();
      } catch (err) {
        note.classList.add("is-critical");
        note.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });

  document
    .getElementById("reset-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const passwordInput = document.getElementById("reset-password");
      const button = document.getElementById("reset-database");
      const message = document.getElementById("reset-message");

      message.classList.remove("is-success");
      const result = await submitContextWrite(
        button,
        message,
        "Resetting…",
        "/cockpit/reset",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Required against CSRF, as for /cockpit/reload.
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ password: passwordInput.value }),
        },
      );
      if (!result) return;
      passwordInput.value = "";
      message.classList.add("is-success");
      const noun = (n, word) => (n === 1 ? word : word + "s");
      message.textContent =
        "Deleted " +
        fullNumber.format(result.eventsDeleted) +
        " " +
        noun(result.eventsDeleted, "event") +
        ", " +
        fullNumber.format(result.rejectedEventsDeleted) +
        " rejected " +
        noun(result.rejectedEventsDeleted, "event") +
        " and " +
        fullNumber.format(result.botActivityDeleted) +
        " bot-activity " +
        noun(result.botActivityDeleted, "row") +
        ".";
    });

  document
    .getElementById("reset-events-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const passwordInput = document.getElementById("reset-events-password");
      const button = document.getElementById("reset-events");
      const message = document.getElementById("reset-events-message");

      message.classList.remove("is-success");
      const result = await submitContextWrite(
        button,
        message,
        "Resetting…",
        "/cockpit/events/reset",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Required against CSRF, as for every cockpit write.
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ password: passwordInput.value }),
        },
      );
      if (!result) return;
      passwordInput.value = "";
      message.classList.add("is-success");
      message.textContent =
        "Replaced " +
        fullNumber.format(result.removed) +
        " event " +
        (result.removed === 1 ? "file" : "files") +
        " with " +
        fullNumber.format(result.eventCount) +
        " built-in " +
        (result.eventCount === 1 ? "event" : "events") +
        ".";
      // Said now, not only in the orphaned-events panel later, because now
      // the owner can still connect cause and effect.
      if (result.stranded && result.stranded.length > 0) {
        const total = result.stranded.reduce((sum, row) => sum + row.count, 0);
        message.classList.remove("is-success");
        message.classList.add("is-critical");
        message.textContent +=
          " " +
          fullNumber.format(total) +
          " stored " +
          (total === 1 ? "row" : "rows") +
          " now belong to no registered event (" +
          result.stranded
            .map((row) => row.event + ": " + fullNumber.format(row.count))
            .join(", ") +
          ") — they still count toward totals but match no question " +
          "asked by name.";
      }
    });

  document
    .getElementById("ground-rules-text")
    .addEventListener("input", () =>
      updateByteCount("ground-rules-text", "ground-rules-count"),
    );

  document
    .getElementById("ground-rules-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.getElementById("save-ground-rules");
      const message = document.getElementById("ground-rules-message");
      const textarea = document.getElementById("ground-rules-text");

      const result = await submitContextWrite(
        button,
        message,
        "Saving…",
        "/cockpit/context/ground-rules",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ text: textarea.value }),
        },
      );
      if (result) message.textContent = "Saved.";
    });

  document
    .getElementById("business-context-text")
    .addEventListener("input", () =>
      updateByteCount("business-context-text", "business-context-count"),
    );

  document
    .getElementById("business-context-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = document.getElementById("save-business-context");
      const message = document.getElementById("business-context-message");
      const textarea = document.getElementById("business-context-text");

      const result = await submitContextWrite(
        button,
        message,
        "Saving…",
        "/cockpit/context/about",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ text: textarea.value }),
        },
      );
      if (result) message.textContent = "Saved.";
    });

  document
    .getElementById("history-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = document.getElementById("add-history-note");
      const message = document.getElementById("history-message");
      const from = document.getElementById("history-from");
      const to = document.getElementById("history-to");
      const note = document.getElementById("history-note");

      const result = await submitContextWrite(
        button,
        message,
        "Adding…",
        "/cockpit/context/history",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({
            from: from.value,
            to: to.value || undefined,
            note: note.value.trim(),
          }),
        },
      );
      if (result) {
        message.textContent = "Added.";
        form.reset();
      }
    });

  document
    .getElementById("window-picker")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (!button) return;
      selectRange(button.dataset.range);
      try {
        localStorage.setItem(RANGE_KEY, windowRange);
      } catch {
        // Storage blocked: the choice just isn't remembered.
      }
      load();
    });

  // The period chosen last time, so someone who always looks at 7d
  // doesn't have to switch every time. Stored per browser, like the theme.
  // An unknown stored value falls back to the default instead of asking
  // the server for a period it refuses.
  const RANGE_KEY = "genug-range";

  // Sets the period and updates its buttons, for a click and for the
  // remembered choice. The caller loads the data.
  function selectRange(range) {
    const picker = document.getElementById("window-picker");
    const button = [...picker.querySelectorAll("button[data-range]")].find(
      (b) => b.dataset.range === range,
    );
    if (!button) return;
    // The trend view only changes when switching to or from Today. For
    // Today, hourly is the useful view (daily or weekday would be one
    // point or bar). Leaving Today brings back the previous view.
    const previous = windowRange;
    windowRange = range;
    if (windowRange === "today" && previous !== "today") {
      trendModeBeforeToday = trendMode;
      selectTrendMode("hour");
    } else if (previous === "today" && windowRange !== "today") {
      selectTrendMode(trendModeBeforeToday);
    }
    for (const b of picker.querySelectorAll("button")) {
      b.classList.toggle("active", b === button);
      // aria-pressed tells screen readers which button is selected; the
      // CSS class alone can't be heard.
      b.setAttribute("aria-pressed", String(b === button));
    }
  }

  try {
    const saved = localStorage.getItem(RANGE_KEY);
    if (saved) selectRange(saved);
  } catch {
    // Storage blocked: start with the default, Today.
  }

  document
    .getElementById("trend-granularity")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button) return;
      selectTrendMode(button.dataset.mode);
      renderCurrentTrend();
    });

  // Sets the trend view and updates its buttons, for a click and for the
  // period picker. The caller redraws: the period picker reloads the data
  // first.
  function selectTrendMode(mode) {
    trendMode = mode;
    const group = document.getElementById("trend-granularity");
    for (const b of group.querySelectorAll("button[data-mode]")) {
      const selected = b.dataset.mode === mode;
      b.classList.toggle("active", selected);
      // aria-pressed tells screen readers which button is selected; the
      // CSS class alone can't be heard.
      b.setAttribute("aria-pressed", String(selected));
    }
  }

  // The chart is drawn in real pixels, so it must be redrawn when its
  // container's width changes.
  const trendContainer = document.getElementById("trend-chart");
  new ResizeObserver(() => {
    if (trendContainer.clientWidth === lastTrendWidth) return;
    renderCurrentTrend();
  }).observe(trendContainer);

  // Theme switch: once used, the saved choice overrides
  // prefers-color-scheme (theme.js applies it before the page is drawn).
  function currentTheme() {
    return (
      document.documentElement.dataset.theme ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light")
    );
  }
  function updateThemeIcon() {
    // Shows the icon of the mode a click switches to: a sun in dark mode,
    // a moon in light mode.
    const isDark = currentTheme() === "dark";
    document
      .getElementById("theme-icon-sun")
      .classList.toggle("icon-hidden", !isDark);
    document
      .getElementById("theme-icon-moon")
      .classList.toggle("icon-hidden", isDark);
    // Screen readers can't see the icon change, so aria-pressed says
    // whether dark mode is on.
    document
      .getElementById("theme-toggle")
      .setAttribute("aria-pressed", String(isDark));
  }
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("genug-theme", next);
    updateThemeIcon();
  });
  updateThemeIcon();

  document.getElementById("refresh").addEventListener("click", load);

  // The list is in a card that may be closed, and a link can't scroll to
  // something hidden in a closed <details>. So open it first; the link
  // then scrolls to it.
  document.getElementById("orphan-note-link").addEventListener("click", () => {
    document.getElementById("schema-card").open = true;
  });
  load();
})();
