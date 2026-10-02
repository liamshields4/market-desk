# Market Desk

A single-file market overview and stock-analysis page (`index.html`) with a live, editable
unlevered-FCFF DCF. Vanilla JS, Chart.js from a CDN, no build step. Deploys to GitHub Pages as-is.

## Run it

- Locally: open `index.html` in a browser, or serve the folder (`python3 -m http.server 8000`).
- GitHub Pages: push this folder to a repo, Settings → Pages → deploy from the branch root. Hash
  routing (`#/` and `#/stock/AAPL`) means no server configuration is needed.

On first load a modal asks for API keys. They are stored in `localStorage` only and sent only to
the provider that issued them. Nothing is hardcoded.

## Data sources

| Provider | Used for | Key |
|---|---|---|
| Financial Modeling Prep (`/stable`) | quotes, profiles, statements, ratios, estimates, targets, insiders, news, calendars, treasury rates | required |
| Alpha Vantage | news sentiment + topic grouping; fallback for anything FMP's plan does not cover (quotes, statements, earnings, insiders, 13F holders, commodities, price history, forward P/E) | optional |
| FRED | 2Y/10Y/30Y yields (10Y is the DCF risk-free rate), fed funds, broad dollar index | optional, needs a proxy |

### FMP plan notes

FMP gates endpoints by plan. The app degrades per panel rather than failing:

- **Free (250 calls/day)**: only ~87 sample tickers (AAPL, MSFT, JPM, XOM … but not SHAK), no
  news, no intraday sparklines, no batch quotes, no economic calendar, no insider search. With an
  Alpha Vantage key the app falls back for the missing pieces.
- **Starter**: everything above except batch quotes, S&P 500 breadth and 13F holders. Quotes are
  fetched one symbol at a time (cached 15 min).
- **Premium**: batch quotes and breadth work. **Ultimate**: 13F holders and the dollar-index
  future (`DXUSD`) as well.

### FRED and CORS

FRED's API does not send CORS headers, so a browser page cannot call it directly. Either leave the
FRED fields blank (the app uses FMP's treasury endpoint, then Alpha Vantage) or deploy this
Cloudflare Worker and paste its URL into "FRED proxy base URL":

```js
export default {
  async fetch(request, env) {
    const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/series/")) return new Response("Not found", { status: 404, headers: cors });
    const upstream = new URL("https://api.stlouisfed.org/fred" + url.pathname);
    url.searchParams.delete("api_key");
    for (const [k, v] of url.searchParams) upstream.searchParams.append(k, v);
    upstream.searchParams.set("api_key", env.FRED_API_KEY);
    const res = await fetch(upstream.toString(), { cf: { cacheTtl: 300, cacheEverything: true } });
    const headers = new Headers(cors); headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(res.body, { status: res.status, headers });
  },
};
```

```
npm create cloudflare@latest -- fred-proxy    # Hello World worker, JavaScript; replace src/index.js with the code above
cd fred-proxy && npx wrangler secret put FRED_API_KEY
npx wrangler deploy                           # prints https://fred-proxy.<account>.workers.dev
```

Set `ALLOWED_ORIGIN` in `wrangler.jsonc` `vars` to your Pages origin. The app then requests
`<proxy>/series/observations?series_id=DGS10&file_type=json&sort_order=desc&limit=5`.

## Caching

Responses are cached in `localStorage` with a timestamp: quotes and intraday 15 min, news 30 min,
calendars 6 h, EOD history 6 h, statements/ratios/profile 24 h, macro 12 h. The Refresh button
drops only the short-lived entries. "Clear cached data" in Keys drops everything. When the browser
quota is hit the oldest half of the cache is pruned automatically.

## The DCF (section F)

Unlevered free cash flow to the firm, 5 explicit years plus a terminal value:

```
FCFF_t = EBIT_t × (1 − tax) + D&A_t − capex_t − ΔNWC_t       (no tax on negative EBIT; NOLs ignored)
PV      = Σ FCFF_t / (1 + WACC)^t                              (optional mid-year: t − 0.5)
TV      = FCFF_5 × (1 + g) / (WACC − g)      or      EBITDA_5 × exit multiple
EV      = Σ PV + TV / (1 + WACC)^5
Equity  = EV − net debt − minority interest − preferred
```

Defaults: growth fades linearly from the trailing 3-year revenue CAGR to the terminal rate; EBIT
margin is the trailing 3-year average; tax is the average effective rate clamped to 10–30 %;
D&A, capex and ΔNWC are 3-year averages as a share of revenue; WACC uses the FRED/FMP 10Y as the
risk-free rate, the profile beta, a 5 % equity risk premium, cost of debt = interest expense /
average debt, and market-cap vs book-debt weights. The exit multiple defaults to the peer-median
EV/EBITDA from section E. Every input is editable and the page recalculates on each keystroke.

The engine (between the `@@ENGINE` markers in `index.html`) has no DOM dependencies;
`node dev/test-dcf.js` runs its unit tests.

Reliability flags appear when the model is on thin ice: banks and insurers, fewer than three
fiscal years, negative margins, negative FCFF in every year, WACC within a point of terminal
growth, terminal value above 85 % of EV, missing share count, or a currency mismatch between
the filings and the quote.

## Development

- `node dev/test-dcf.js` — engine unit tests.
- `node dev/mock-api.js` — a dependency-free mock of the FMP, Alpha Vantage and FRED endpoints
  with synthetic fixtures for AAPL, SHAK, JPM and RIVN, serving `index.html` at
  `http://localhost:8765/`. In Keys → Advanced set the FMP base to `http://localhost:8765/stable`,
  the Alpha Vantage base to `http://localhost:8765/av` and the FRED base to
  `http://localhost:8765/fred`, with any non-empty keys. `MOCK_PLAN=free node dev/mock-api.js`
  simulates FMP's Free plan.

## Layout of `index.html`

The stylesheet and script are split into numbered, commented sections: tokens and layout CSS;
§1 config, §2 storage/cache, §3 HTTP providers, §4 formatting and DOM helpers, §5 data helpers,
§5b Alpha Vantage adapters, §6 router and settings, §7 market overview, §8 stock analysis
sections A–E/G/H/I, §9 DCF engine, §10 DCF UI, §11 boot.
