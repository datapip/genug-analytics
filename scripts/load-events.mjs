// Measures how many events per second a running Genug server accepts and
// stores, for the figure in docs/operations.md. Run it again before
// changing that figure.
//
//   node scripts/load-events.mjs
//
// Environment: PORT (3000), CONCURRENCY (8), SECONDS (20),
// WARMUP_SECONDS (3). The server under test needs TRUST_PROXY=1, since
// this sets X-Forwarded-For (see below), and ALLOWED_ORIGIN pointing at
// its own port.
//
// Afterwards, check that the rows were stored, not just the status
// codes:
//
//   sqlite3 <DB_PATH> "SELECT COUNT(*) FROM events"
//
// **Don't measure query speed on a database this script has written to.**
// It writes ~60,000 rows dated now, so they fall into every period you
// then query, which can make a 7-day cockpit page on a million-row
// database five times slower and look like a slow CPU. Keep a clean copy
// and restore it before measuring queries (see docs/decisions.md).
//
// Sends POST /events as fast as the server answers, with a fixed number
// of workers. No dependency: plain node:http with keep-alive, as a
// browser does.
//
// The addresses imitate real traffic, because the rate limit would
// otherwise be all that gets measured: one address per worker would only
// get 429s (600/min is 10/s per address).
//
// So each visitor is a /24 (what the consentless visitor_id hashes, see
// truncateIp) and sends five page views before a new visitor starts.
// That keeps every address far under the limit and gives four out of
// five events an earlier event of the same session, as on a real site.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 3012);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const SECONDS = Number(process.env.SECONDS ?? 20);
const WARMUP_SECONDS = Number(process.env.WARMUP_SECONDS ?? 3);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const PAGES = ["/", "/pricing", "/blog/how-we-built-it", "/docs", "/contact"];

function body(worker, n) {
  return JSON.stringify({
    auto: "pageView",
    url: `https://example.com${PAGES[(worker + n) % PAGES.length]}`,
    referrer: n % 3 === 0 ? "https://news.ycombinator.com/" : "",
    props: { page_title: "Example page", document_language: "en" },
  });
}

const EVENTS_PER_VISITOR = 5;

// A private range, so no real host is affected if this is pointed
// somewhere by mistake. 10.a.b is the visitor (the /24 the hash uses);
// the last number is fixed, so the rate limit sees five requests per
// address.
function addressFor(worker, n) {
  const visitor =
    (worker * 1000003 + Math.floor(n / EVENTS_PER_VISITOR)) % 65536;
  return `10.${visitor >> 8}.${visitor & 255}.10`;
}

async function worker(index, agent, deadline, latencies, statuses) {
  let n = 0;

  while (Date.now() < deadline) {
    const ip = addressFor(index, n);
    const payload = body(index, n++);
    const started = process.hrtime.bigint();
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/events",
          method: "POST",
          agent,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            origin: `http://localhost:${PORT}`,
            "user-agent": UA,
            "x-forwarded-for": ip,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    const micros = Number(process.hrtime.bigint() - started) / 1000;
    if (latencies) latencies.push(micros);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

async function run(seconds, collect) {
  const agents = Array.from(
    { length: CONCURRENCY },
    () => new http.Agent({ keepAlive: true, maxSockets: 1 }),
  );
  const latencies = collect ? [] : null;
  const statuses = new Map();
  const deadline = Date.now() + seconds * 1000;
  const startedAt = Date.now();

  await Promise.all(
    agents.map((agent, index) =>
      worker(index, agent, deadline, latencies, statuses),
    ),
  );
  for (const agent of agents) agent.destroy();

  const elapsed = (Date.now() - startedAt) / 1000;
  const total = [...statuses.values()].reduce((sum, n) => sum + n, 0);
  return { elapsed, total, statuses, latencies };
}

await run(WARMUP_SECONDS, false);
const result = await run(SECONDS, true);

const sorted = result.latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      concurrency: CONCURRENCY,
      seconds: Number(result.elapsed.toFixed(1)),
      requests: result.total,
      perSecond: Math.round(result.total / result.elapsed),
      statuses: Object.fromEntries(result.statuses),
      latencyMs: {
        p50: Number((percentile(sorted, 50) / 1000).toFixed(2)),
        p95: Number((percentile(sorted, 95) / 1000).toFixed(2)),
        p99: Number((percentile(sorted, 99) / 1000).toFixed(2)),
        max: Number((sorted[sorted.length - 1] / 1000).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
