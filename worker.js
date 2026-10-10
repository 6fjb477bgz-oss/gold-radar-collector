const URL =
  "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD";

async function collect(env) {
  const started = Date.now();
  let received, sourceMs = null, bid = null, ask = null;
  let status = "error", error = null;

  try {
    const response = await fetch(URL, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    received = Date.now();
    const row = data.find(
      x => x.topo?.platform === "SwissquoteLtd"
        && x.topo?.server === "Live5"
    );
    const price = row?.spreadProfilePrices?.find(
      x => x.spreadProfile === "premium"
    );

    if (!price || !Number.isFinite(row.ts)
        || !Number.isFinite(price.bid)
        || !Number.isFinite(price.ask)
        || price.bid <= 0 || price.ask < price.bid) {
      throw new Error("Cours invalide");
    }

    sourceMs = row.ts;
    bid = price.bid;
    ask = price.ask;
    const age = received - sourceMs;
    status = age >= -1000 && age <= 3000 ? "fresh" : "stale";
  } catch (e) {
    received = Date.now();
    error = String(e.message || e).slice(0, 250);
  }

  await env.DB.prepare(`
    INSERT INTO market_samples
    (received_ms, source_ms, bid, ask, source,
     status, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    received, sourceMs, bid, ask,
    "SwissquoteLtd/Live5/premium",
    status, received - started, error
  ).run();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const start = Date.now();
      for (let i = 0; i < 6; i++) {
        const delay = start + i * 10000 - Date.now();
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        await collect(env);
      }
    })());
  },

  async fetch(request, env) {
    const latest = await env.DB.prepare(
      "SELECT received_ms, status FROM market_samples ORDER BY id DESC LIMIT 1"
    ).first();

    return Response.json({
      collector: "Gold Radar",
      latest: latest || null
    }, {
      headers: { "Cache-Control": "no-store" }
    });
  }
};
