(function () {
  // Why the sign-in page might be showing a message, and what this page
  // has to say to it. One key, read and cleared by whichever side
  // arrives next (see login.js).
  const NOTICE = "genug-cockpit-notice";
  function leaveNotice(value) {
    try {
      if (value === null) sessionStorage.removeItem(NOTICE);
      else sessionStorage.setItem(NOTICE, value);
    } catch {
      // Private mode, or storage blocked. Only ever costs a message.
    }
  }

  // Reaching this file at all means the browser kept the session cookie,
  // so the login page's "it was refused" note is retired here. Without
  // this it survives the whole tab, and every ordinary log out lands on
  // a red warning about an https problem the deployment does not have.
  leaveNotice(null);

  const compactNumber = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const fullNumber = new Intl.NumberFormat("en");

  // Every request this page makes goes through here, so a session that
  // ran out has one place to be noticed. Without it a 401 arrives as
  // "HTTP 401" in the error banner — technically true, and no help at
  // all to someone who just needs to sign in again.
  //
  // The page is navigating away by the time the thrown error is caught,
  // so the banner it causes is gone before it can be read.
  async function cockpitFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      leaveNotice("expired");
      window.location.replace("login.html");
      throw new Error("Your session has expired.");
    }
    return res;
  }

  // The shape every write on the schema registry card shares: save,
  // add a prop, delete, create. Disable the button, show a pending
  // message, send the request, and — only on a genuine success, never
  // on a server-side refusal or a network failure, both of which land
  // on `message` instead — hand the parsed result to `onSuccess`, then
  // reload the page's data and write what `onSuccess` returned into the
  // persistent header note.
  //
  // `onSuccess` runs *before* the reload, not after: it closes this call
  // site's own open form (editing = null and its three siblings), and
  // that has to happen first — reloading first would re-render the card
  // while a module-level variable still points at a form the fresh
  // render has nothing to reopen, leaving orphaned form elements behind
  // rather than a closed one. Caught live, not by inspection: the
  // add-prop path left a hidden <select> in the DOM until this was
  // fixed.
  //
  // Reload and both danger-zone resets are deliberately not folded in
  // here: each writes straight to its own persistent element rather
  // than a local one, and reload sets its note's text before calling
  // load() where these four call load() after — a real difference, not
  // a stylistic one, since which order is safe depends on whether
  // load() replaces the element being written to.
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
      const result = await res.json();
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

  // The same shape as submitEventWrite above, but for the deployment
  // context card: the success text lands in this call's own `message`
  // rather than in the schema card's #reload-note, which is what
  // submitEventWrite always writes to — this card has nothing
  // module-level to close on success, so there is no onSuccess step
  // either.
  async function submitContextWrite(button, message, pending, url, init) {
    button.disabled = true;
    message.hidden = false;
    message.classList.remove("is-critical");
    message.textContent = pending;
    try {
      const res = await cockpitFetch(url, init);
      const result = await res.json();
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

  // Disabling the button that triggered the request drops focus to
  // <body> in Chrome and Firefox, so without this an error is silent to
  // a keyboard or screen-reader user: nothing is announced, and nothing
  // is focused to read. message already carries aria-live="polite" for
  // the announcement; tabIndex makes it a valid focus target so the text
  // is also reachable, not just spoken once and gone.
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

  // A label is only a label to a browser or a screen reader once it
  // points at its control: without this pairing, clicking the text does
  // nothing and the input is announced as unlabelled. The id is
  // generated because these forms are built more than once per page.
  let fieldSeq = 0;
  function field(labelText, control) {
    if (!control.id) control.id = "field-" + ++fieldSeq;
    return el("div", { className: "edit-field" }, [
      el("label", { htmlFor: control.id }, [labelText]),
      control,
    ]);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  // SVG elements need createElementNS, unlike el() above (a plain
  // document.createElement("svg") produces an unrendered unknown
  // HTML element, not the SVG namespace's <svg>).
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

  // The disclosure triangle for a summary row. Shared by the registry
  // and the tool list, which are the same control twice.
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

  // Total activity for a period/bucket — same additive
  // interactionEvents + viewEvents shape get_traffic_summary uses.
  function totalEvents(row) {
    return row.interactionEvents + row.viewEvents;
  }

  // Printed verbatim: the release tag already carries its own "v"
  // (v0.2.0), and a clone reports "dev", which prefixing would turn
  // into "vdev". Its own line under the product name, so an older
  // server that doesn't send the field leaves an empty line rather
  // than a dangling separator.
  function renderVersion(version, latestVersion) {
    document.getElementById("version").textContent = version || "";
    // The header's own version line is deliberately the quietest thing
    // up there (looked up when filing a bug, not read every time) — so
    // it's repeated here, with real visual weight, at the one place on
    // the page an operator with more than one Genug tab open could
    // otherwise reset the wrong one without noticing.
    document.getElementById("danger-zone-instance").textContent = version
      ? `You are about to act on ${location.host}, running ${version}.`
      : "";
    // null covers both "no newer tag" and "the server hasn't checked
    // yet" (see lib/updateCheck.ts) — same hidden state either way,
    // rather than a pill that flickers in on a later refresh.
    document.getElementById("version-pill").hidden = !latestVersion;
  }

  function renderPeriod(period) {
    const from = new Date(period.from).toLocaleDateString();
    const to = new Date(period.to).toLocaleDateString();
    document.getElementById("period").textContent = from + " – " + to;
  }

  // Read-only mode hides every write control rather than disabling it:
  // a disabled button asks "why?", and a disabled Reset database with a
  // password field beside it is bait on a cockpit whose credentials are
  // printed on a public page. The server refuses the writes regardless;
  // this only stops the page offering them.
  //
  // Every element here is toggled, never written to. The explanatory
  // copy is authored in index.html, so it cannot go stale when the flag
  // turns off — the earlier version wrote the text and never unwrote
  // it, leaving "this deployment is read-only" beside a working Reload
  // button — and it cannot re-announce, since #reload-note is a live
  // region and this state is permanent rather than a result.
  function renderReadOnly(readOnly) {
    document.getElementById("read-only-note").hidden = !readOnly;
    document.getElementById("schema-read-only-note").hidden = !readOnly;
    document.getElementById("tools-read-only-note").hidden = !readOnly;
    document.getElementById("reload-schemas").hidden = readOnly;
    document.getElementById("danger-zone").hidden = readOnly;
    // Its subject is the button above it, which is gone.
    document.getElementById("reload-note").hidden = readOnly;
    document.getElementById("context-read-only-note").hidden = !readOnly;
    // Unlike every other write control this toggles, the two prose
    // textareas also carry content someone came here to read — hiding
    // the whole form the way the danger zone or the history add-form
    // disappear would take the text with it. Only the control that
    // writes (Save) is a write control; the box holding what was
    // written is not, so it stays, marked non-editable instead.
    document.getElementById("ground-rules-text").readOnly = readOnly;
    document.getElementById("save-ground-rules").hidden = readOnly;
    document.getElementById("business-context-text").readOnly = readOnly;
    document.getElementById("save-business-context").hidden = readOnly;
    document.getElementById("history-form").hidden = readOnly;
  }

  function renderRetentionNote(retentionDays) {
    document.getElementById("retention-note").textContent =
      retentionDays == null
        ? "Retention: no limit configured — events are kept forever."
        : "Retention: events older than " +
          retentionDays +
          " days are automatically deleted.";
  }

  // A share, not a stat card: for a deployment with no consent banner
  // (consent UI is out of v1 scope) a card would read 100% consentless
  // forever. Counted in events, not sessions — a session that accepts
  // mid-visit keeps its session_id (see "Visitor identification" in
  // docs/decisions.md), so a session has no single consent mode to report. The
  // raw counts ride along with the percentage for the same reason
  // getBouncePages returns them: 100% of two events and 100% of two
  // thousand mean very different things.
  function renderConsentNote(breakdown) {
    const node = document.getElementById("consent-note");
    const consentful = breakdown.consentful.events;
    const total = consentful + breakdown.consentless.events;
    // No events at all: a 0% share would read as a consent problem
    // rather than as an empty period.
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
    // The red number is otherwise a dead end — the card explaining it is
    // a screen further down and nothing says to look.
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
  // The right inset is wide enough for half of the last x-axis
  // label, which is centred on the final data point and would
  // otherwise be clipped by the SVG's own edge.
  const TREND_PADDING = { top: 12, right: 24, bottom: 26, left: 46 };
  const GRID_LINES = 4;

  function formatDayLabel(dateStr) {
    // dateStr is "YYYY-MM-DD" (UTC) — pin the parse to midnight UTC
    // so the label can't shift a day depending on the viewer's
    // timezone.
    return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  // The three trend views share one renderer: "day" is a genuine
  // time series (drawn as connected lines), while "weekday"/"hour"
  // are discrete categories with no meaningful slope between them
  // (drawn as paired bars instead) — same underlying additive
  // sessions/events shape, just a different chart type for a
  // continuous vs. categorical axis.
  const TREND_MODES = {
    day: {
      getLabel: (row) => formatDayLabel(row.date),
      getFullLabel: (row) =>
        new Date(`${row.date}T00:00:00Z`).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
      chart: "line",
      caption: "Traffic by day (UTC)",
    },
    weekday: {
      getLabel: (row) => row.day.slice(0, 3),
      getFullLabel: (row) => row.day,
      chart: "bar",
      caption: "Traffic by day of week (UTC)",
    },
    hour: {
      getLabel: (row) => String(row.hour),
      getFullLabel: (row) => String(row.hour).padStart(2, "0") + ":00 UTC",
      chart: "bar",
      caption: "Traffic by hour of day (UTC)",
    },
  };

  // Picks an axis maximum whose gridline labels are numbers a person
  // can actually read off (0/20/40/60/80) rather than the raw data
  // maximum sliced into quarters (0/13/26/39/52).
  //
  // It's the gap *between* gridlines that gets rounded to a nice
  // 1/2/5 × 10ⁿ value, not the maximum itself — rounding the maximum
  // and then dividing by GRID_LINES gives a nice top number but ugly
  // ones underneath it. Never smaller than 1, so a chart with a
  // handful of events is labelled in whole events, not halves.
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
  // Width the chart was last drawn at, so the ResizeObserver below
  // can ignore the height change its own render causes and only
  // redraw on a real width change.
  let lastTrendWidth = null;

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

  // A tap opens a bucket's tooltip (see the click handler on the hit
  // rects); a tap anywhere outside the chart is the only way a
  // touchscreen can close it again, since mouseleave never fires there.
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".chart-wrap")) hideTooltip();
  });

  function renderTrend(rows, mode) {
    const container = document.getElementById("trend-chart");
    hideTooltip();
    clear(container);

    if (rows.length === 0) {
      container.append(el("p", { className: "empty" }, ["No data yet."]));
      return;
    }

    // Rendered at the container's real pixel width rather than a
    // fixed viewBox stretched with preserveAspectRatio="none" —
    // that scaled the axis text and stroke widths horizontally,
    // visibly distorting both on a wide screen.
    lastTrendWidth = container.clientWidth;
    const width = Math.max(320, Math.round(lastTrendWidth));
    const { getLabel, getFullLabel, chart, caption } = TREND_MODES[mode];
    document.getElementById("trend-caption").textContent = caption;
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

    // Purely visual — gridlines, the drawn shape, axis labels — kept in
    // one aria-hidden group so a screen reader skips straight past them
    // to the hit rects below, which carry the same numbers as real
    // accessible content instead.
    const children = [];

    // Horizontal gridlines + y-axis labels: without them the chart
    // showed a shape but no readable magnitude at all.
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

    // X labels are thinned out to whatever actually fits, so a
    // 30-day or 24-hour axis doesn't collapse into overlapping ink.
    const labelStep = Math.max(
      1,
      Math.ceil(rows.length / Math.max(1, Math.floor(innerWidth / 52))),
    );
    rows.forEach((row, i) => {
      if (i % labelStep !== 0 && i !== rows.length - 1) return;
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

    // One transparent full-height hit area per bucket, so hovering
    // anywhere in a column reads its values — not just the 2px
    // line or the bar itself. Focusable and labelled, unlike the
    // decorative group above: this is the chart's actual accessible
    // surface for a sighted keyboard-only visitor, who can see the
    // shape but has no pointer to hover with — Tab reaches each bucket
    // and reads the same values the mouse tooltip shows.
    const interactive = [];
    rows.forEach((row, i) => {
      const label = `${getFullLabel(row)}: ${fullNumber.format(row.sessions)} sessions, ${fullNumber.format(totalEvents(row))} events`;
      const hit = svgEl("rect", {
        class: "trend-hit",
        x: slotX(i),
        y: TREND_PADDING.top,
        width: slotWidth,
        height: innerHeight,
        tabindex: "0",
        role: "img",
        "aria-label": label,
      });
      // Adjacent sibling so .trend-hit:hover + .trend-hit-bg (below)
      // still matches — has to stay a direct svg child right after
      // hit, not folded into the aria-hidden decorative group.
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
      // Touch has no hover, so a tap does the same job.
      hit.addEventListener("click", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("blur", hideTooltip);
      interactive.push(hit, highlight);
    });

    const svg = svgEl(
      "svg",
      {
        viewBox: `0 0 ${width} ${TREND_HEIGHT}`,
        width,
        height: TREND_HEIGHT,
        class: "trend-svg",
      },
      [svgEl("g", { "aria-hidden": "true" }, children), ...interactive],
    );
    svg.addEventListener("mouseleave", hideTooltip);
    container.append(svg);

    // The same numbers as a real table, visually hidden — a
    // read-it-all-at-once alternative to tabbing through each hit rect
    // above. Built from the same `rows`, so the two cannot drift.
    container.append(trendTable(rows, mode));
  }

  function trendTable(rows, mode) {
    const { getFullLabel, caption } = TREND_MODES[mode];
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
    return el("table", { className: "visually-hidden" }, [
      el("caption", null, [caption]),
      el("thead", null, [head]),
      el("tbody", null, body),
    ]);
  }

  /* ---------- ranked bar lists ---------- */

  // Top pages, top referrers and the device breakdown are the same
  // component: a label, an optional sub-label, and a count drawn
  // both as a number and as a proportional bar.
  function renderBarList(containerId, rows, getLabel, getValue, options) {
    const { getSubLabel } = options || {};
    const container = document.getElementById(containerId);
    clear(container);
    if (rows.length === 0) {
      container.append(el("p", { className: "empty" }, ["No data yet."]));
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
            { className: "bar-label", title: getLabel(row) },
            sub
              ? [getLabel(row), el("span", { className: "bar-sub" }, [sub])]
              : [getLabel(row)],
          ),
          el("div", { className: "bar-value" }, [compactNumber.format(value)]),
        ]),
      );
    }
  }

  function renderTopPages(topPages) {
    renderBarList(
      "top-pages",
      topPages,
      (page) => page.path,
      (page) => page.views,
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

  // The classifier's device types are lowercase identifiers, so they
  // are spelled for reading here. "other" is a real classification
  // rather than a gap — a smart TV or game console, not something the
  // parser gave up on (see lib/userAgent.ts) — so it says so, instead
  // of a bare word that reads like a bug.
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
    // One accordion per tool, closed, showing the name alone. A tool
    // description is product surface written for an agent, not a
    // caption — several run to a paragraph — so neither the full text
    // nor a truncated head of it belongs on a row whose job is to let
    // the list of names be read down.
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

  // The three points routes/events.ts can refuse a request at. Spelled
  // out because the stored value is an identifier, and "invalid_props"
  // in a column headed "Reason" tells a site owner less than the
  // sentence it stands for. An unrecognised value falls through to
  // itself rather than to a blank cell — a reason added later should
  // look unfamiliar, not look like nothing.
  const REJECTION_REASONS = {
    invalid_envelope: "Malformed request",
    unknown_event_type: "Event not registered",
    invalid_props: "Props failed validation",
  };

  // unknown_event_type stores no detail — there is no validation error
  // to summarise, the name simply isn't in the registry. That would
  // leave an em dash in the one column a reader consults to find out
  // what to do, and on the most common rejection of the three, so the
  // reason itself is spelled out instead. Not a list of the valid
  // names: they are on this same page, in the Schema registry card.
  const REJECTION_FALLBACK_DETAIL = {
    unknown_event_type: "No registered event file declares this name.",
  };

  // Only rendered when there is something to show; the card is hidden
  // otherwise (see index.html). Every cell here is attacker-controlled
  // in principle — /events is public, so the event name and the
  // validation detail are both whatever the caller sent — which is why
  // they go through el()/textContent and never innerHTML.
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
            // Absent for a request too malformed to read a name out of,
            // which is itself the useful signal — so it is said, not
            // left blank.
            row.event
              ? el("span", { className: "event-name" }, [row.event])
              : el("span", { className: "unnamed" }, ["not readable"]),
          ]),
          el("td", { className: "num count-cell" }, [
            fullNumber.format(row.requests),
          ]),
          el("td", { className: "detail-cell" }, [
            row.lastDetail || REJECTION_FALLBACK_DETAIL[row.reason] || "—",
            // A count with no date can't be acted on: three rejections
            // in a week is either a live breakage or something already
            // fixed on Monday, and those want opposite responses.
            el("span", { className: "detail-when" }, [
              "Last seen " + new Date(row.lastSeen).toLocaleString(),
            ]),
          ]),
        ]),
      );
    }
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
          el("td", { className: "ts" }, [
            new Date(event.ts).toLocaleTimeString(),
          ]),
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

  // Populates the two prose textareas (ground rules, business context)
  // and their byte counters. Reset on every load(), same as the
  // schema-registry forms — typed-but-unsaved text lost to an unrelated
  // refresh is an existing trade-off of this page's one-shot render, not
  // one this card invents.
  let proseFieldMaxBytes = 0;
  function renderContext(groundRules, businessContext, maxBytes, history) {
    proseFieldMaxBytes = maxBytes;
    document.getElementById("ground-rules-text").value = groundRules.text || "";
    updateByteCount("ground-rules-text", "ground-rules-count");
    document.getElementById("business-context-text").value =
      businessContext.text || "";
    updateByteCount("business-context-text", "business-context-count");
    renderHistoryList(history);
    document.getElementById("context-count-note").textContent =
      history.entries.length +
      (history.entries.length === 1 ? " history entry" : " history entries");
  }

  // Measured the same way the server does — UTF-8 bytes, not JS string
  // length — so the count shown here agrees with the limit the save
  // will actually be checked against. Shared by both prose fields: same
  // cap, same rendering, only the element ids differ.
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

  // Newest first, as the server already sorted them. A note the reader
  // could not trust is named rather than silently missing — the same
  // "say why, don't go quiet" rule the schema errors panel follows.
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
      const when = entry.to ? entry.from + " – " + entry.to : entry.from;
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

  // Event files on the volume that the server refused to load. Rendered
  // above the registry they failed to join, and counted in the card's
  // collapsed summary too — the card is closed by default, and a
  // rejected file nobody notices is the whole problem: its events keep
  // arriving and keep being counted as rejected, with nothing saying
  // the schema never loaded.
  // Stored events whose type the registry no longer has. Only a rename
  // or a deletion can produce these — an unregistered name is rejected
  // before it is ever stored.
  //
  // Worth a warning because the damage is selective rather than
  // obvious: these rows still count toward totals, so nothing looks
  // missing, but every panel keyed on a registered name drops them.
  // Renaming the page-view event is the case that hurts — its history
  // stops counting as a page view and starts counting as an
  // interaction, so the trend and the top-pages list are quietly wrong
  // rather than visibly empty.
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

  function renderSchemaErrors(schemaErrors) {
    const node = document.getElementById("schema-errors");
    clear(node);
    const all = schemaErrors || [];
    node.hidden = all.length === 0;
    if (all.length === 0) return;

    // A directory that could not be prepared is not a rejected file:
    // nothing was refused, the whole deployment is reading from the
    // image instead. Filing it under "N event files were rejected"
    // describes the wrong problem to someone already confused about
    // why their edits will not save.
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
  // wrong right now", and both render inside a card that starts closed
  // — so the count beside its title says which, in red, and the card
  // opens itself the first time a load finds one. Only the first time:
  // reopening a card someone deliberately closed on every refresh is
  // its own kind of broken.
  let schemaProblemOpened = false;

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
    if (notes.length === 0) return;
    count.textContent = count.textContent + " · " + notes.join(" · ");

    if (schemaProblemOpened) return;
    schemaProblemOpened = true;
    document.getElementById("schema-card").open = true;
  }

  const plural = (n) => (n === 1 ? "event" : "events");

  // Editing state lives here rather than in the DOM: the card is
  // re-rendered from scratch on every data load, and an open form has
  // to survive that (a save triggers a reload of exactly this card).
  let editing = null;
  let creating = false;
  // The open form's DOM node, kept across re-renders. Refresh and the
  // period buttons re-render the whole page, and rebuilding the form
  // from server data would replace a half-typed description — or five
  // half-filled props — with stored values, leaving the form open and
  // looking as though nothing had happened. Keyed so that switching to
  // a different event, or reopening one after cancelling, still builds
  // a fresh form.
  let openFormNode = null;
  let openFormKey = null;
  let schemaEditable = false;
  let storedEventCounts = {};
  let pageViewEventType = null;
  // The other two roles — { outboundClick, fileDownload }, either value
  // possibly absent. Page view is always present (see AGENTS.md: exactly
  // one event must carry it), which is why it gets its own top-level
  // field rather than living in here too.
  let roleEventNames = {};
  // Which event has its inline "Add a prop" form open, and which has its
  // inline delete confirmation open. Both live inside an otherwise
  // read-only eventItem() row rather than replacing it the way Edit
  // does, so they get their own state instead of reusing editing/creating.
  let addingPropTo = null;
  let confirmDeleteName = null;

  function renderSchemaRegistry(schemaRegistry) {
    schemaRegistryCache = schemaRegistry;
    const container = document.getElementById("schema-registry");
    clear(container);
    const entries = Object.entries(schemaRegistry);
    document.getElementById("schema-count-note").textContent =
      entries.length + (entries.length === 1 ? " event" : " events");

    // Same rule as the Edit buttons: absent when the events directory
    // is one the server cannot write, rather than present and failing.
    document.getElementById("new-event").hidden = !schemaEditable;

    if (!creating && !editing) {
      openFormNode = null;
      openFormKey = null;
    }

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
  }

  // Builds the form the first time this key is asked for, and hands
  // back the same node — inputs and all — on every re-render after.
  // Where Cancel goes back to. The Edit button it came from now sits
  // inside the accordion body, which a fresh render draws closed — a
  // button in a closed <details> can't take focus, so the row is opened
  // again and its summary focused instead. That also leaves the event
  // the user was reading on screen rather than collapsed away.
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

  function openOrBuildForm(key, build) {
    if (openFormKey !== key) {
      openFormKey = key;
      openFormNode = build();
    }
    return openFormNode;
  }

  // How much there is to see before opening one, so the closed row
  // still answers "which of these is actually firing" — the question
  // someone opens this card with.
  function eventMeta(propCount, storedCount) {
    const props = propCount === 1 ? "1 prop" : propCount + " props";
    const stored =
      storedCount > 0
        ? fullNumber.format(storedCount) + " stored"
        : "none stored";
    return props + " · " + stored;
  }

  // One closed accordion per event, same control as the tool list.
  // Expanded, every event printed its full five-column prop table, so
  // three built-in events filled a screen and a half before a
  // deployment added any of its own — and since each table sized itself
  // to its own content, the columns didn't line up between them, which
  // is what made the card read as a wall rather than a list.
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
    // Which role, if any, this event fills. A deployment can rename any
    // of the three built-ins, so the name alone never says which one is
    // which (see AGENTS.md) — and for page view, picking the wrong one
    // to edit is how collection quietly stops. Deliberately not called
    // "built-in": once seeded, nothing distinguishes a shipped file from
    // one the deployment wrote, and the role tag is the only thing
    // actually tracked here.
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
    // Independent of the role badges above: a role is at most one event
    // by construction, but any number of events can be a conversion, so
    // this is never an "else" of that chain.
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

    // Inside the opened body rather than on the summary row: a button
    // nested in a <summary> is a control inside a control, and clicking
    // it would toggle the accordion as well as open the form.
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

      // Deleting a role-tagged event is not disabled here: the server
      // (routes/cockpit.ts's DELETE handler) deletes, then asks the
      // real registry loader via reloadEvents() and restores the file
      // if that loader refuses the result — the one case that needs
      // care, and it needs the whole directory to decide, which this
      // button cannot see any more than lib/deleteEvent.ts can. See
      // deleteConfirm() below for the note this row gets instead.
      const deleteButton = el(
        "button",
        { type: "button", className: "link-button is-critical" },
        ["Delete"],
      );
      deleteButton.addEventListener("click", () => {
        confirmDeleteName = eventName;
        addingPropTo = null;
        renderSchemaRegistry(schemaRegistryCache);
        // The card is rebuilt, so the button that was just clicked no
        // longer exists and focus would fall to <body> — leaving a
        // keyboard user to tab from the top of the page to reach a
        // confirmation they just opened. Every other opener on this card
        // already moves focus; this one was missed.
        //
        // The input, not "Delete forever": focus on a destructive button
        // is one stray Space away from doing the thing.
        document.getElementById("delete-reason")?.focus();
      });
      actions.push(deleteButton);

      body.push(el("div", { className: "schema-actions" }, actions));

      if (confirmDeleteName === eventName) {
        body.push(
          deleteConfirm(
            eventName,
            storedCount,
            eventName === pageViewEventType,
          ),
        );
      } else if (addingPropTo === eventName) {
        body.push(addPropForm(eventName));
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
    // el() assigns properties, and dataset isn't assignable that way —
    // this is what Cancel uses to find its way back to the right row.
    item.dataset.event = eventName;
    // Add a prop and Delete live inside this <details> rather than
    // replacing it the way the Edit form does — so the click that opens
    // either one triggers a renderSchemaRegistry() that rebuilds this
    // exact node from scratch. A freshly created <details> always starts
    // closed, which would silently collapse the row shut on the very
    // click that was supposed to reveal the form. Forcing it open here
    // is what keeps that from happening.
    if (addingPropTo === eventName || confirmDeleteName === eventName) {
      item.open = true;
    }
    return item;
  }

  // Only the words are inputs. A prop's name, type and whether it is
  // required are printed exactly as they are in the read-only view,
  // because changing one of those changes whether a live event is
  // accepted — that is a file edit, deliberately (see lib/editEvent.ts).
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
      const description = el("input", {
        type: "text",
        className: "edit-input",
        value: prop.description,
      });
      // A plain string's example is its own text; anything else is
      // typed as JSON, which is how the server reads it back.
      const example = el("input", {
        type: "text",
        className: "edit-input",
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

    // Both notices below appear only once the name actually differs —
    // until then there is nothing to move and nothing to inherit, and
    // the warnings would just be noise.
    const stored = storedEventCounts[eventName] || 0;
    const migrateBox = el("input", { type: "checkbox", checked: true });
    const migrateRow = el("label", { className: "edit-migrate" }, [
      migrateBox,
      el("span", null, [""]),
    ]);

    // The other direction, and easy to miss: rows may already be stored
    // under the name being typed, left orphaned by some earlier rename.
    // Renaming onto them hands them to this event whether or not the
    // box above is ticked — usually because you are undoing that
    // earlier rename, which is exactly when nobody wants a surprise.
    const adoptRow = el("p", { className: "edit-migrate edit-adopt" }, [""]);

    // Shown only for a rename, because only a rename is written to the
    // history log — offering the box on a wording fix would invite a
    // sentence nothing ever records. Asked here rather than left for a
    // history note afterwards: this is the moment anyone knows why.
    const reasonInput = el("input", {
      type: "text",
      className: "edit-input",
      maxLength: 500,
      placeholder: "Optional — e.g. the German relaunch renamed it",
    });
    const reasonRow = field("Why the rename?", reasonInput);
    reasonRow.className += " edit-reason";
    // A box next to a form field reads like a form field, and this one
    // is neither private nor undoable: it is quoted to an AI agent
    // months later, and the cockpit has no screen for taking it back.
    // Said before anyone types, which is the only moment it helps.
    //
    // aria-describedby rather than a paragraph sitting nearby — a
    // screen reader in forms mode reads the label and the description,
    // and skips loose text between fields.
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

      // A name another event already holds is refused server-side, so
      // say so rather than show the two notices below: they describe a
      // rename that cannot happen, and the second would call that
      // event's own rows orphans left behind by an earlier rename.
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

      // Moving rows on top of rows merges two histories into one name
      // with nothing able to separate them again, so it is refused
      // rather than offered — here as well as on the server.
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
      // Back to the Edit button that opened this, which the re-render
      // has just recreated — otherwise closing the form drops focus to
      // <body> the same way opening it used to.
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

      // The registry the page is displaying is about to change, so a
      // success reloads the whole card rather than patching it.
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
            // Sent only when it says something: an empty string would
            // be a "Reason given:" with nothing after it.
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

  // One prop, as a block rather than a table row: a list prop's example
  // grows a row per value, which a table cell handles badly.
  //
  // Nothing here is free text except the name and the description. The
  // type is a fixed list of four, and `long` is one of those four
  // rather than a modifier checkbox — parseRule rejects "number.long",
  // and an option that is invalid in three of four combinations is
  // better not offered than validated after the fact.
  // `showRequired: false` is for adding a prop to an event that already
  // has traffic (addPropForm below): the cockpit can only ever add an
  // OPTIONAL prop there — see server/lib/addEventProp.ts for why — so
  // the checkbox that would suggest otherwise isn't offered, and
  // `read()` always reports `optional: true`.
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

    // The control matches the declared type, so a number prop cannot be
    // given "about fifty" and a boolean cannot be given anything but
    // true or false. The server still checks — this only means the
    // ordinary way through the form cannot produce a bad example.
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
        // Never offered for the last one: a prop with no example at all
        // is a file the checker rejects, so that is not a state the
        // form should be able to reach.
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

    // A control built for the old type holds a value the new one cannot
    // mean, so the honest move is to start the example over rather than
    // carry text across and let the server reject it.
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

    // Numbered because a server-side validation error names the block
    // it came from ("prop 3: ..."), and an unnumbered pile of identical
    // blocks gives nobody a way to find it.
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
      // Not `field()`: the examples are a group of controls that comes
      // and goes with the list checkbox, and a label can only point at
      // one. Each control carries its own aria-label instead.
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

  // The one shape change the cockpit can make to an event that already
  // has traffic: one new OPTIONAL prop, never required, never a rule
  // string change. See server/lib/addEventProp.ts for why that line is
  // safe here and nowhere else on this form.
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
      // The registry the page is displaying is about to gain a prop, so
      // a success reloads the whole card rather than patching it.
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

  // The inline confirmation a Delete click opens, replacing the button
  // row with the row count that will be orphaned and one more click
  // before anything is removed. Same disclosure pattern the rename form
  // already uses for the same reason: the number, not a generic warning,
  // is what lets someone decide.
  function deleteConfirm(eventName, storedCount, isPageView) {
    const rowsNote =
      storedCount > 0
        ? `${fullNumber.format(storedCount)} stored ${plural(storedCount)} ` +
          `will be left behind. They keep counting toward totals but ` +
          `match nothing once "${eventName}" is gone — the orphaned ` +
          `events panel below will list them.`
        : `Nothing is stored under "${eventName}" yet, so there is ` +
          `nothing left behind.`;
    // Page view can't actually be turned off — exactly one event must
    // always carry the tag — so "Delete" on it does not mean the same
    // thing it means everywhere else. Said plainly, before the click:
    // this reverts to the built-in shape rather than stopping anything,
    // and it is the one delete on this page that can quietly cost you
    // data collection if you don't expect it, since a customized prop
    // stops validating the moment the file it lived in is gone.
    // Named so the reason input's aria-describedby can reach it too:
    // opening this panel moves focus straight to #delete-reason (see
    // below), skipping past this paragraph visually and, without the
    // link, for a screen reader as well — the one part of this warning
    // a sighted user gets for free just by it sitting above the field.
    const warning = el(
      "p",
      { className: "edit-migrate", id: "delete-warning" },
      [
        isPageView
          ? `This does not stop page views being tracked — it can't be: ` +
            `every page-scoped number on this page depends on some event ` +
            `carrying this role, so nothing here can leave none. What it ` +
            `does is revert to the built-in page_view definition ` +
            `(page_title, document_language) under this same name, which ` +
            `the Schema registry card will flag as a stand-in. If this ` +
            `event carries any prop beyond those two, sites still sending ` +
            `it get invalid_props rejections from the moment this file is ` +
            `gone — not a change any client redeploy caused. ${rowsNote} ` +
            `If some other event already uses the built-in's name, the ` +
            `stand-in has nowhere to go and the delete is refused instead, ` +
            `leaving this file exactly as it was.`
          : rowsNote,
      ],
    );
    const reasonInput = el("input", {
      type: "text",
      className: "edit-input",
      maxLength: 500,
      placeholder: "Optional — e.g. replaced by checkout_started",
      // Fixed, because the Delete button that opens this form has to
      // find it to move focus there: only one confirmation is open at a
      // time, so it stays unique.
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
      // The registry the page is displaying is about to lose an event,
      // so a success reloads the whole card rather than patching it.
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

    return el("div", { className: "schema-item-editing" }, [
      warning,
      reasonRow,
      message,
      el("div", { className: "edit-actions" }, [confirmButton, cancel]),
    ]);
  }

  // Creating an event does define its props, where editing one only
  // changes its words. The difference is not how hard each is to build:
  // a name nothing has sent yet has no traffic to reject and no history
  // to strand, so a wrong shape here costs a file you fix rather than a
  // site that quietly stops collecting. See server/lib/createEvent.ts.
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
    // The name and description are the only thing the agent has to go
    // on when it decides what an event means — there is no schema
    // browser on its side, just these words in a tool description. A
    // vague pair ("click" / "tracks clicks") makes every future
    // question about this event a guess; a specific one ("outbound_
    // link_click" / "Fired when a visitor clicks a link that leaves
    // the site") answers it outright. The same goes for each prop's
    // own description and example, below.
    const semanticHint = el("p", { className: "create-empty" }, [
      "Name and description are what the AI agent reads to understand " +
        "this event — write them as if explaining it to someone with no " +
        "other context. Prefer a specific, concrete pair (“outbound_link" +
        "_click” / “Fired when a visitor clicks a link that leaves the " +
        "site”) over a vague one (“click” / “tracks clicks”). The same " +
        "goes for each prop's description and example below.",
    ]);

    // The same disclosure a rename makes, for the same reason: rows
    // stranded under this name by an earlier rename become this event's
    // history the moment it exists.
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
      // The registry the page is displaying is about to gain an event,
      // so a success reloads the whole card rather than patching it.
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
  let trendMode = "day";
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
    renderPeriod(data.period);
    renderRetentionNote(data.retentionDays);
    renderReadOnly(data.readOnly === true);
    // A form left open when the server came back read-only would render
    // on regardless — renderSchemaRegistry draws the open form without
    // consulting schemaEditable — and its Cancel would then focus a
    // button that is now display:none, dropping focus to the body.
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
    renderTopPages(data.topPages);
    renderTopReferrers(data.topReferrers);
    renderDeviceBreakdown(data.deviceBreakdown);
    schemaEditable = data.schemaEditable === true;
    storedEventCounts = data.storedEventCounts || {};
    pageViewEventType = data.pageViewEventType || null;
    roleEventNames = data.roleEventNames || {};
    renderSchemaRegistry(data.schemaRegistry);
    renderSchemaErrors(data.schemaErrors);
    renderOrphanedEvents(data.orphanedEvents);
    flagSchemaProblems(data.schemaErrors, data.orphanedEvents);
    renderMcpTools(data.toolManifest);
    renderRecentEvents(data.recentEvents);
    renderContext(
      data.groundRules || { text: "", error: null },
      data.businessContext || { text: "", error: null },
      data.proseFieldMaxBytes || 0,
      data.history || { entries: [], skipped: [], dropped: 0, error: null },
    );
    document.getElementById("updated-at").textContent =
      "Updated " + new Date().toLocaleTimeString();
  }

  function showError(message) {
    const banner = document.getElementById("error-banner");
    // Shown before the text is written, not after: a live region that
    // is display:none at the moment its content changes generally isn't
    // announced at all.
    banner.classList.add("visible");
    document.getElementById("error-banner-text").textContent =
      "Failed to load cockpit data: " + message;
    // The banner sits at the top of a page that is several screens
    // long. Refresh from the bottom of the schema registry and the only
    // other sign of failure is the spinner stopping, while every number
    // above goes quietly stale.
    //
    // Measured rather than a fixed offset: the header is sticky, so
    // scrolling the banner to the top of the viewport parks it
    // underneath — and the header is a different height once it wraps
    // on a phone. An inline style for a computed value, same as the
    // bar widths (see docs/recipe-change-cockpit.md).
    const header = document.querySelector(".topbar");
    banner.style.scrollMarginTop =
      Math.round(header.getBoundingClientRect().height) + 16 + "px";
    banner.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function hideError() {
    document.getElementById("error-banner").classList.remove("visible");
  }

  let windowDays = 7;

  async function load() {
    const button = document.getElementById("refresh");
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      const res = await cockpitFetch(`/cockpit/data?days=${windowDays}`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      render(await res.json());
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }

  // There is one password, so there is one session: signing out here
  // signs out every browser holding one, which is the behaviour to want
  // from a button someone presses because a copy is somewhere it should
  // not be. Goes to the login page whatever the server answers — a
  // failed sign-out that leaves the page sitting there looking signed in
  // is the one outcome worth ruling out.
  document.getElementById("logout").addEventListener("click", async () => {
    try {
      await fetch("/cockpit/logout", {
        method: "POST",
        headers: { "X-Genug-Cockpit": "1" },
      });
    } catch {
      // there is nothing this page can do about that from here.
    }
    // The login page says what happened, and says the part the button
    // itself cannot: this signs out every browser, not this one.
    leaveNotice("signed-out");
    window.location.replace("login.html");
  });

  // Applies whatever is on the volume now — a file edited over SSH, or
  // dropped in by hand. The page then reloads its own data, because the
  // registry it is displaying has just been replaced.
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
          // Not decoration: this is what stops a cross-site form from
          // POSTing here on a logged-in browser's behalf. See the route.
          headers: { "X-Genug-Cockpit": "1" },
        });
        const result = await res.json();
        if (!result.ok) {
          // Worth spelling out — "failed" on its own reads as "the
          // server is down", and the previous registry is still serving.
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

      message.hidden = false;
      message.classList.remove("is-critical", "is-success");
      message.textContent = "Resetting…";
      button.disabled = true;
      try {
        const res = await cockpitFetch("/cockpit/reset", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Same CSRF story as /cockpit/reload: a header no plain
            // cross-site form can set. See the route.
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ password: passwordInput.value }),
        });
        const result = await res.json();
        if (!result.ok) {
          message.classList.add("is-critical");
          message.textContent = result.error || "HTTP " + res.status;
          return;
        }
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
        await load();
      } catch (err) {
        message.classList.add("is-critical");
        message.textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });

  document
    .getElementById("reset-events-form")
    .addEventListener("submit", async (event) => {
      event.preventDefault();
      const passwordInput = document.getElementById("reset-events-password");
      const button = document.getElementById("reset-events");
      const message = document.getElementById("reset-events-message");

      message.hidden = false;
      message.classList.remove("is-critical", "is-success");
      message.textContent = "Resetting…";
      button.disabled = true;
      try {
        const res = await cockpitFetch("/cockpit/events/reset", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Same CSRF story as every other cockpit write: a header no
            // plain cross-site form can set. See the route.
            "X-Genug-Cockpit": "1",
          },
          body: JSON.stringify({ password: passwordInput.value }),
        });
        const result = await res.json();
        if (!result.ok) {
          message.classList.add("is-critical");
          message.textContent = result.error || "HTTP " + res.status;
          return;
        }
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
        // Said here rather than left to the orphaned-events panel alone:
        // this is the moment the rows were stranded, and the only one
        // where the person can still connect the two.
        if (result.stranded && result.stranded.length > 0) {
          const total = result.stranded.reduce(
            (sum, row) => sum + row.count,
            0,
          );
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
        await load();
      } catch (err) {
        message.classList.add("is-critical");
        message.textContent = err.message;
      } finally {
        button.disabled = false;
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
      const button = event.target.closest("button[data-days]");
      if (!button) return;
      windowDays = Number(button.dataset.days);
      for (const b of event.currentTarget.querySelectorAll("button")) {
        b.classList.toggle("active", b === button);
        // Selection is otherwise conveyed by a class alone, which a
        // screen reader cannot see: it hears three plain buttons and
        // nothing at all changing when one is pressed.
        b.setAttribute("aria-pressed", String(b === button));
      }
      load();
    });

  document
    .getElementById("trend-granularity")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (!button) return;
      trendMode = button.dataset.mode;
      for (const b of event.currentTarget.querySelectorAll("button")) {
        b.classList.toggle("active", b === button);
        // Selection is otherwise conveyed by a class alone, which a
        // screen reader cannot see: it hears three plain buttons and
        // nothing at all changing when one is pressed.
        b.setAttribute("aria-pressed", String(b === button));
      }
      renderCurrentTrend();
    });

  // The chart is drawn at real pixel dimensions, so it has to be
  // redrawn when its container's width changes — a plain
  // width: 100% SVG would rescale itself, this one can't.
  const trendContainer = document.getElementById("trend-chart");
  new ResizeObserver(() => {
    if (trendContainer.clientWidth === lastTrendWidth) return;
    renderCurrentTrend();
  }).observe(trendContainer);

  // Theme toggle: explicit, persisted choice that overrides
  // prefers-color-scheme once used (see the head-inline script that
  // applies the saved value before first paint).
  function currentTheme() {
    return (
      document.documentElement.dataset.theme ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light")
    );
  }
  function updateThemeIcon() {
    // Shows the icon for the mode a click would switch *to*, not
    // the active one — sun visible in dark mode (click for light),
    // moon visible in light mode (click for dark).
    const isDark = currentTheme() === "dark";
    document
      .getElementById("theme-icon-sun")
      .classList.toggle("icon-hidden", !isDark);
    document
      .getElementById("theme-icon-moon")
      .classList.toggle("icon-hidden", isDark);
    // The icon swap is invisible to a screen reader — aria-pressed is
    // what actually confirms the toggle took effect, same as the
    // window-picker and trend-granularity controls above.
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
  load();
})();
