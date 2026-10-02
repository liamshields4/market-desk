#!/usr/bin/env node
/* ==========================================================================
   MARKET DESK — mock API server (dev only)

   Serves index.html plus stand-ins for the three providers the app talks to:
     GET /stable/<fmp-path>?...            Financial Modeling Prep (stable API)
     GET /av?function=...                  Alpha Vantage
     GET /fred/series/observations?...     FRED
     GET / or /index.html                  the app itself (read from disk on every hit)

   Point the app at it from Keys → Advanced:
     FMP base URL            http://localhost:8765/stable
     Alpha Vantage base URL  http://localhost:8765/av
     FRED base URL           http://localhost:8765/fred
   Any non-empty string works as an API key.

   Switches
     PORT=8765            listen port
     MOCK_PLAN=free       imitate FMP's Free (Basic) plan: batch-quote, news/*,
                          historical-chart/*, economic-calendar,
                          insider-trading/search, sp500-constituent and
                          institutional-ownership/* return 403; symbol endpoints
                          return [] for anything outside FREE_SYMBOLS; statement
                          style endpoints are capped at 5 rows.
     &fail=1 on any URL   that one request returns 403 {"Error Message": ...}

   ALL FIXTURE DATA IS SYNTHETIC. Magnitudes are modelled on public knowledge of
   the companies (Apple, Shake Shack, JPMorgan, Rivian) so the app's charts and
   ratios look sane, but every number is generated in code below and none of it
   is a real filing, quote or estimate. Field names follow the providers' real
   response shapes (see scratchpad research notes), because the app parses them.

   No dependencies: plain `http`, `fs`, `path`, `url`.
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 8765;
const PLAN = (process.env.MOCK_PLAN || 'premium').toLowerCase();   // 'free' | anything else
const INDEX_HTML = path.resolve(__dirname, '..', 'index.html');

/* ==========================================================================
   §1  SMALL UTILITIES — deterministic RNG, dates, rounding
   ========================================================================== */
// Mulberry32: tiny seeded PRNG so every symbol gets the same series on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function seedOf(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
// Box-Muller normal from a uniform source
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const round = (v, d = 2) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };
const r0 = v => Math.round(v);
const lerp = (a, b, t) => a + (b - a) * t;
// n values linearly spaced from a to b (inclusive) — used instead of long literals
const ramp = (a, b, n) => Array.from({ length: n }, (_, i) => n === 1 ? b : lerp(a, b, i / (n - 1)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = arr => arr.reduce((s, v) => s + v, 0);
const B = 1e9, M = 1e6;

// ---- dates ----
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));                 // m = 1..12
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
const lastDayOfMonth = (y, m) => utc(y, m + 1, 0);
const lastSaturday = (y, m) => { const d = lastDayOfMonth(y, m); return addDays(d, -((d.getUTCDay() + 1) % 7)); };
const isWeekend = d => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const todayUTC = () => { const n = new Date(); return utc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()); };
const unixNow = () => Math.floor(Date.now() / 1000);
// Wall clock in New York, as numbers (DST handled by Intl)
function nowET() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { dow, y: +g('year'), m: +g('month'), d: +g('day'), hh: +g('hour') % 24, mm: +g('minute'), date: `${g('year')}-${g('month')}-${g('day')}` };
}
function isNyseOpenNow() { const t = nowET(); if (t.dow === 0 || t.dow === 6) return false; const mins = t.hh * 60 + t.mm; return mins >= 570 && mins < 960; }
// Latest weekday on or before the given UTC date (today's ET date by default)
function latestWeekday(d) { let x = d || (() => { const t = nowET(); return utc(t.y, t.m, t.d); })(); while (isWeekend(x)) x = addDays(x, -1); return x; }
// Monday..Sunday of the current week (local to ET)
function thisWeek() { const t = nowET(); const today = utc(t.y, t.m, t.d); const mon = addDays(today, -((t.dow + 6) % 7)); return { mon, sun: addDays(mon, 6), today }; }
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

/* ==========================================================================
   §2  COMPANY MODELS — the four fully-modelled tickers
   Each model is a small parameter set; §3 turns it into statements.
   Revenue arrays are the only per-year literals; everything else is a ramp or a ratio.
   ========================================================================== */
const COMPANIES = {
  AAPL: {
    symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', exchangeFullName: 'NASDAQ Global Select', sector: 'Technology', industry: 'Consumer Electronics',
    cik: '0000320193', isin: 'US0378331005', cusip: '037833100', ceo: 'Timothy D. Cook', website: 'https://www.apple.com', ipoDate: '1980-12-12',
    address: 'One Apple Park Way', city: 'Cupertino', state: 'CA', zip: '95014', phone: '(408) 996-1010', employees: 166000, beta: 1.10, lastDividend: 1.05,
    description: 'Apple Inc. designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories, and sells a range of related services. Its products include iPhone, Mac, iPad, and Wearables, Home and Accessories; services include the App Store, AppleCare, cloud, payments and subscription content. (Synthetic mock profile.)',
    fyEndMonth: 9, weekEnding: true, firstFY: 2016, price: 332.4, dailyVol: 0.016, drift: 0.22,
    revenue: [215.6, 229.2, 265.6, 260.2, 274.5, 365.8, 394.3, 383.3, 391.0, 416.2].map(v => v * B),
    grossMargin: ramp(0.391, 0.469, 10), opMargin: ramp(0.278, 0.320, 10), taxRate: ramp(0.255, 0.156, 10),
    rdPct: 0.075, interestExpense: ramp(1.5 * B, 0, 10), interestIncome: ramp(3.9 * B, 3.6 * B, 10), daPct: 0.028, capexPct: 0.031, sbcPct: 0.031,
    sharesDil: ramp(22.0 * B, 15.0 * B, 10), cash: ramp(20.5 * B, 35.9 * B, 10), stInv: ramp(46.7 * B, 18.8 * B, 10), ltInv: ramp(170.4 * B, 77.7 * B, 10),
    stDebt: ramp(11.6 * B, 20.3 * B, 10), ltDebt: ramp(75.4 * B, 92.0 * B, 10), equity: ramp(128.2 * B, 73.7 * B, 10),
    recvPct: 0.14, invPct: 0.014, payPct: 0.17, ppePct: 0.13, goodwillPct: 0, buybackPct: ramp(0.14, 0.218, 10), divPct: ramp(0.057, 0.037, 10),
    seasonality: [0.33, 0.24, 0.21, 0.22], segments: { 'iPhone': 0.50, 'Service': 0.26, 'Mac': 0.08, 'iPad': 0.07, 'Wearables, Home and Accessories': 0.09 },
    geo: { 'Americas Segment': 0.43, 'Europe Segment': 0.27, 'Greater China Segment': 0.15, 'Japan Segment': 0.07, 'Rest of Asia Pacific Segment': 0.08 },
    peers: ['MSFT', 'GOOGL', 'DELL', 'HPQ', 'SONY'], epsGrowthEst: 0.09, targetMult: 1.06, ratings: [6, 24, 11, 2, 1],
    execs: [['Timothy D. Cook', 'Chief Executive Officer & Director', 16500000], ['Kevan Parekh', 'Senior VP & Chief Financial Officer', 4800000], ['Jeff Williams', 'Chief Operating Officer', 27000000], ['Katherine L. Adams', 'Senior VP, General Counsel & Secretary', 27000000], ['Deirdre O\'Brien', 'Senior VP of Retail & People', 27000000]],
  },
  SHAK: {
    symbol: 'SHAK', name: 'Shake Shack Inc.', exchange: 'NYSE', exchangeFullName: 'New York Stock Exchange', sector: 'Consumer Cyclical', industry: 'Restaurants',
    cik: '0001620533', isin: 'US8190471016', cusip: '819047101', ceo: 'Robert Lynch', website: 'https://www.shakeshack.com', ipoDate: '2015-01-30',
    address: '225 Varick Street, Suite 301', city: 'New York', state: 'NY', zip: '10014', phone: '(646) 747-7200', employees: 13500, beta: 1.75, lastDividend: 0,
    description: 'Shake Shack Inc. owns, operates and licenses Shake Shack restaurants, a modern "roadside" burger stand serving burgers, chicken, hot dogs, crinkle-cut fries, shakes and frozen custard in the United States and internationally. (Synthetic mock profile.)',
    fyEndMonth: 12, weekEnding: false, firstFY: 2018, price: 101.3, dailyVol: 0.028, drift: 0.08,
    revenue: [459, 595, 523, 740, 900, 1087, 1253, 1392].map(v => v * M),
    grossMargin: [0.225, 0.215, 0.145, 0.185, 0.182, 0.195, 0.205, 0.212], opMargin: [0.042, 0.032, -0.085, -0.012, -0.028, 0.012, 0.026, 0.047], taxRate: ramp(0.18, 0.24, 8),
    rdPct: 0, interestExpense: ramp(1.0 * M, 2.2 * M, 8), interestIncome: ramp(2.5 * M, 12 * M, 8), daPct: 0.078, capexPct: 0.13, sbcPct: 0.012,
    sharesDil: ramp(37.5 * M, 42.4 * M, 8), cash: ramp(24 * M, 215 * M, 8), stInv: ramp(68 * M, 105 * M, 8), ltInv: ramp(0, 0, 8),
    stDebt: ramp(28 * M, 44 * M, 8), ltDebt: ramp(150 * M, 650 * M, 8), equity: ramp(300 * M, 530 * M, 8),
    recvPct: 0.012, invPct: 0.004, payPct: 0.03, ppePct: 0.42, goodwillPct: 0, buybackPct: ramp(0, 0, 8), divPct: ramp(0, 0, 8),
    seasonality: [0.22, 0.26, 0.27, 0.25], segments: { 'Shack Sales': 0.96, 'Licensing': 0.04 },
    geo: { 'United States': 0.92, 'International Licensed': 0.08 },
    peers: ['CMG', 'CAVA', 'SG', 'WING', 'DPZ'], epsGrowthEst: 0.30, targetMult: 1.18, ratings: [2, 9, 10, 2, 0],
    execs: [['Robert Lynch', 'Chief Executive Officer & Director', 6200000], ['Katherine I. Fogertey', 'Chief Financial Officer', 2400000], ['Stephanie Sentell', 'Chief Operations Officer', 1800000], ['Steph So', 'Chief Growth Officer', 1500000]],
  },
  JPM: {
    symbol: 'JPM', name: 'JPMorgan Chase & Co.', exchange: 'NYSE', exchangeFullName: 'New York Stock Exchange', sector: 'Financial Services', industry: 'Banks - Diversified',
    cik: '0000019617', isin: 'US46625H1005', cusip: '46625H100', ceo: 'James Dimon', website: 'https://www.jpmorganchase.com', ipoDate: '1980-03-17',
    address: '383 Madison Avenue', city: 'New York', state: 'NY', zip: '10179', phone: '(212) 270-6000', employees: 317000, beta: 1.08, lastDividend: 1.40,
    description: 'JPMorgan Chase & Co. is a global financial services firm operating in consumer and community banking, corporate and investment banking, commercial banking and asset and wealth management. (Synthetic mock profile.)',
    fyEndMonth: 12, weekEnding: false, firstFY: 2016, price: 231.8, dailyVol: 0.015, drift: 0.13, bank: true,
    revenue: [95.7, 99.6, 109.0, 115.6, 119.5, 121.6, 128.7, 158.1, 166.9, 177.6].map(v => v * B),
    // bank: costOfRevenue = provision for credit losses; opex = noninterest expense; interest expense is informational (already netted in revenue)
    grossMargin: [0.945, 0.947, 0.955, 0.952, 0.857, 0.924, 0.951, 0.939, 0.938, 0.940], opMargin: ramp(0.372, 0.405, 10), taxRate: ramp(0.28, 0.20, 10),
    rdPct: 0, interestExpense: [10.0, 13.6, 25.0, 32.0, 14.0, 5.6, 20.3, 80.0, 112.0, 118.0].map(v => v * B), interestIncome: ramp(55 * B, 290 * B, 10), daPct: 0.055, capexPct: 0, sbcPct: 0.013,
    sharesDil: ramp(3.62 * B, 2.78 * B, 10), cash: ramp(23.9 * B, 29.0 * B, 10), stInv: ramp(380 * B, 480 * B, 10), ltInv: ramp(290 * B, 560 * B, 10),
    stDebt: ramp(60 * B, 140 * B, 10), ltDebt: ramp(295 * B, 420 * B, 10), equity: ramp(254.2 * B, 345.0 * B, 10),
    recvPct: 1.5, invPct: 0, payPct: 1.9, ppePct: 0.18, goodwillPct: 0.38, buybackPct: ramp(0.095, 0.17, 10), divPct: ramp(0.075, 0.085, 10),
    assetScale: 22.5,   // bank balance sheet: total assets ≈ 22.5× revenue (loans + securities carried in otherNonCurrentAssets)
    seasonality: [0.25, 0.25, 0.25, 0.25], segments: { 'Consumer & Community Banking': 0.42, 'Corporate & Investment Bank': 0.37, 'Asset & Wealth Management': 0.13, 'Commercial Banking': 0.09, 'Corporate': -0.01 },
    geo: { 'North America': 0.76, 'Europe/Middle East/Africa': 0.14, 'Asia-Pacific': 0.07, 'Latin America': 0.03 },
    peers: ['BAC', 'WFC', 'C', 'GS', 'MS'], epsGrowthEst: 0.06, targetMult: 1.08, ratings: [5, 12, 9, 1, 0],
    execs: [['James Dimon', 'Chairman & Chief Executive Officer', 36000000], ['Jeremy Barnum', 'Chief Financial Officer', 12000000], ['Marianne Lake', 'CEO, Consumer & Community Banking', 18500000], ['Daniel Pinto', 'President & Chief Operating Officer', 30000000], ['Mary Callahan Erdoes', 'CEO, Asset & Wealth Management', 27000000]],
  },
  RIVN: {
    symbol: 'RIVN', name: 'Rivian Automotive, Inc.', exchange: 'NASDAQ', exchangeFullName: 'NASDAQ Global Select', sector: 'Consumer Cyclical', industry: 'Auto - Manufacturers',
    cik: '0001874178', isin: 'US76954A1034', cusip: '76954A103', ceo: 'Robert J. Scaringe', website: 'https://www.rivian.com', ipoDate: '2021-11-10',
    address: '14600 Myford Road', city: 'Irvine', state: 'CA', zip: '92606', phone: '(888) 748-4261', employees: 14800, beta: 1.95, lastDividend: 0,
    description: 'Rivian Automotive, Inc. designs, develops, manufactures and sells electric vehicles and accessories, including the R1T pickup, R1S SUV and commercial delivery vans, and offers charging, insurance, financing and software services. (Synthetic mock profile.)',
    fyEndMonth: 12, weekEnding: false, firstFY: 2022, price: 13.1, dailyVol: 0.042, drift: -0.15,
    revenue: [1.66, 4.43, 4.97, 5.40].map(v => v * B),
    grossMargin: [-1.88, -0.458, -0.242, -0.060], opMargin: [-4.13, -1.30, -0.944, -0.833], taxRate: ramp(0, 0, 4),
    rdPct: 0.55, interestExpense: ramp(0.10 * B, 0.42 * B, 4), interestIncome: ramp(0.17 * B, 0.40 * B, 4), daPct: 0.26, capexPct: 0.27, sbcPct: 0.16,
    sharesDil: ramp(0.90 * B, 1.13 * B, 4), cash: ramp(11.57 * B, 5.30 * B, 4), stInv: ramp(0.56 * B, 4.20 * B, 4), ltInv: ramp(0, 0, 4),
    stDebt: ramp(0.02 * B, 0.80 * B, 4), ltDebt: ramp(1.78 * B, 3.70 * B, 4), equity: ramp(14.0 * B, 6.0 * B, 4),
    recvPct: 0.04, invPct: 0.55, payPct: 0.22, ppePct: 0.80, goodwillPct: 0, buybackPct: ramp(0, 0, 4), divPct: ramp(0, 0, 4),
    seasonality: [0.22, 0.24, 0.26, 0.28], segments: { 'Automotive': 0.91, 'Software and Services': 0.09 },
    geo: { 'United States': 0.97, 'Canada': 0.03 },
    peers: ['TSLA', 'LCID', 'F', 'GM', 'NIO'], epsGrowthEst: 0.25, targetMult: 1.22, ratings: [3, 8, 14, 2, 1],
    execs: [['Robert J. Scaringe', 'Founder, Chief Executive Officer & Chairman', 4000000], ['Claire McDonough', 'Chief Financial Officer', 3100000], ['Jiten Behl', 'Chief Growth Officer', 2900000], ['Javier Varela', 'Chief Operations Officer', 2700000]],
  },
};

/* ==========================================================================
   §3  STATEMENT GENERATOR — annual rows plus the 8 latest completed quarters.
   Identities kept: revenue − costOfRevenue = grossProfit; operatingIncome =
   grossProfit − operatingExpenses; incomeBeforeTax = operatingIncome + (interest
   income − interest expense) [banks: = operatingIncome, interest is already in
   net revenue]; netIncome = incomeBeforeTax − incomeTaxExpense; ebitda =
   operatingIncome + D&A; freeCashFlow = operatingCashFlow + capitalExpenditure
   (capex negative); totalDebt = short + long; netDebt = totalDebt −
   cashAndShortTermInvestments; totalAssets = totalLiabilities + equity.
   ========================================================================== */
const NUM = (v, d = 0) => round(v, d);

// Per-fiscal-year inputs; i may run past the modelled range (virtual years for recent quarters).
function yearInputs(c, i) {
  const n = c.revenue.length; const j = clamp(i, 0, n - 1);
  const over = Math.max(0, i - (n - 1));
  const g = n > 1 ? c.revenue[n - 1] / c.revenue[n - 2] : 1.05;
  const scale = Math.pow(g, over);
  const pick = arr => Array.isArray(arr) ? arr[j] : arr;
  return {
    fy: c.firstFY + i, rev: c.revenue[j] * scale, gm: pick(c.grossMargin), om: pick(c.opMargin), tax: pick(c.taxRate),
    intExp: pick(c.interestExpense) * scale, intInc: pick(c.interestIncome) * scale, shares: pick(c.sharesDil) * Math.pow(0.99, over),
    cash: pick(c.cash) * scale, stInv: pick(c.stInv) * scale, ltInv: pick(c.ltInv) * scale, stDebt: pick(c.stDebt) * scale, ltDebt: pick(c.ltDebt) * scale,
    equity: pick(c.equity) * scale, buybackPct: pick(c.buybackPct), divPct: pick(c.divPct),
  };
}
function fyEndDate(c, fy, monthOffset = 0) {       // monthOffset 0 = FY end, -3 = Q3 end, ...
  let m = c.fyEndMonth + monthOffset, y = fy; while (m <= 0) { m += 12; y -= 1; }
  return c.weekEnding ? lastSaturday(y, m) : lastDayOfMonth(y, m);
}
function header(c, date, fy, period, lagDays) {
  const filing = addDays(date, lagDays);
  return { date: isoDate(date), symbol: c.symbol, reportedCurrency: 'USD', cik: c.cik, filingDate: isoDate(filing), acceptedDate: `${isoDate(filing)} 06:01:26`, fiscalYear: String(fy), period };
}

function incomeRow(c, inp, rev, hdr, jitter = 0) {
  const gm = inp.gm + jitter * 0.01, om = inp.om + jitter * 0.01;
  const cogs = rev * (1 - gm), gp = rev - cogs;
  const opInc = rev * om, opex = gp - opInc;
  let rd = rev * c.rdPct, sga = opex - rd; if (sga < 0) { rd = opex * 0.6; sga = opex * 0.4; }
  const da = rev * c.daPct, ebitda = opInc + da;
  const intExp = inp.intExp * (rev / inp.rev), intInc = inp.intInc * (rev / inp.rev);
  const nonOp = c.bank ? 0 : intInc - intExp;
  const pretax = opInc + nonOp;
  const tax = pretax > 0 ? pretax * inp.tax : 0;
  const ni = pretax - tax;
  const shares = inp.shares, basic = shares * 0.995;
  return {
    ...hdr, revenue: NUM(rev), costOfRevenue: NUM(cogs), grossProfit: NUM(gp),
    researchAndDevelopmentExpenses: NUM(rd), generalAndAdministrativeExpenses: NUM(sga), sellingAndMarketingExpenses: 0, sellingGeneralAndAdministrativeExpenses: NUM(sga), otherExpenses: 0,
    operatingExpenses: NUM(opex), costAndExpenses: NUM(cogs + opex), netInterestIncome: NUM(intInc - intExp), interestIncome: NUM(intInc), interestExpense: NUM(intExp),
    depreciationAndAmortization: NUM(da), ebitda: NUM(ebitda), ebit: NUM(pretax + intExp), nonOperatingIncomeExcludingInterest: 0, operatingIncome: NUM(opInc),
    totalOtherIncomeExpensesNet: NUM(nonOp), incomeBeforeTax: NUM(pretax), incomeTaxExpense: NUM(tax), netIncomeFromContinuingOperations: NUM(ni), netIncomeFromDiscontinuedOperations: 0,
    otherAdjustmentsToNetIncome: 0, netIncome: NUM(ni), netIncomeDeductions: 0, bottomLineNetIncome: NUM(ni),
    eps: round(ni / basic, 2), epsDiluted: round(ni / shares, 2), weightedAverageShsOut: NUM(basic), weightedAverageShsOutDil: NUM(shares),
  };
}
// Balance sheet at a point in time. `s` carries cash/debt/equity (already interpolated for quarters); rev = trailing annual revenue.
function balanceRow(c, s, rev, hdr) {
  const cashST = s.cash + s.stInv;
  const recv = rev * c.recvPct, inv = rev * c.invPct, otherCA = rev * 0.05;
  const tca = cashST + recv + inv + otherCA;
  const ppe = rev * c.ppePct, gw = rev * c.goodwillPct, taxAssets = rev * 0.02;
  let otherNCA = rev * 0.08;
  if (c.assetScale) otherNCA = Math.max(0, rev * c.assetScale - (tca + ppe + gw + s.ltInv + taxAssets));
  const pay = rev * c.payPct, otherCL = rev * (c.bank ? 0.25 : 0.08), defRev = c.bank ? 0 : rev * 0.02;
  const tcl = pay + s.stDebt + otherCL + defRev;
  let totalAssets = tca + ppe + gw + s.ltInv + taxAssets + otherNCA;
  let otherNCL = totalAssets - s.equity - tcl - s.ltDebt;
  if (otherNCL < 0) { otherNCA -= otherNCL; totalAssets -= otherNCL; otherNCL = 0; }   // plug on the asset side when liabilities already exceed the frame
  const tnca = ppe + gw + s.ltInv + taxAssets + otherNCA;
  const tncl = s.ltDebt + otherNCL, totalLiab = tcl + tncl;
  const totalDebt = s.stDebt + s.ltDebt;
  const lease = c.symbol === 'SHAK' ? s.ltDebt * 0.6 : 0;
  const commonStock = rev * 0.2, aoci = -rev * 0.01;
  return {
    ...hdr, cashAndCashEquivalents: NUM(s.cash), shortTermInvestments: NUM(s.stInv), cashAndShortTermInvestments: NUM(cashST),
    netReceivables: NUM(recv), accountsReceivables: NUM(recv * 0.6), otherReceivables: NUM(recv * 0.4), inventory: NUM(inv), prepaids: 0, otherCurrentAssets: NUM(otherCA), totalCurrentAssets: NUM(tca),
    propertyPlantEquipmentNet: NUM(ppe), goodwill: NUM(gw), intangibleAssets: 0, goodwillAndIntangibleAssets: NUM(gw), longTermInvestments: NUM(s.ltInv), taxAssets: NUM(taxAssets),
    otherNonCurrentAssets: NUM(otherNCA), totalNonCurrentAssets: NUM(tnca), otherAssets: 0, totalAssets: NUM(totalAssets),
    totalPayables: NUM(pay), accountPayables: NUM(pay), otherPayables: 0, accruedExpenses: NUM(rev * 0.02), shortTermDebt: NUM(s.stDebt), capitalLeaseObligationsCurrent: NUM(lease * 0.1), taxPayables: 0,
    deferredRevenue: NUM(defRev), otherCurrentLiabilities: NUM(otherCL), totalCurrentLiabilities: NUM(tcl),
    longTermDebt: NUM(s.ltDebt), capitalLeaseObligationsNonCurrent: NUM(lease * 0.9), deferredRevenueNonCurrent: 0, deferredTaxLiabilitiesNonCurrent: 0, otherNonCurrentLiabilities: NUM(otherNCL),
    totalNonCurrentLiabilities: NUM(tncl), otherLiabilities: 0, capitalLeaseObligations: NUM(lease), totalLiabilities: NUM(totalLiab),
    treasuryStock: 0, preferredStock: 0, commonStock: NUM(commonStock), retainedEarnings: NUM(s.equity - commonStock - aoci), additionalPaidInCapital: 0,
    accumulatedOtherComprehensiveIncomeLoss: NUM(aoci), otherTotalStockholdersEquity: 0, totalStockholdersEquity: NUM(s.equity), totalEquity: NUM(s.equity), minorityInterest: 0,
    totalLiabilitiesAndTotalEquity: NUM(totalLiab + s.equity), totalInvestments: NUM(s.stInv + s.ltInv), totalDebt: NUM(totalDebt), netDebt: NUM(totalDebt - cashST),
  };
}
// Cash flow for a period. inc = matching income row; cashBegin/cashEnd from the balance series; debtDelta = change in total debt over the period.
function cashflowRow(c, inc, rev, inp, cashBegin, cashEnd, debtDelta, hdr, frac = 1) {
  const ni = inc.netIncome, da = inc.depreciationAndAmortization;
  const sbc = rev * c.sbcPct;
  const wc = -rev * (c.bank ? -0.01 : 0.012);
  const otherNonCash = -rev * 0.002;
  const ocf = ni + da + sbc + wc + otherNonCash;
  const capex = -rev * c.capexPct;
  const fcf = ocf + capex;
  const purchases = -rev * 0.06, sales = rev * 0.05, otherInv = -rev * 0.003;
  const investing = capex + purchases + sales + otherInv;
  const buyback = -rev * inp.buybackPct, div = -rev * inp.divPct;
  const netChange = cashEnd - cashBegin;
  const financing = netChange - ocf - investing;
  const otherFin = financing - debtDelta - buyback - div;
  return {
    ...hdr, netIncome: NUM(ni), depreciationAndAmortization: NUM(da), deferredIncomeTax: 0, stockBasedCompensation: NUM(sbc), changeInWorkingCapital: NUM(wc),
    accountsReceivables: NUM(wc * 0.5), inventory: NUM(wc * 0.1), accountsPayables: NUM(wc * 0.2), otherWorkingCapital: NUM(wc * 0.2), otherNonCashItems: NUM(otherNonCash),
    netCashProvidedByOperatingActivities: NUM(ocf), investmentsInPropertyPlantAndEquipment: NUM(capex), acquisitionsNet: 0, purchasesOfInvestments: NUM(purchases), salesMaturitiesOfInvestments: NUM(sales),
    otherInvestingActivities: NUM(otherInv), netCashProvidedByInvestingActivities: NUM(investing), netDebtIssuance: NUM(debtDelta), longTermNetDebtIssuance: NUM(debtDelta * 0.8), shortTermNetDebtIssuance: NUM(debtDelta * 0.2),
    netStockIssuance: NUM(buyback), netCommonStockIssuance: NUM(buyback), commonStockIssuance: 0, commonStockRepurchased: NUM(buyback), netPreferredStockIssuance: 0,
    netDividendsPaid: NUM(div), commonDividendsPaid: NUM(div), preferredDividendsPaid: 0, otherFinancingActivities: NUM(otherFin), netCashProvidedByFinancingActivities: NUM(financing),
    effectOfForexChangesOnCash: 0, netChangeInCash: NUM(netChange), cashAtEndOfPeriod: NUM(cashEnd), cashAtBeginningOfPeriod: NUM(cashBegin),
    operatingCashFlow: NUM(ocf), capitalExpenditure: NUM(capex), freeCashFlow: NUM(fcf), incomeTaxesPaid: NUM(inc.incomeTaxExpense * 1.05 * frac), interestPaid: NUM(inc.interestExpense),
  };
}

const _stmtCache = {};
function statements(c) {
  if (_stmtCache[c.symbol]) return _stmtCache[c.symbol];
  const n = c.revenue.length;
  const incA = [], balA = [], cfA = [];
  for (let i = 0; i < n; i++) {
    const inp = yearInputs(c, i), prev = i > 0 ? yearInputs(c, i - 1) : null;
    const end = fyEndDate(c, inp.fy), hdr = header(c, end, inp.fy, 'FY', 35);
    const inc = incomeRow(c, inp, inp.rev, hdr);
    const bal = balanceRow(c, inp, inp.rev, hdr);
    const debtDelta = prev ? (inp.stDebt + inp.ltDebt) - (prev.stDebt + prev.ltDebt) : 0;
    // oldest year: no prior balance, so derive the opening cash from the flows
    let cashBegin;
    if (prev) cashBegin = prev.cash;
    else { const probe = cashflowRow(c, inc, inp.rev, inp, 0, 0, 0, hdr); cashBegin = inp.cash - (probe.operatingCashFlow + probe.netCashProvidedByInvestingActivities + probe.commonStockRepurchased + probe.netDividendsPaid); }
    cfA.push(cashflowRow(c, inc, inp.rev, inp, cashBegin, inp.cash, debtDelta, hdr));
    incA.push(inc); balA.push(bal);
  }
  // Quarters: the 8 latest fiscal quarters whose end is at least 30 days old.
  const today = todayUTC();
  const incQ = [], balQ = [], cfQ = [];
  let fy = c.firstFY + n - 1, q = 4;                   // start at the last modelled FY end and walk forward until we pass today
  while (addDays(fyEndDate(c, fy, 0), 30) <= today) fy += 1;
  // now (fy, Q4) is in the future; walk back quarter by quarter collecting 8 completed ones
  const quarters = [];
  while (quarters.length < 8) {
    const end = fyEndDate(c, fy, -3 * (4 - q));
    if (addDays(end, 30) <= today) quarters.push({ fy, q, end });
    q -= 1; if (q === 0) { q = 4; fy -= 1; }
  }
  quarters.reverse();
  const stateAt = (fy, qn) => {                        // balance-sheet state interpolated between fiscal year-ends
    const i1 = fy - c.firstFY, a = yearInputs(c, i1 - 1), b = yearInputs(c, i1), t = qn / 4;
    const mix = k => lerp(a[k], b[k], t);
    return { cash: mix('cash'), stInv: mix('stInv'), ltInv: mix('ltInv'), stDebt: mix('stDebt'), ltDebt: mix('ltDebt'), equity: mix('equity') };
  };
  const jit = rng(seedOf(c.symbol + ':q'));
  for (const { fy, q: qn, end } of quarters) {
    const i = fy - c.firstFY, inp = yearInputs(c, i), prevInp = yearInputs(c, i - 1);
    const w = c.seasonality[qn - 1];
    // quarterly revenue = annual × seasonal weight, with the year's growth phased in across the quarters
    const rev = inp.rev * w * (1 + (gauss(jit) * 0.015));
    const trailing = inp.rev * (qn / 4) + prevInp.rev * (1 - qn / 4);
    const hdr = header(c, end, fy, `Q${qn}`, 32);
    const inc = incomeRow(c, { ...inp, shares: lerp(prevInp.shares, inp.shares, qn / 4) }, rev, hdr, gauss(jit) * 0.6);
    const sNow = stateAt(fy, qn), sPrev = stateAt(fy, qn - 1);
    balQ.push(balanceRow(c, sNow, trailing, hdr));
    incQ.push(inc);
    cfQ.push(cashflowRow(c, inc, rev, { ...inp, buybackPct: inp.buybackPct, divPct: inp.divPct }, sPrev.cash, sNow.cash, (sNow.stDebt + sNow.ltDebt) - (sPrev.stDebt + sPrev.ltDebt), hdr, 0.25));
  }
  // FMP returns newest first
  const desc = arr => arr.slice().reverse();
  return (_stmtCache[c.symbol] = { incA: desc(incA), balA: desc(balA), cfA: desc(cfA), incQ: desc(incQ), balQ: desc(balQ), cfQ: desc(cfQ) });
}

/* ==========================================================================
   §4  THE REST OF THE UNIVERSE — generic companies (watchlist + peers),
   indexes, commodities, crypto, sector ETFs. Generic companies carry just
   enough to serve quote / profile / ratios-ttm / key-metrics-ttm / estimates.
   [name, exchange, sector, industry, price, dilutedShares, revenueTTM, opMargin, netMargin, growth, beta, divYield]
   ========================================================================== */
const GENERIC_ROWS = {
  MSFT: ['Microsoft Corporation', 'NASDAQ', 'Technology', 'Software - Infrastructure', 520.4, 7.43 * B, 300 * B, 0.45, 0.36, 0.14, 0.90, 0.007],
  NVDA: ['NVIDIA Corporation', 'NASDAQ', 'Technology', 'Semiconductors', 189.6, 24.4 * B, 210 * B, 0.62, 0.55, 0.45, 1.75, 0.0002],
  AMZN: ['Amazon.com, Inc.', 'NASDAQ', 'Consumer Cyclical', 'Internet Retail', 224.9, 10.7 * B, 700 * B, 0.11, 0.09, 0.11, 1.15, 0],
  GOOGL: ['Alphabet Inc.', 'NASDAQ', 'Communication Services', 'Internet Content & Information', 244.7, 12.1 * B, 400 * B, 0.33, 0.29, 0.13, 1.02, 0.003],
  META: ['Meta Platforms, Inc.', 'NASDAQ', 'Communication Services', 'Internet Content & Information', 721.3, 2.52 * B, 200 * B, 0.42, 0.37, 0.18, 1.25, 0.003],
  'BRK-B': ['Berkshire Hathaway Inc.', 'NYSE', 'Financial Services', 'Insurance - Diversified', 481.2, 2.15 * B, 380 * B, 0.13, 0.12, 0.03, 0.85, 0],
  XOM: ['Exxon Mobil Corporation', 'NYSE', 'Energy', 'Oil & Gas Integrated', 112.4, 4.30 * B, 340 * B, 0.14, 0.10, 0.00, 0.60, 0.035],
  DELL: ['Dell Technologies Inc.', 'NYSE', 'Technology', 'Computer Hardware', 134.8, 0.70 * B, 105 * B, 0.07, 0.045, 0.08, 1.05, 0.013],
  HPQ: ['HP Inc.', 'NYSE', 'Technology', 'Computer Hardware', 27.9, 0.95 * B, 54 * B, 0.07, 0.05, 0.02, 0.95, 0.041],
  SONY: ['Sony Group Corporation', 'NYSE', 'Technology', 'Consumer Electronics', 27.4, 6.10 * B, 90 * B, 0.11, 0.08, 0.05, 0.98, 0.006],
  CMG: ['Chipotle Mexican Grill, Inc.', 'NYSE', 'Consumer Cyclical', 'Restaurants', 41.6, 1.34 * B, 12.5 * B, 0.17, 0.13, 0.12, 1.10, 0],
  CAVA: ['CAVA Group, Inc.', 'NYSE', 'Consumer Cyclical', 'Restaurants', 67.8, 0.117 * B, 1.25 * B, 0.05, 0.04, 0.28, 1.60, 0],
  SG: ['Sweetgreen, Inc.', 'NYSE', 'Consumer Cyclical', 'Restaurants', 9.1, 0.118 * B, 0.72 * B, -0.12, -0.13, 0.08, 1.90, 0],
  WING: ['Wingstop Inc.', 'NASDAQ', 'Consumer Cyclical', 'Restaurants', 289.5, 0.0285 * B, 0.75 * B, 0.27, 0.17, 0.20, 1.20, 0.004],
  DPZ: ['Domino\'s Pizza, Inc.', 'NASDAQ', 'Consumer Cyclical', 'Restaurants', 431.2, 0.0345 * B, 4.9 * B, 0.19, 0.13, 0.05, 0.80, 0.014],
  BAC: ['Bank of America Corporation', 'NYSE', 'Financial Services', 'Banks - Diversified', 48.3, 7.60 * B, 108 * B, 0.33, 0.27, 0.05, 1.15, 0.022],
  WFC: ['Wells Fargo & Company', 'NYSE', 'Financial Services', 'Banks - Diversified', 78.1, 3.30 * B, 85 * B, 0.30, 0.24, 0.03, 1.10, 0.021],
  C: ['Citigroup Inc.', 'NYSE', 'Financial Services', 'Banks - Diversified', 94.7, 1.87 * B, 84 * B, 0.22, 0.17, 0.04, 1.30, 0.024],
  GS: ['The Goldman Sachs Group, Inc.', 'NYSE', 'Financial Services', 'Capital Markets', 742.0, 0.32 * B, 58 * B, 0.35, 0.27, 0.08, 1.35, 0.016],
  MS: ['Morgan Stanley', 'NYSE', 'Financial Services', 'Capital Markets', 149.8, 1.60 * B, 66 * B, 0.28, 0.21, 0.07, 1.30, 0.025],
  TSLA: ['Tesla, Inc.', 'NASDAQ', 'Consumer Cyclical', 'Auto - Manufacturers', 409.5, 3.50 * B, 95 * B, 0.06, 0.06, 0.02, 2.05, 0],
  LCID: ['Lucid Group, Inc.', 'NASDAQ', 'Consumer Cyclical', 'Auto - Manufacturers', 2.41, 3.10 * B, 1.2 * B, -2.30, -2.40, 0.35, 1.30, 0],
  F: ['Ford Motor Company', 'NYSE', 'Consumer Cyclical', 'Auto - Manufacturers', 11.6, 4.00 * B, 185 * B, 0.03, 0.025, 0.02, 1.45, 0.052],
  GM: ['General Motors Company', 'NYSE', 'Consumer Cyclical', 'Auto - Manufacturers', 58.2, 1.00 * B, 185 * B, 0.07, 0.05, 0.01, 1.35, 0.010],
  NIO: ['NIO Inc.', 'NYSE', 'Consumer Cyclical', 'Auto - Manufacturers', 6.48, 2.30 * B, 10 * B, -0.30, -0.32, 0.25, 1.70, 0],
};
const GENERICS = Object.fromEntries(Object.entries(GENERIC_ROWS).map(([symbol, r]) => [symbol, { symbol, name: r[0], exchange: r[1], sector: r[2], industry: r[3], price: r[4], shares: r[5], revenue: r[6], opMargin: r[7], netMargin: r[8], growth: r[9], beta: r[10], divYield: r[11] }]));

// [name, price, dailyVol, annual drift, exchange, base volume, marketCap (ETFs)]
const INSTRUMENT_ROWS = {
  '^GSPC': ['S&P 500', 6650.2, 0.010, 0.11, 'INDEX', 2.6 * B], '^IXIC': ['NASDAQ Composite', 22410.5, 0.013, 0.14, 'INDEX', 6.1 * B],
  '^DJI': ['Dow Jones Industrial Average', 46480.3, 0.009, 0.08, 'INDEX', 350 * M], '^RUT': ['Russell 2000', 2438.7, 0.014, 0.06, 'INDEX', 1.9 * B],
  '^VIX': ['CBOE Volatility Index', 16.45, 0.065, 0.00, 'INDEX', 0],
  CLUSD: ['Crude Oil', 62.48, 0.022, -0.05, 'COMMODITY', 280000], BZUSD: ['Brent Crude Oil', 66.21, 0.021, -0.05, 'COMMODITY', 190000],
  GCUSD: ['Gold Futures', 3851.6, 0.011, 0.18, 'COMMODITY', 210000], SIUSD: ['Silver Futures', 47.18, 0.019, 0.20, 'COMMODITY', 85000],
  HGUSD: ['Copper', 4.852, 0.016, 0.09, 'COMMODITY', 60000], NGUSD: ['Natural Gas', 3.347, 0.035, 0.02, 'COMMODITY', 150000],
  DXUSD: ['US Dollar', 97.84, 0.004, -0.03, 'COMMODITY', 25000],
  BTCUSD: ['Bitcoin USD', 118520, 0.034, 0.45, 'CRYPTO', 32 * B], ETHUSD: ['Ethereum USD', 4352.4, 0.042, 0.35, 'CRYPTO', 18 * B],
  XLK: ['Technology Select Sector SPDR Fund', 264.8, 0.014, 0.18, 'AMEX', 6 * M, 82 * B], XLF: ['Financial Select Sector SPDR Fund', 54.1, 0.011, 0.12, 'AMEX', 35 * M, 52 * B],
  XLV: ['Health Care Select Sector SPDR Fund', 138.4, 0.009, 0.04, 'AMEX', 9 * M, 36 * B], XLY: ['Consumer Discretionary Select Sector SPDR Fund', 229.6, 0.013, 0.10, 'AMEX', 5 * M, 22 * B],
  XLP: ['Consumer Staples Select Sector SPDR Fund', 78.2, 0.007, 0.03, 'AMEX', 11 * M, 16 * B], XLE: ['Energy Select Sector SPDR Fund', 88.3, 0.014, 0.01, 'AMEX', 14 * M, 33 * B],
  XLI: ['Industrial Select Sector SPDR Fund', 151.7, 0.010, 0.11, 'AMEX', 9 * M, 23 * B], XLB: ['Materials Select Sector SPDR Fund', 91.9, 0.011, 0.05, 'AMEX', 6 * M, 5.5 * B],
  XLU: ['Utilities Select Sector SPDR Fund', 85.4, 0.009, 0.07, 'AMEX', 10 * M, 20 * B], XLRE: ['Real Estate Select Sector SPDR Fund', 41.6, 0.010, 0.02, 'AMEX', 6 * M, 7.5 * B],
  XLC: ['Communication Services Select Sector SPDR Fund', 110.2, 0.011, 0.14, 'AMEX', 5 * M, 24 * B],
};
// Instrument registry: everything that has a quote. kind: company | generic | index | commodity | crypto | etf
const INSTRUMENTS = {};
for (const c of Object.values(COMPANIES)) INSTRUMENTS[c.symbol] = { symbol: c.symbol, kind: 'company', name: c.name, price: c.price, dailyVol: c.dailyVol, drift: c.drift, exchange: c.exchange, shares: c.sharesDil[c.sharesDil.length - 1], baseVolume: Math.round(c.sharesDil[c.sharesDil.length - 1] * 0.006), co: c };
for (const g of Object.values(GENERICS)) INSTRUMENTS[g.symbol] = { symbol: g.symbol, kind: 'generic', name: g.name, price: g.price, dailyVol: 0.013 + 0.01 * g.beta, drift: 0.08 + g.growth, exchange: g.exchange, shares: g.shares, baseVolume: Math.round(g.shares * 0.007), co: g };
for (const [symbol, r] of Object.entries(INSTRUMENT_ROWS)) INSTRUMENTS[symbol] = { symbol, kind: r[4] === 'INDEX' ? 'index' : r[4] === 'COMMODITY' ? 'commodity' : r[4] === 'CRYPTO' ? 'crypto' : 'etf', name: r[0], price: r[1], dailyVol: r[2], drift: r[3], exchange: r[4], baseVolume: r[5], marketCap: r[6] || null };

const FREE_SYMBOLS = new Set([
  'AAPL', 'JPM', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'XOM',          // the subset of FMP's 87-ticker sample list this mock knows
  '^GSPC', '^DJI', '^IXIC', '^RUT', '^VIX', 'BZUSD', 'SIUSD', 'GCUSD', 'BTCUSD', 'ETHUSD',  // FMP's documented sample indexes / commodities / crypto
]);
const symbolAllowed = sym => PLAN !== 'free' || FREE_SYMBOLS.has(sym);
const company = sym => COMPANIES[sym] || null;          // fully modelled
const anyCo = sym => COMPANIES[sym] || GENERICS[sym] || null;

/* ==========================================================================
   §5  PRICES — deterministic random-walk history, quotes, intraday bars
   ========================================================================== */
const HISTORY_YEARS = 11;
const _hist = {};
function history(sym) {                                      // ascending array of daily bars, ~11 years of weekdays
  if (_hist[sym]) return _hist[sym];
  const inst = INSTRUMENTS[sym]; if (!inst) return null;
  const r = rng(seedOf('hist:' + sym));
  const end = latestWeekday();
  const days = [];
  for (let d = addDays(end, -Math.round(HISTORY_YEARS * 365.25)); d <= end; d = addDays(d, 1)) if (!isWeekend(d) || inst.kind === 'crypto') days.push(d);
  const N = days.length;
  const cum = [0]; for (let i = 1; i < N; i++) cum.push(cum[i - 1] + gauss(r) * inst.dailyVol);
  const start = inst.price / Math.exp(inst.drift * HISTORY_YEARS);
  const target = Math.log(inst.price / start);
  const closes = cum.map((c, i) => start * Math.exp(c + (target - cum[N - 1]) * (i / (N - 1))));   // Brownian bridge so the series ends exactly at today's price
  const dec = inst.price >= 1000 ? 2 : inst.price >= 10 ? 2 : 4;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const close = closes[i], prev = i ? closes[i - 1] : close * (1 - gauss(r) * inst.dailyVol);
    const open = prev * (1 + gauss(r) * inst.dailyVol * 0.3);
    const hi = Math.max(open, close) * (1 + Math.abs(gauss(r)) * inst.dailyVol * 0.5), lo = Math.min(open, close) * (1 - Math.abs(gauss(r)) * inst.dailyVol * 0.5);
    const volume = Math.round(inst.baseVolume * (0.55 + 0.9 * r()));
    rows.push({ date: isoDate(days[i]), open: round(open, dec), high: round(hi, dec), low: round(lo, dec), close: round(close, dec), volume, vwap: round((hi + lo + close) / 3, dec), change: round(close - open, dec), changePercent: round((close / open - 1) * 100, 5) });
  }
  return (_hist[sym] = rows);
}
function closeOn(sym, dateIso) {                              // last close on or before a date
  const h = history(sym); if (!h) return null;
  let best = null; for (const row of h) { if (row.date <= dateIso) best = row; else break; }
  return best ? best.close : h[0].close;
}
function etOffsetHours() {                                    // -4 (EDT) or -5 (EST) right now
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value;
  const m = s.match(/GMT([+-]\d+)/); return m ? Number(m[1]) : -4;
}
function lastCloseTimestamp() {                               // unix seconds of the last 4 pm ET close (or now, while open)
  if (isNyseOpenNow()) return unixNow();
  const t = nowET(); let d = utc(t.y, t.m, t.d);
  if (!isWeekend(d) && t.hh * 60 + t.mm < 960) d = addDays(d, -1);
  d = latestWeekday(d);
  return Math.floor((d.getTime() + (16 - etOffsetHours()) * 3600e3) / 1000);
}
// FMP `quote` row (17 fields, verbatim names; `changePercentage`, not `changesPercentage`)
function quoteRow(sym) {
  const inst = INSTRUMENTS[sym]; if (!inst) return null;
  const h = history(sym); const last = h[h.length - 1], prev = h[h.length - 2];
  const year = h.slice(-252);
  const avg = n => round(sum(h.slice(-n).map(x => x.close)) / Math.min(n, h.length), 4);
  const marketCap = inst.shares ? r0(inst.price * inst.shares) : (inst.marketCap || null);
  return {
    symbol: sym, name: inst.name, price: inst.price, changePercentage: round((inst.price / prev.close - 1) * 100, 4), change: round(inst.price - prev.close, 4),
    volume: last.volume, dayLow: last.low, dayHigh: last.high, yearHigh: Math.max(...year.map(x => x.high)), yearLow: Math.min(...year.map(x => x.low)),
    marketCap, priceAvg50: avg(50), priceAvg200: avg(200), exchange: inst.exchange, open: last.open, previousClose: prev.close, timestamp: lastCloseTimestamp(),
  };
}
// 5-minute bars for the latest weekday (plus the previous one so a `from` of a few days back still returns something)
function intraday5min(sym, from, to) {
  const inst = INSTRUMENTS[sym]; if (!inst) return [];
  const h = history(sym); const days = h.slice(-2);
  const out = [];
  for (const day of days) {
    const r = rng(seedOf('5m:' + sym + day.date));
    let px = day.open;
    const n = 78;                                               // 09:30 → 16:00
    for (let i = 0; i < n; i++) {
      const mins = 9 * 60 + 30 + i * 5; const hh = Math.floor(mins / 60), mm = mins % 60;
      const target = day.open + (day.close - day.open) * (i / (n - 1));
      const open = px; const close = i === n - 1 ? day.close : target + gauss(r) * inst.dailyVol * 0.25 * day.open;
      const hi = Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.001), lo = Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.001);
      out.push({ date: `${day.date} ${pad(hh)}:${pad(mm)}:00`, open: round(open, 4), low: round(lo, 4), high: round(hi, 4), close: round(close, 4), volume: Math.round(day.volume / n * (0.5 + r())) });
      px = close;
    }
  }
  return out.filter(b => inRange(b.date.slice(0, 10), from, to)).reverse();
}

/* ==========================================================================
   §6  FMP — company-level endpoints
   ========================================================================== */
const div = (a, b) => (b && Number.isFinite(a / b)) ? round(a / b, 4) : 0;   // FMP prints 0 where a ratio is undefined

// A financial snapshot (TTM or one fiscal year) that key-metrics / ratios are computed from.
function snapshotFromRows(inc, bal, cf, price, shares, sym) {
  const cashST = bal.cashAndShortTermInvestments, totalDebt = bal.totalDebt;
  const mcap = price * shares;
  return {
    symbol: sym, price, shares, marketCap: mcap, revenue: inc.revenue, cogs: inc.costOfRevenue, grossProfit: inc.grossProfit, opInc: inc.operatingIncome, ebitda: inc.ebitda, ebit: inc.ebit, pretax: inc.incomeBeforeTax, tax: inc.incomeTaxExpense,
    netIncome: inc.netIncome, da: inc.depreciationAndAmortization, intExp: inc.interestExpense, sga: inc.sellingGeneralAndAdministrativeExpenses, rd: inc.researchAndDevelopmentExpenses, sbc: cf.stockBasedCompensation,
    ocf: cf.operatingCashFlow, capex: cf.capitalExpenditure, fcf: cf.freeCashFlow, dividends: -cf.netDividendsPaid, buybacks: -cf.commonStockRepurchased, netDebtIssuance: cf.netDebtIssuance,
    cash: bal.cashAndCashEquivalents, cashST, totalDebt, ltDebt: bal.longTermDebt, equity: bal.totalStockholdersEquity, totalAssets: bal.totalAssets, totalLiabilities: bal.totalLiabilities,
    tca: bal.totalCurrentAssets, tcl: bal.totalCurrentLiabilities, inventory: bal.inventory, receivables: bal.netReceivables, payables: bal.accountPayables, goodwill: bal.goodwillAndIntangibleAssets, ppe: bal.propertyPlantEquipmentNet,
  };
}
function sumRows(rows, keys) { const o = {}; for (const k of keys) o[k] = sum(rows.map(r => r[k] || 0)); return o; }
const INC_KEYS = ['revenue', 'costOfRevenue', 'grossProfit', 'operatingIncome', 'ebitda', 'ebit', 'incomeBeforeTax', 'incomeTaxExpense', 'netIncome', 'depreciationAndAmortization', 'interestExpense', 'sellingGeneralAndAdministrativeExpenses', 'researchAndDevelopmentExpenses'];
const CF_KEYS = ['stockBasedCompensation', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow', 'netDividendsPaid', 'commonStockRepurchased', 'netDebtIssuance'];

function ttmSnapshot(sym) {
  const c = company(sym);
  if (c) {
    const s = statements(c); const inc = sumRows(s.incQ.slice(0, 4), INC_KEYS), cf = sumRows(s.cfQ.slice(0, 4), CF_KEYS);
    return snapshotFromRows(inc, s.balQ[0], cf, c.price, s.incQ[0].weightedAverageShsOutDil, sym);
  }
  const g = GENERICS[sym]; if (!g) return null;
  const fin = /Financial/.test(g.sector);
  const rev = g.revenue, ni = rev * g.netMargin, op = rev * g.opMargin, da = rev * 0.04, debt = rev * (fin ? 3 : 0.3), cashST = rev * (fin ? 2.5 : 0.15);
  const inc = { revenue: rev, costOfRevenue: rev * 0.55, grossProfit: rev * 0.45, operatingIncome: op, ebitda: op + da, ebit: op, incomeBeforeTax: ni / 0.82, incomeTaxExpense: ni > 0 ? ni / 0.82 * 0.18 : 0, netIncome: ni, depreciationAndAmortization: da, interestExpense: debt * 0.045, sellingGeneralAndAdministrativeExpenses: rev * 0.12, researchAndDevelopmentExpenses: rev * 0.08 };
  const ocf = ni > 0 ? ni * 1.25 : ni * 0.7, capex = -rev * (fin ? 0.005 : 0.045);
  const cf = { stockBasedCompensation: rev * 0.02, operatingCashFlow: ocf, capitalExpenditure: capex, freeCashFlow: ocf + capex, netDividendsPaid: -g.price * g.shares * g.divYield, commonStockRepurchased: -(ni > 0 ? ni * 0.3 : 0), netDebtIssuance: 0 };
  const eq = rev * (fin ? 1.5 : 0.45), ta = rev * (fin ? 20 : 1.2);
  const bal = { cashAndShortTermInvestments: cashST, cashAndCashEquivalents: cashST * 0.6, totalDebt: debt, longTermDebt: debt * 0.8, totalStockholdersEquity: eq, totalAssets: ta, totalLiabilities: ta - eq, totalCurrentAssets: rev * 0.3 + cashST, totalCurrentLiabilities: rev * 0.25, inventory: rev * 0.05, netReceivables: rev * 0.1, accountPayables: rev * 0.08, goodwillAndIntangibleAssets: rev * 0.1, propertyPlantEquipmentNet: rev * 0.3 };
  return snapshotFromRows(inc, bal, cf, g.price, g.shares, sym);
}
function annualSnapshot(c, i) {                         // i = index into the newest-first annual arrays
  const s = statements(c); const inc = s.incA[i], bal = s.balA[i], cf = s.cfA[i];
  return snapshotFromRows(inc, bal, cf, closeOn(c.symbol, inc.date), inc.weightedAverageShsOutDil, c.symbol);
}
function keyMetricsFrom(t) {
  const ev = t.marketCap + t.totalDebt - t.cashST, wc = t.tca - t.tcl, ic = t.totalDebt + t.equity - t.cashST, tangible = t.totalAssets - t.goodwill - t.totalLiabilities;
  const eps = t.netIncome / t.shares, bvps = t.equity / t.shares;
  return {
    marketCap: r0(t.marketCap), enterpriseValue: r0(ev), evToSales: div(ev, t.revenue), evToOperatingCashFlow: div(ev, t.ocf), evToFreeCashFlow: div(ev, t.fcf), evToEBITDA: div(ev, t.ebitda), netDebtToEBITDA: div(t.totalDebt - t.cashST, t.ebitda),
    currentRatio: div(t.tca, t.tcl), incomeQuality: div(t.ocf, t.netIncome), grahamNumber: eps > 0 && bvps > 0 ? round(Math.sqrt(22.5 * eps * bvps), 4) : 0, grahamNetNet: round((t.tca - t.totalLiabilities) / t.shares, 4),
    taxBurden: div(t.netIncome, t.pretax), interestBurden: div(t.pretax, t.ebit), workingCapital: r0(wc), investedCapital: r0(ic), returnOnAssets: div(t.netIncome, t.totalAssets), operatingReturnOnAssets: div(t.opInc, t.totalAssets),
    returnOnTangibleAssets: div(t.netIncome, t.totalAssets - t.goodwill), returnOnEquity: div(t.netIncome, t.equity), returnOnInvestedCapital: div(t.opInc * (1 - 0.21), ic), returnOnCapitalEmployed: div(t.opInc, t.totalAssets - t.tcl),
    earningsYield: div(t.netIncome, t.marketCap), freeCashFlowYield: div(t.fcf, t.marketCap), capexToOperatingCashFlow: div(-t.capex, t.ocf), capexToDepreciation: div(-t.capex, t.da), capexToRevenue: div(-t.capex, t.revenue),
    salesGeneralAndAdministrativeToRevenue: div(t.sga, t.revenue), researchAndDevelopementToRevenue: div(t.rd, t.revenue), stockBasedCompensationToRevenue: div(t.sbc, t.revenue), intangiblesToTotalAssets: div(t.goodwill, t.totalAssets),
    averageReceivables: r0(t.receivables), averagePayables: r0(t.payables), averageInventory: r0(t.inventory), daysOfSalesOutstanding: div(t.receivables * 365, t.revenue), daysOfPayablesOutstanding: div(t.payables * 365, t.cogs), daysOfInventoryOutstanding: div(t.inventory * 365, t.cogs),
    operatingCycle: div(t.receivables * 365, t.revenue) + div(t.inventory * 365, t.cogs), cashConversionCycle: round(div(t.receivables * 365, t.revenue) + div(t.inventory * 365, t.cogs) - div(t.payables * 365, t.cogs), 4),
    freeCashFlowToEquity: r0(t.fcf + t.netDebtIssuance), freeCashFlowToFirm: r0(t.fcf + t.intExp * (1 - 0.21)), tangibleAssetValue: r0(tangible), netCurrentAssetValue: r0(t.tca - t.totalLiabilities),
  };
}
function ratiosFrom(t) {
  const ev = t.marketCap + t.totalDebt - t.cashST, eps = t.netIncome / t.shares, g = 0.08;
  const pe = div(t.price, eps);
  return {
    grossProfitMargin: div(t.grossProfit, t.revenue), ebitMargin: div(t.ebit, t.revenue), ebitdaMargin: div(t.ebitda, t.revenue), operatingProfitMargin: div(t.opInc, t.revenue), pretaxProfitMargin: div(t.pretax, t.revenue),
    continuousOperationsProfitMargin: div(t.netIncome, t.revenue), netProfitMargin: div(t.netIncome, t.revenue), bottomLineProfitMargin: div(t.netIncome, t.revenue),
    receivablesTurnover: div(t.revenue, t.receivables), payablesTurnover: div(t.cogs, t.payables), inventoryTurnover: div(t.cogs, t.inventory), fixedAssetTurnover: div(t.revenue, t.ppe), assetTurnover: div(t.revenue, t.totalAssets),
    currentRatio: div(t.tca, t.tcl), quickRatio: div(t.tca - t.inventory, t.tcl), solvencyRatio: div(t.netIncome + t.da, t.totalLiabilities), cashRatio: div(t.cash, t.tcl),
    priceToEarningsRatio: pe, priceToEarningsGrowthRatio: div(pe, g * 100), forwardPriceToEarningsGrowthRatio: div(pe, g * 100), priceToEarningsDilutedRatio: pe, priceToEarningsDilutedGrowthRatio: div(pe, g * 100),
    priceToBookRatio: div(t.marketCap, t.equity), priceToSalesRatio: div(t.marketCap, t.revenue), priceToFreeCashFlowRatio: div(t.marketCap, t.fcf), priceToOperatingCashFlowRatio: div(t.marketCap, t.ocf),
    debtToAssetsRatio: div(t.totalDebt, t.totalAssets), debtToEquityRatio: div(t.totalDebt, t.equity), debtToCapitalRatio: div(t.totalDebt, t.totalDebt + t.equity), longTermDebtToCapitalRatio: div(t.ltDebt, t.ltDebt + t.equity), financialLeverageRatio: div(t.totalAssets, t.equity),
    workingCapitalTurnoverRatio: div(t.revenue, t.tca - t.tcl), operatingCashFlowRatio: div(t.ocf, t.tcl), operatingCashFlowSalesRatio: div(t.ocf, t.revenue), freeCashFlowOperatingCashFlowRatio: div(t.fcf, t.ocf),
    debtServiceCoverageRatio: div(t.opInc, t.intExp + t.totalDebt * 0.1), interestCoverageRatio: div(t.opInc, t.intExp), shortTermOperatingCashFlowCoverageRatio: div(t.ocf, t.totalDebt - t.ltDebt), operatingCashFlowCoverageRatio: div(t.ocf, t.totalDebt),
    capitalExpenditureCoverageRatio: div(t.ocf, -t.capex), dividendPaidAndCapexCoverageRatio: div(t.ocf, -t.capex + t.dividends), dividendPayoutRatio: div(t.dividends, t.netIncome), dividendYield: div(t.dividends, t.marketCap),
    enterpriseValue: r0(ev), revenuePerShare: div(t.revenue, t.shares), netIncomePerShare: div(t.netIncome, t.shares), interestDebtPerShare: div(t.totalDebt, t.shares), cashPerShare: div(t.cashST, t.shares),
    bookValuePerShare: div(t.equity, t.shares), tangibleBookValuePerShare: div(t.equity - t.goodwill, t.shares), shareholdersEquityPerShare: div(t.equity, t.shares), operatingCashFlowPerShare: div(t.ocf, t.shares),
    capexPerShare: div(-t.capex, t.shares), freeCashFlowPerShare: div(t.fcf, t.shares), netIncomePerEBT: div(t.netIncome, t.pretax), ebtPerEbit: div(t.pretax, t.ebit), priceToFairValue: div(t.marketCap, t.equity),
    debtToMarketCap: div(t.totalDebt, t.marketCap), effectiveTaxRate: div(t.tax, t.pretax), enterpriseValueMultiple: div(ev, t.ebitda), dividendPerShare: div(t.dividends, t.shares),
  };
}
const suffixed = (obj, suffix, except = []) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [except.includes(k) ? k : k + suffix, v]));

// ---- endpoint builders (each returns the array FMP would) ----
const FMP_CO = {
  profile(sym) {
    const inst = INSTRUMENTS[sym], co = anyCo(sym); if (!inst || !co) return [];
    const q = quoteRow(sym); const c = COMPANIES[sym];
    return [{
      symbol: sym, price: q.price, marketCap: q.marketCap, beta: co.beta, lastDividend: c ? c.lastDividend : round(co.price * co.divYield, 2), range: `${q.yearLow}-${q.yearHigh}`, change: q.change, changePercentage: q.changePercentage, volume: q.volume,
      averageVolume: r0(inst.baseVolume), companyName: co.name, currency: 'USD', cik: c ? c.cik : '0001000000', isin: c ? c.isin : 'US0000000000', cusip: c ? c.cusip : '000000000',
      exchangeFullName: c ? c.exchangeFullName : (co.exchange === 'NASDAQ' ? 'NASDAQ Global Select' : 'New York Stock Exchange'), exchange: co.exchange, industry: co.industry, website: c ? c.website : `https://www.${sym.toLowerCase().replace('-', '')}.com`,
      description: c ? c.description : `${co.name} operates in the ${co.industry.toLowerCase()} industry. (Synthetic mock profile; no description on file.)`, ceo: c ? c.ceo : 'Jane Doe', sector: co.sector, country: sym === 'SONY' || sym === 'NIO' ? (sym === 'SONY' ? 'JP' : 'CN') : 'US',
      fullTimeEmployees: String(c ? c.employees : r0(co.revenue / 450000)), phone: c ? c.phone : '(555) 010-0100', address: c ? c.address : '1 Main Street', city: c ? c.city : 'New York', state: c ? c.state : 'NY', zip: c ? c.zip : '10001',
      image: `https://images.financialmodelingprep.com/symbol/${sym}.png`, ipoDate: c ? c.ipoDate : '1990-01-01', defaultImage: false, isEtf: false, isActivelyTrading: true, isAdr: sym === 'SONY' || sym === 'NIO', isFund: false,
    }];
  },
  sharesFloat(sym) { const inst = INSTRUMENTS[sym]; if (!inst || !inst.shares) return []; const out = r0(inst.shares * 0.99); return [{ symbol: sym, date: `${isoDate(latestWeekday())} 15:48:00`, freeFloat: 99.1, floatShares: r0(out * 0.991), outstandingShares: out, source: 'https://www.sec.gov/' }]; },
  keyMetricsTTM(sym) { const t = ttmSnapshot(sym); return t ? [{ symbol: sym, ...suffixed(keyMetricsFrom(t), 'TTM', ['marketCap']) }] : []; },
  ratiosTTM(sym) { const t = ttmSnapshot(sym); return t ? [{ symbol: sym, ...suffixed(ratiosFrom(t), 'TTM') }] : []; },
  keyMetrics(sym, period, limit) { const c = company(sym); if (!c) return []; const s = statements(c); return (period === 'quarter' ? [] : s.incA).slice(0, limit).map((inc, i) => ({ symbol: sym, date: inc.date, fiscalYear: inc.fiscalYear, period: inc.period, reportedCurrency: 'USD', ...keyMetricsFrom(annualSnapshot(c, i)) })); },
  ratios(sym, period, limit) { const c = company(sym); if (!c) return []; const s = statements(c); return (period === 'quarter' ? [] : s.incA).slice(0, limit).map((inc, i) => { const r = ratiosFrom(annualSnapshot(c, i)); return { symbol: sym, date: inc.date, fiscalYear: inc.fiscalYear, period: inc.period, reportedCurrency: 'USD', ...r, dividendYieldPercentage: round(r.dividendYield * 100, 4) }; }); },
  enterpriseValues(sym, limit) { const c = company(sym); if (!c) return []; const s = statements(c); return s.incA.slice(0, limit).map((inc, i) => { const t = annualSnapshot(c, i); return { symbol: sym, date: inc.date, stockPrice: t.price, numberOfShares: r0(t.shares), marketCapitalization: r0(t.marketCap), minusCashAndCashEquivalents: r0(t.cash), addTotalDebt: r0(t.totalDebt), enterpriseValue: r0(t.marketCap + t.totalDebt - t.cash) }; }); },
  statement(sym, kind, period, limit) {
    const c = company(sym); if (!c) return [];
    const s = statements(c); const q = period === 'quarter' || /^Q[1-4]$/.test(period || '');
    let rows = { income: q ? s.incQ : s.incA, balance: q ? s.balQ : s.balA, cashflow: q ? s.cfQ : s.cfA }[kind];
    if (/^Q[1-4]$/.test(period || '')) rows = rows.filter(r => r.period === period);
    return rows.slice(0, limit);
  },
  executives(sym) { const c = company(sym); if (!c) return []; return c.execs.map(([name, title, pay]) => ({ title, name, pay, currencyPay: 'USD', gender: /Katherine|Claire|Deirdre|Mary|Marianne|Stephanie|Steph /.test(name) ? 'female' : 'male', yearBorn: null, titleSince: null, active: true })); },
  employeeCount(sym, limit) {
    const c = company(sym); if (!c) return [];
    return statements(c).incA.slice(0, limit).map((inc, i) => ({ symbol: sym, cik: c.cik, acceptanceTime: inc.acceptedDate, periodOfReport: inc.date, companyName: c.name, formType: '10-K', filingDate: inc.filingDate, employeeCount: r0(c.employees * Math.pow(0.97, i)), source: 'https://www.sec.gov/' }));
  },
  segmentation(sym, which, period) {
    const c = company(sym); if (!c) return [];
    const s = statements(c); const rows = period === 'quarter' ? s.incQ : s.incA; const weights = which === 'geo' ? c.geo : c.segments;
    return rows.slice(0, 10).map(inc => ({ symbol: sym, fiscalYear: Number(inc.fiscalYear), period: inc.period, reportedCurrency: 'USD', date: inc.date, data: Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, r0(inc.revenue * w)])) }));
  },
  peers(sym) { const c = company(sym); const list = c ? c.peers : (GENERICS[sym] ? Object.keys(GENERICS).filter(s => s !== sym && GENERICS[s].industry === GENERICS[sym].industry).slice(0, 5) : []); return list.map(p => { const q = quoteRow(p); return { symbol: p, companyName: INSTRUMENTS[p].name, price: q.price, mktCap: q.marketCap }; }); },
  analystEstimates(sym, period, limit) {
    const co = anyCo(sym); if (!co) return [];
    const c = company(sym); const t = ttmSnapshot(sym); const r = rng(seedOf('est:' + sym));
    const lastFY = c ? c.firstFY + c.revenue.length - 1 : new Date().getUTCFullYear() - 1;
    const g = c ? Math.min(0.35, Math.max(-0.05, t.revenue / statements(c).incA[1].revenue - 1)) : co.growth;
    const epsG = c ? c.epsGrowthEst : co.growth + 0.03;
    const rows = [];
    for (let k = 4; k >= -3; k--) {                                 // FY+4 … FY-3, descending by date
      const fy = lastFY + k; const scale = Math.pow(1 + g * 0.9, k); const es = Math.pow(1 + epsG, k);
      const rev = t.revenue * scale, ebitda = t.ebitda * scale, ebit = t.opInc * scale, ni = t.netIncome * es, eps = ni / t.shares, sga = t.sga * scale;
      const date = isoDate(c ? fyEndDate(c, fy) : utc(fy, 12, 31)); const spread = 0.06 + 0.02 * Math.abs(k);
      const lo = v => r0(v * (1 - spread)), hi = v => r0(v * (1 + spread));
      rows.push({ symbol: sym, date, revenueLow: lo(rev), revenueHigh: hi(rev), revenueAvg: r0(rev), ebitdaLow: lo(ebitda), ebitdaHigh: hi(ebitda), ebitdaAvg: r0(ebitda), ebitLow: lo(ebit), ebitHigh: hi(ebit), ebitAvg: r0(ebit), netIncomeLow: lo(ni), netIncomeHigh: hi(ni), netIncomeAvg: r0(ni), sgaExpenseLow: lo(sga), sgaExpenseHigh: hi(sga), sgaExpenseAvg: r0(sga), epsAvg: round(eps, 3), epsHigh: round(eps * (1 + spread), 5), epsLow: round(eps * (1 - spread), 5), numAnalystsRevenue: 8 + Math.floor(r() * 20), numAnalystsEps: 6 + Math.floor(r() * 18) });
    }
    return (period === 'quarter' ? [] : rows).slice(0, limit);
  },
  priceTargetSummary(sym) { const co = anyCo(sym); if (!co) return []; const p = co.price, m = company(sym) ? company(sym).targetMult : 1.1; return [{ symbol: sym, lastMonthCount: 6, lastMonthAvgPriceTarget: round(p * m, 2), lastQuarterCount: 18, lastQuarterAvgPriceTarget: round(p * m * 0.99, 2), lastYearCount: 55, lastYearAvgPriceTarget: round(p * m * 0.93, 2), allTimeCount: 240, allTimeAvgPriceTarget: round(p * 0.72, 2), publishers: JSON.stringify(['StreetInsider', 'TheFly', 'Benzinga', 'MarketBeat']) }]; },
  priceTargetConsensus(sym) { const co = anyCo(sym); if (!co) return []; const p = co.price, m = company(sym) ? company(sym).targetMult : 1.1; return [{ symbol: sym, targetHigh: round(p * m * 1.25, 0), targetLow: round(p * m * 0.78, 0), targetConsensus: round(p * m, 2), targetMedian: round(p * m * 1.01, 0) }]; },
  gradesConsensus(sym) { const co = anyCo(sym); if (!co) return []; const g = company(sym) ? company(sym).ratings : [3, 12, 9, 2, 1]; const [strongBuy, buy, hold, sell, strongSell] = g; return [{ symbol: sym, strongBuy, buy, hold, sell, strongSell, consensus: (strongBuy + buy) > (hold + sell + strongSell) ? 'Buy' : hold >= (sell + strongSell) ? 'Hold' : 'Sell' }]; },
  // Upcoming rows first with null actuals, then reported quarters, descending by date.
  earnings(sym, limit) {
    const c = company(sym); if (!c) return [];
    const s = statements(c); const r = rng(seedOf('earn:' + sym)); const rows = [];
    const reportDate = inc => addDays(utc(...inc.date.split('-').map(Number)), 30);
    // next two quarters (not yet reported)
    let fy = Number(s.incQ[0].fiscalYear), qn = Number(s.incQ[0].period.slice(1));
    const last4 = s.incQ.slice(0, 4);
    for (let k = 0; k < 2; k++) {
      qn += 1; if (qn === 5) { qn = 1; fy += 1; }
      const end = fyEndDate(c, fy, -3 * (4 - qn)); const like = last4.find(x => x.period === `Q${qn}`) || s.incQ[0];
      rows.push({ symbol: sym, date: isoDate(addDays(end, 30)), epsActual: null, epsEstimated: round(like.epsDiluted * 1.08, 2), revenueActual: null, revenueEstimated: r0(like.revenue * 1.07), lastUpdated: isoDate(todayUTC()) });
    }
    for (const inc of s.incQ) { const est = inc.epsDiluted * (1 - 0.03 - gauss(r) * 0.05); rows.push({ symbol: sym, date: isoDate(reportDate(inc)), epsActual: inc.epsDiluted, epsEstimated: round(est, 2), revenueActual: inc.revenue, revenueEstimated: r0(inc.revenue * (1 - gauss(r) * 0.02)), lastUpdated: isoDate(reportDate(inc)) }); }
    // pad older quarters from the annual history so `limit=16` is honoured
    for (const inc of s.incA.slice(2)) for (let qn2 = 4; qn2 >= 1 && rows.length < 40; qn2--) { const d = fyEndDate(c, Number(inc.fiscalYear), -3 * (4 - qn2)); const e = inc.epsDiluted / 4; rows.push({ symbol: sym, date: isoDate(addDays(d, 30)), epsActual: round(e * (1 + gauss(r) * 0.08), 2), epsEstimated: round(e, 2), revenueActual: r0(inc.revenue * c.seasonality[qn2 - 1]), revenueEstimated: r0(inc.revenue * c.seasonality[qn2 - 1] * 0.99), lastUpdated: isoDate(addDays(d, 30)) }); }
    return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  },
  insiders(sym, limit) {
    const c = company(sym); if (!c) return [];
    const r = rng(seedOf('ins:' + sym)); const rows = []; const today = todayUTC();
    const types = ['S-Sale', 'A-Award', 'M-Exempt', 'P-Purchase', 'F-InKind', 'G-Gift'];
    for (let i = 0; i < 40; i++) {
      const d = addDays(today, -Math.floor(r() * 500) - 2); const ex = c.execs[Math.floor(r() * c.execs.length)]; const type = types[Math.floor(r() * (i % 7 === 0 ? 6 : 3))];
      const px = closeOn(sym, isoDate(d)); const acq = /^(A|P|M)/.test(type); const priced = /^(S|P)/.test(type);
      rows.push({ symbol: sym, filingDate: isoDate(addDays(d, 2)), transactionDate: isoDate(d), reportingCik: `000${1500000 + Math.floor(r() * 400000)}`, companyCik: c.cik, transactionType: type, securitiesOwned: r0(20000 + r() * 400000), reportingName: ex[0], typeOfOwner: `officer: ${ex[1].split(',')[0]}`, acquisitionOrDisposition: acq ? 'A' : 'D', directOrIndirect: 'D', formType: '4', securitiesTransacted: r0(500 + r() * 25000), price: priced ? round(px * (1 + gauss(r) * 0.01), 2) : 0, securityName: 'Common Stock', url: 'https://www.sec.gov/Archives/edgar/data/' });
    }
    return rows.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)).slice(0, limit);
  },
  holders(sym, year, quarter, limit) {
    const inst = INSTRUMENTS[sym]; if (!inst || !inst.shares) return [];
    const r = rng(seedOf(`13f:${sym}:${year}:${quarter}`)); const names = ['VANGUARD GROUP INC', 'BLACKROCK INC.', 'BERKSHIRE HATHAWAY INC', 'STATE STREET CORP', 'FMR LLC', 'GEODE CAPITAL MANAGEMENT, LLC', 'MORGAN STANLEY', 'NORGES BANK', 'JPMORGAN CHASE & CO', 'T. ROWE PRICE ASSOCIATES, INC.', 'CAPITAL WORLD INVESTORS', 'INVESCO LTD.'];
    const qEnd = isoDate(lastDayOfMonth(Number(year), Number(quarter) * 3)); const px = closeOn(sym, qEnd); const weights = names.map((_, i) => 0.087 * Math.pow(0.78, i));   // top 12 holders ≈ 37% of shares
    return names.map((investorName, i) => { const w = weights[i] * (1 + gauss(r) * 0.08); const shares = inst.shares * w; const chg = shares * gauss(r) * 0.03; return { date: qEnd, cik: `00000${(10000 + i * 913).toString()}`, filingDate: isoDate(addDays(utc(...qEnd.split('-').map(Number)), 45)), investorName, symbol: sym, securityName: inst.name.toUpperCase(), typeOfSecurity: 'COM', securityCusip: '000000000', sharesType: 'SH', putCallShare: 'Share', investmentDiscretion: 'SOLE', industryTitle: (anyCo(sym)?.industry || '').toUpperCase(), weight: round(w * 100 * 0.6, 4), lastWeight: round(w * 100 * 0.6 * (1 - chg / shares), 4), changeInWeight: round(w * 100 * 0.6 * (chg / shares), 4), changeInWeightPercentage: round(chg / shares * 100, 4), marketValue: r0(shares * px), lastMarketValue: r0((shares - chg) * px * 0.97), changeInMarketValue: r0(chg * px), changeInMarketValuePercentage: round(chg / shares * 100 + 3, 4), sharesNumber: r0(shares), lastSharesNumber: r0(shares - chg), changeInSharesNumber: r0(chg), changeInSharesNumberPercentage: round(chg / (shares - chg) * 100, 4), quarterEndPrice: px, avgPricePaid: round(px * 0.55, 2), isNew: false, isSoldOut: false, ownership: round(w * 100, 4), lastOwnership: round(w * 100 * (1 - chg / shares), 4), changeInOwnership: round(w * 100 * (chg / shares), 4), changeInOwnershipPercentage: round(chg / shares * 100, 4), holdingPeriod: 40 + i * 3, firstAdded: '2010-03-31', performance: r0(shares * px * 0.05), performancePercentage: 5.1, lastPerformance: r0(shares * px * 0.04), changeInPerformance: r0(shares * px * 0.01), isCountedForPerformance: true }; }).slice(0, limit);
  },
};

/* ==========================================================================
   §7  FMP — market-level endpoints (quotes, history, movers, calendars, news, macro)
   ========================================================================== */
const NEWS_POOL = {
  general: ['Fed officials signal patience as inflation data cools', 'Treasury yields slip ahead of payrolls report', 'Oil steadies after OPEC+ output decision', 'Dollar edges lower as traders weigh rate path', 'Stocks open mixed as earnings season approaches', 'Consumer sentiment steadies in early October read', 'Jobless claims hold near multi-month lows', 'Gold extends record run on haven demand'],
  stock: ['%N tops quarterly estimates on strong demand', '%N shares slip as analysts trim price targets', 'Why %N could be the next big AI winner, says analyst', '%N raises full-year guidance; stock jumps', '%N announces new buyback program', '%N insider sells shares, filing shows', '%N names new chief financial officer', 'Analysts stay bullish on %N ahead of earnings'],
  publishers: ['Reuters', 'CNBC', 'Bloomberg', 'The Wall Street Journal', 'MarketWatch', 'Barron\'s', 'Seeking Alpha', 'Benzinga'],
};
function newsRows(kind, symbols, limit, page = 0) {
  const { mon } = thisWeek(); const r = rng(seedOf(`news:${kind}:${symbols.join(',')}:${page}`));
  const syms = symbols.length ? symbols : ['AAPL', 'MSFT', 'NVDA', 'JPM', 'SHAK', 'RIVN', 'AMZN', 'META', 'GOOGL', 'XOM'];
  const rows = [];
  for (let i = 0; i < Math.min(limit, 40); i++) {
    const sym = kind === 'general' ? null : syms[i % syms.length]; const name = sym ? (INSTRUMENTS[sym]?.name || sym) : '';
    const pool = kind === 'general' ? NEWS_POOL.general : NEWS_POOL.stock; const title = pool[Math.floor(r() * pool.length)].replace('%N', name);
    const minutesAgo = Math.floor(r() * 7 * 24 * 60); let when = new Date(Date.now() - minutesAgo * 60e3); if (when < mon) when = new Date(mon.getTime() + 9 * 3600e3);
    const publisher = NEWS_POOL.publishers[Math.floor(r() * NEWS_POOL.publishers.length)];
    rows.push({ symbol: sym, publishedDate: `${isoDate(when)} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`, publisher, title: `${title}${sym ? '' : ` (${i + 1})`}`, image: `https://images.financialmodelingprep.com/news/mock-${i}.jpg`, site: publisher.toLowerCase().replace(/[^a-z]/g, '') + '.com', text: `Synthetic mock article body for "${title}". Nothing here is real reporting; it exists so the News panel has rows to render.`, url: `https://example.com/news/${kind}/${page}/${i}` });
  }
  return rows.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
}
const ECON_EVENTS = [['Nonfarm Payrolls', 1, 'high', 150, 142], ['Unemployment Rate', 1, 'high', 4.2, 4.2, '%'], ['ISM Manufacturing PMI', 0, 'medium', 49.5, 48.7], ['ISM Services PMI', 2, 'medium', 52.0, 51.6], ['Initial Jobless Claims', 3, 'medium', 225, 218, 'K'], ['Trade Balance', 2, 'low', -60.0, -78.3, 'B'], ['Factory Orders', 1, 'low', 1.2, -1.3, '%'], ['Fed Chair Speech', 4, 'high', null, null], ['Consumer Credit', 4, 'low', 12.0, 16.0, 'B'], ['JOLTs Job Openings', 0, 'medium', 7.2, 7.18, 'M']];

const FMP_MKT = {
  batchQuote(symbols) { return symbols.map(s => s.trim().toUpperCase()).filter(s => INSTRUMENTS[s] && symbolAllowed(s)).map(quoteRow); },
  quote(sym) { return INSTRUMENTS[sym] && symbolAllowed(sym) ? [quoteRow(sym)] : []; },
  eod(sym, full, from, to) {
    if (!INSTRUMENTS[sym] || !symbolAllowed(sym)) return [];
    let rows = history(sym).filter(x => inRange(x.date, from, to));
    if (PLAN === 'free') { const cut = isoDate(addDays(todayUTC(), -5 * 365)); rows = rows.filter(x => x.date >= cut); }   // Free plan: 5 years of history
    rows = rows.slice(-5000).reverse();
    return full ? rows.map(x => ({ symbol: sym, ...x })) : rows.map(x => ({ symbol: sym, date: x.date, price: x.close, volume: x.volume }));
  },
  intraday(sym, from, to) { return INSTRUMENTS[sym] && symbolAllowed(sym) ? intraday5min(sym, from, to) : []; },
  search(query, limit) {
    const q = (query || '').toUpperCase();
    return Object.values(INSTRUMENTS).filter(i => i.symbol.includes(q) || i.name.toUpperCase().includes(q)).sort((a, b) => (a.symbol.startsWith(q) ? 0 : 1) - (b.symbol.startsWith(q) ? 0 : 1) || a.symbol.localeCompare(b.symbol)).slice(0, limit)
      .map(i => ({ symbol: i.symbol, name: i.name, currency: 'USD', exchangeFullName: { NASDAQ: 'NASDAQ Global Select', NYSE: 'New York Stock Exchange', AMEX: 'NYSE Arca', INDEX: 'Index', COMMODITY: 'Commodity', CRYPTO: 'CCC' }[i.exchange] || i.exchange, exchange: i.exchange }));
  },
  movers(kind) {
    const rows = Object.values(INSTRUMENTS).filter(i => i.kind === 'company' || i.kind === 'generic').map(i => { const q = quoteRow(i.symbol); return { symbol: i.symbol, price: q.price, name: i.name, change: q.change, changesPercentage: q.changePercentage, exchange: i.exchange }; });
    if (kind === 'actives') return rows.map(x => ({ ...x, _v: quoteRow(x.symbol).volume })).sort((a, b) => b._v - a._v).map(({ _v, ...x }) => x).slice(0, 20);
    rows.sort((a, b) => kind === 'gainers' ? b.changesPercentage - a.changesPercentage : a.changesPercentage - b.changesPercentage);
    return rows.slice(0, 20);
  },
  marketHours(exchange) { const open = isNyseOpenNow(); const off = etOffsetHours(); const z = `${off < 0 ? '-' : '+'}${pad(Math.abs(off))}:00`; return [{ exchange: exchange || 'NYSE', name: exchange === 'NASDAQ' ? 'NASDAQ' : 'New York Stock Exchange', openingHour: `09:30 AM ${z}`, closingHour: `04:00 PM ${z}`, timezone: 'America/New_York', isMarketOpen: open }]; },
  treasuryRates(from, to) {
    const r = rng(seedOf('ust')); const rows = []; const end = latestWeekday();
    const base = { month1: 3.95, month2: 3.93, month3: 3.90, month6: 3.85, year1: 3.72, year2: 3.58, year3: 3.57, year5: 3.70, year7: 3.88, year10: 4.12, year20: 4.70, year30: 4.72 };
    for (let d = addDays(end, -40); d <= end; d = addDays(d, 1)) { if (isWeekend(d)) continue; const row = { date: isoDate(d) }; for (const k of Object.keys(base)) { base[k] = round(base[k] + gauss(r) * 0.025, 2); row[k] = base[k]; } rows.push(row); }
    const sel = rows.filter(x => inRange(x.date, from, to)); return (sel.length ? sel : rows.slice(-20)).reverse();
  },
  economicIndicators(name, from, to) {
    const series = { federalFunds: [3.88, 0.06, 'monthly'], CPI: [325.4, 0.4, 'monthly'], unemploymentRate: [4.2, 0.08, 'monthly'], GDP: [31400, 180, 'quarterly'], realGDP: [23900, 90, 'quarterly'], inflationRate: [2.9, 0.1, 'monthly'], retailSales: [730000, 4000, 'monthly'], consumerSentiment: [55.1, 1.5, 'monthly'], initialClaims: [220000, 6000, 'weekly'], totalNonfarmPayroll: [159500, 120, 'monthly'] }[name];
    if (!series) return [];
    const [latest, step, freq] = series; const r = rng(seedOf('econ:' + name)); const rows = []; const t = nowET(); let v = latest;
    for (let i = 0; i < 24; i++) {
      let d; if (freq === 'weekly') d = addDays(utc(t.y, t.m, t.d), -7 * i - ((t.dow + 1) % 7)); else if (freq === 'quarterly') { let m = t.m - 3 * i; let y = t.y; while (m <= 0) { m += 12; y -= 1; } d = utc(y, m - ((m - 1) % 3), 1); } else { let m = t.m - i; let y = t.y; while (m <= 0) { m += 12; y -= 1; } d = utc(y, m, 1); }
      rows.push({ name, date: isoDate(d), value: round(v, 3) }); v -= step * (0.5 + gauss(r) * 0.3);
    }
    const sel = rows.filter(x => inRange(x.date, from, to)); return (sel.length ? sel : rows.slice(0, 4));
  },
  earningsCalendar(from, to) {
    const { mon, sun } = thisWeek(); const start = from ? utc(...from.split('-').map(Number)) : mon, end = to ? utc(...to.split('-').map(Number)) : sun;
    const span = Math.max(1, Math.round((end - start) / 86400e3)); const r = rng(seedOf('ecal:' + isoDate(start)));
    const syms = ['AAPL', 'JPM', 'SHAK', 'RIVN', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'XOM', 'DPZ', 'WING', 'BAC', 'DELL', 'TSLA'];
    return syms.map((sym, i) => { const d = addDays(start, Math.min(span, Math.floor(r() * span))); const t = ttmSnapshot(sym); const eps = t ? t.netIncome / t.shares / 4 : 1; return { symbol: sym, date: isoDate(d), epsActual: null, epsEstimated: round(eps * (1 + 0.05 * gauss(r)), 2), revenueActual: null, revenueEstimated: t ? r0(t.revenue / 4 * (1 + 0.03 * gauss(r))) : null, lastUpdated: isoDate(todayUTC()) }; }).sort((a, b) => a.date.localeCompare(b.date));
  },
  economicCalendar(country, from, to) {
    const { mon, sun } = thisWeek(); const start = from ? utc(...from.split('-').map(Number)) : mon, end = to ? utc(...to.split('-').map(Number)) : sun;
    const span = Math.max(0, Math.round((end - start) / 86400e3)); const r = rng(seedOf('ccal:' + isoDate(start)));
    const rows = ECON_EVENTS.map(([event, dow, impact, estimate, previous, unit]) => { const d = addDays(start, Math.min(span, dow)); const actual = d < todayUTC() && estimate !== null ? round(estimate + gauss(r) * Math.abs(estimate) * 0.03, 1) : null; return { date: `${isoDate(d)} ${dow === 4 ? '14:00:00' : '12:30:00'}`, country: 'US', event, currency: 'USD', previous, estimate, actual, change: actual !== null && previous !== null ? round(actual - previous, 2) : null, impact: impact.charAt(0).toUpperCase() + impact.slice(1), changePercentage: actual !== null && previous ? round((actual / previous - 1) * 100, 3) : null, unit: unit || '' }; });
    const extra = [{ date: `${isoDate(addDays(start, 2))} 09:00:00`, country: 'DE', event: 'Factory Orders MoM (Aug)', currency: 'EUR', previous: -2.9, estimate: 1.2, actual: null, change: null, impact: 'Low', changePercentage: null, unit: '%' }];
    return rows.concat(extra).filter(x => !country || x.country === country.toUpperCase() || country.toUpperCase() === 'US' && x.country === 'US').sort((a, b) => a.date.localeCompare(b.date));
  },
  news(kind, symbols, limit, page) { return newsRows(kind, symbols, limit, page); },
  fmpArticles(limit, page) { return newsRows('general', [], limit, page).map((a, i) => ({ title: a.title, date: a.publishedDate, content: `<p>${a.text}</p>`, tickers: ['AAPL', 'MSFT', 'JPM', 'NVDA'][i % 4] ? `NASDAQ:${['AAPL', 'MSFT', 'JPM', 'NVDA'][i % 4]}` : '', image: a.image, link: a.url, author: 'FMP Mock Desk', site: 'financialmodelingprep.com' })); },
  sp500() { const out = []; for (const i of Object.values(INSTRUMENTS)) if ((i.kind === 'company' || i.kind === 'generic') && !/SONY|NIO|LCID|CAVA|SG|SHAK|RIVN/.test(i.symbol)) out.push({ symbol: i.symbol, name: i.name, sector: anyCo(i.symbol).sector, subSector: anyCo(i.symbol).industry, headQuarter: 'United States', dateFirstAdded: '2000-01-01', cik: company(i.symbol)?.cik || '0000000000', founded: '1950-01-01' }); return out; },
};

/* ==========================================================================
   §8  ALPHA VANTAGE — every number is a string; "None" where AV has no value.
   Same underlying model as the FMP fixtures, so SHAK/RIVN fall back cleanly.
   ========================================================================== */
const S = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? 'None' : Number(v).toFixed(d);
const SI = v => S(v, 0);
const AV_ERR = fn => ({ 'Error Message': `Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for ${fn}.` });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const avStamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

const AV = {
  GLOBAL_QUOTE(p) {
    const sym = (p.symbol || '').toUpperCase(); const q = INSTRUMENTS[sym] ? quoteRow(sym) : null;
    if (!q) return { 'Global Quote': {} };
    return { 'Global Quote': { '01. symbol': sym, '02. open': S(q.open, 4), '03. high': S(q.dayHigh, 4), '04. low': S(q.dayLow, 4), '05. price': S(q.price, 4), '06. volume': SI(q.volume), '07. latest trading day': history(sym).slice(-1)[0].date, '08. previous close': S(q.previousClose, 4), '09. change': S(q.change, 4), '10. change percent': `${S(q.changePercentage, 4)}%` } };
  },
  OVERVIEW(p) {
    const sym = (p.symbol || '').toUpperCase(); const co = anyCo(sym); if (!co) return {};
    const c = company(sym); const q = quoteRow(sym); const t = ttmSnapshot(sym); const km = keyMetricsFrom(t), rt = ratiosFrom(t); const g = c ? c.ratings : [3, 12, 9, 2, 1];
    const latestQ = c ? statements(c).incQ[0].date : isoDate(lastDayOfMonth(todayUTC().getUTCFullYear(), Math.max(3, Math.floor((todayUTC().getUTCMonth()) / 3) * 3)));
    const eps = t.netIncome / t.shares, fpe = eps > 0 ? q.price / (eps * (1 + (c ? c.epsGrowthEst : co.growth))) : null;
    return {
      Symbol: sym, AssetType: 'Common Stock', Name: co.name, Description: c ? c.description : `${co.name} (synthetic mock overview).`, CIK: c ? String(Number(c.cik)) : '1000000', Exchange: co.exchange, Currency: 'USD', Country: 'USA',
      Sector: co.sector.toUpperCase(), Industry: co.industry.toUpperCase(), Address: c ? `${c.address}, ${c.city}, ${c.state}, UNITED STATES, ${c.zip}`.toUpperCase() : '1 MAIN STREET, NEW YORK, NY, UNITED STATES, 10001', OfficialSite: c ? c.website : `https://www.${sym.toLowerCase()}.com`,
      FiscalYearEnd: MONTHS[(c ? c.fyEndMonth : 12) - 1], LatestQuarter: latestQ, MarketCapitalization: SI(t.marketCap), EBITDA: SI(t.ebitda), PERatio: eps > 0 ? S(q.price / eps, 2) : 'None', PEGRatio: eps > 0 ? S(rt.priceToEarningsGrowthRatio, 3) : 'None',
      BookValue: S(rt.bookValuePerShare, 2), DividendPerShare: S(rt.dividendPerShare, 2), DividendYield: S(rt.dividendYield, 4), EPS: S(eps, 2), RevenuePerShareTTM: S(rt.revenuePerShare, 2), ProfitMargin: S(rt.netProfitMargin, 3), OperatingMarginTTM: S(rt.operatingProfitMargin, 3),
      ReturnOnAssetsTTM: S(km.returnOnAssets, 3), ReturnOnEquityTTM: S(km.returnOnEquity, 3), RevenueTTM: SI(t.revenue), GrossProfitTTM: SI(t.grossProfit), DilutedEPSTTM: S(eps, 2), QuarterlyEarningsGrowthYOY: S(c ? c.epsGrowthEst : co.growth, 3), QuarterlyRevenueGrowthYOY: S(c ? (t.revenue / statements(c).incA[1].revenue - 1) : co.growth, 3),
      AnalystTargetPrice: S(FMP_CO.priceTargetConsensus(sym)[0].targetConsensus, 2), AnalystRatingStrongBuy: String(g[0]), AnalystRatingBuy: String(g[1]), AnalystRatingHold: String(g[2]), AnalystRatingSell: String(g[3]), AnalystRatingStrongSell: String(g[4]),
      TrailingPE: eps > 0 ? S(q.price / eps, 2) : 'None', ForwardPE: fpe ? S(fpe, 2) : 'None', PriceToSalesRatioTTM: S(rt.priceToSalesRatio, 2), PriceToBookRatio: S(rt.priceToBookRatio, 2), EVToRevenue: S(km.evToSales, 2), EVToEBITDA: km.evToEBITDA > 0 ? S(km.evToEBITDA, 2) : 'None', Beta: S(co.beta, 3),
      '52WeekHigh': S(q.yearHigh, 2), '52WeekLow': S(q.yearLow, 2), '50DayMovingAverage': S(q.priceAvg50, 2), '200DayMovingAverage': S(q.priceAvg200, 2), SharesOutstanding: SI(t.shares * 0.99), SharesFloat: SI(t.shares * 0.98), PercentInsiders: S(c && c.symbol === 'RIVN' ? 15.2 : 0.9, 3), PercentInstitutions: S(c ? 62.5 : 70.1, 3),
      DividendDate: rt.dividendPerShare > 0 ? isoDate(addDays(todayUTC(), 40)) : 'None', ExDividendDate: rt.dividendPerShare > 0 ? isoDate(addDays(todayUTC(), 30)) : 'None',
    };
  },
  INCOME_STATEMENT(p) {
    const c = company((p.symbol || '').toUpperCase()); if (!c) return {};
    const s = statements(c); const map = r => ({ fiscalDateEnding: r.date, reportedCurrency: 'USD', grossProfit: SI(r.grossProfit), totalRevenue: SI(r.revenue), costOfRevenue: SI(r.costOfRevenue), costofGoodsAndServicesSold: SI(r.costOfRevenue), operatingIncome: SI(r.operatingIncome), sellingGeneralAndAdministrative: SI(r.sellingGeneralAndAdministrativeExpenses), researchAndDevelopment: r.researchAndDevelopmentExpenses ? SI(r.researchAndDevelopmentExpenses) : 'None', operatingExpenses: SI(r.operatingExpenses), investmentIncomeNet: SI(r.interestIncome), netInterestIncome: SI(r.netInterestIncome), interestIncome: SI(r.interestIncome), interestExpense: SI(r.interestExpense), nonInterestIncome: 'None', otherNonOperatingIncome: SI(r.nonOperatingIncomeExcludingInterest), depreciation: SI(r.depreciationAndAmortization * 0.85), depreciationAndAmortization: SI(r.depreciationAndAmortization), incomeBeforeTax: SI(r.incomeBeforeTax), incomeTaxExpense: SI(r.incomeTaxExpense), interestAndDebtExpense: SI(r.interestExpense), netIncomeFromContinuingOperations: SI(r.netIncomeFromContinuingOperations), comprehensiveIncomeNetOfTax: SI(r.netIncome * 0.98), ebit: SI(r.ebit), ebitda: SI(r.ebitda), netIncome: SI(r.netIncome) });
    return { symbol: c.symbol, annualReports: s.incA.map(map), quarterlyReports: s.incQ.map(map) };
  },
  BALANCE_SHEET(p) {
    const c = company((p.symbol || '').toUpperCase()); if (!c) return {};
    const s = statements(c); const map = r => ({ fiscalDateEnding: r.date, reportedCurrency: 'USD', totalAssets: SI(r.totalAssets), totalCurrentAssets: SI(r.totalCurrentAssets), cashAndCashEquivalentsAtCarryingValue: SI(r.cashAndCashEquivalents), cashAndShortTermInvestments: SI(r.cashAndShortTermInvestments), inventory: SI(r.inventory), currentNetReceivables: SI(r.netReceivables), totalNonCurrentAssets: SI(r.totalNonCurrentAssets), propertyPlantEquipment: SI(r.propertyPlantEquipmentNet), accumulatedDepreciationAmortizationPPE: SI(r.propertyPlantEquipmentNet * 0.9), intangibleAssets: SI(r.goodwillAndIntangibleAssets), intangibleAssetsExcludingGoodwill: SI(r.intangibleAssets), goodwill: SI(r.goodwill), investments: SI(r.totalInvestments), longTermInvestments: SI(r.longTermInvestments), shortTermInvestments: SI(r.shortTermInvestments), otherCurrentAssets: SI(r.otherCurrentAssets), otherNonCurrentAssets: SI(r.otherNonCurrentAssets), totalLiabilities: SI(r.totalLiabilities), totalCurrentLiabilities: SI(r.totalCurrentLiabilities), currentAccountsPayable: SI(r.accountPayables), deferredRevenue: SI(r.deferredRevenue), currentDebt: SI(r.shortTermDebt), shortTermDebt: SI(r.shortTermDebt), totalNonCurrentLiabilities: SI(r.totalNonCurrentLiabilities), capitalLeaseObligations: SI(r.capitalLeaseObligations), longTermDebt: SI(r.longTermDebt), currentLongTermDebt: SI(r.shortTermDebt * 0.5), longTermDebtNoncurrent: SI(r.longTermDebt), shortLongTermDebtTotal: SI(r.totalDebt), otherCurrentLiabilities: SI(r.otherCurrentLiabilities), otherNonCurrentLiabilities: SI(r.otherNonCurrentLiabilities), totalShareholderEquity: SI(r.totalStockholdersEquity), treasuryStock: SI(r.treasuryStock), retainedEarnings: SI(r.retainedEarnings), commonStock: SI(r.commonStock), commonStockSharesOutstanding: SI(INSTRUMENTS[c.symbol].shares) });
    return { symbol: c.symbol, annualReports: s.balA.map(map), quarterlyReports: s.balQ.map(map) };
  },
  CASH_FLOW(p) {
    const c = company((p.symbol || '').toUpperCase()); if (!c) return {};
    const s = statements(c); const map = r => ({ fiscalDateEnding: r.date, reportedCurrency: 'USD', operatingCashflow: SI(r.operatingCashFlow), paymentsForOperatingActivities: 'None', proceedsFromOperatingActivities: 'None', changeInOperatingLiabilities: SI(r.accountsPayables), changeInOperatingAssets: SI(-(r.accountsReceivables + r.inventory)), depreciationDepletionAndAmortization: SI(r.depreciationAndAmortization), capitalExpenditures: SI(-r.capitalExpenditure), changeInReceivables: SI(-r.accountsReceivables), changeInInventory: SI(-r.inventory), profitLoss: SI(r.netIncome), cashflowFromInvestment: SI(r.netCashProvidedByInvestingActivities), cashflowFromFinancing: SI(r.netCashProvidedByFinancingActivities), proceedsFromRepaymentsOfShortTermDebt: SI(r.shortTermNetDebtIssuance), paymentsForRepurchaseOfCommonStock: SI(-r.commonStockRepurchased), paymentsForRepurchaseOfEquity: SI(-r.commonStockRepurchased), paymentsForRepurchaseOfPreferredStock: 'None', dividendPayout: SI(-r.netDividendsPaid), dividendPayoutCommonStock: SI(-r.netDividendsPaid), dividendPayoutPreferredStock: 'None', proceedsFromIssuanceOfCommonStock: 'None', proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet: SI(r.longTermNetDebtIssuance), proceedsFromIssuanceOfPreferredStock: 'None', proceedsFromRepurchaseOfEquity: SI(r.commonStockRepurchased), proceedsFromSaleOfTreasuryStock: 'None', changeInCashAndCashEquivalents: SI(r.netChangeInCash), changeInExchangeRate: 'None', netIncome: SI(r.netIncome) });
    return { symbol: c.symbol, annualReports: s.cfA.map(map), quarterlyReports: s.cfQ.map(map) };
  },
  EARNINGS(p) {
    const c = company((p.symbol || '').toUpperCase()); if (!c) return {};
    const rows = FMP_CO.earnings(c.symbol, 60).filter(x => x.epsActual !== null); const s = statements(c);
    return {
      symbol: c.symbol, annualEarnings: s.incA.map(r => ({ fiscalDateEnding: r.date, reportedEPS: S(r.epsDiluted, 2) })),
      quarterlyEarnings: rows.map(x => { const d = utc(...x.date.split('-').map(Number)); const sur = x.epsActual - x.epsEstimated; return { fiscalDateEnding: isoDate(addDays(d, -30)), reportedDate: x.date, reportedEPS: S(x.epsActual, 2), estimatedEPS: S(x.epsEstimated, 2), surprise: S(sur, 2), surprisePercentage: x.epsEstimated ? S(sur / Math.abs(x.epsEstimated) * 100, 4) : 'None', reportTime: 'post-market' }; }),
    };
  },
  EARNINGS_CALENDAR(p) {                                        // CSV text
    const sym = (p.symbol || '').toUpperCase(); const lines = ['symbol,name,reportDate,fiscalDateEnding,estimate,currency'];
    const horizonDays = { '3month': 92, '6month': 183, '12month': 366 }[p.horizon] || 92; const limitDate = isoDate(addDays(todayUTC(), horizonDays));
    const syms = sym ? [sym] : Object.keys(COMPANIES);
    for (const s of syms) { const c = company(s); if (!c) continue; for (const x of FMP_CO.earnings(s, 4).filter(x => x.epsActual === null && x.date <= limitDate)) lines.push(`${s},${c.name.replace(/,/g, '')},${x.date},${isoDate(addDays(utc(...x.date.split('-').map(Number)), -30))},${x.epsEstimated},USD`); }
    return lines.join('\r\n') + '\r\n';
  },
  EARNINGS_ESTIMATES(p) {
    const sym = (p.symbol || '').toUpperCase(); if (!anyCo(sym)) return {};
    const rows = FMP_CO.analystEstimates(sym, 'annual', 10); const t = ttmSnapshot(sym); const out = [];
    const est = (date, horizon, eps, rev, n) => ({ date, horizon, eps_estimate_average: S(eps, 4), eps_estimate_high: S(eps * 1.08, 4), eps_estimate_low: S(eps * 0.92, 4), eps_estimate_analyst_count: S(n, 4), eps_estimate_average_7_days_ago: S(eps * 1.001, 4), eps_estimate_average_30_days_ago: S(eps * 0.995, 4), eps_estimate_average_60_days_ago: S(eps * 0.99, 4), eps_estimate_average_90_days_ago: S(eps * 0.985, 4), eps_estimate_revision_up_trailing_7_days: '1.0000', eps_estimate_revision_down_trailing_7_days: null, eps_estimate_revision_up_trailing_30_days: '2.0000', eps_estimate_revision_down_trailing_30_days: '1.0000', revenue_estimate_average: S(rev, 2), revenue_estimate_high: S(rev * 1.06, 2), revenue_estimate_low: S(rev * 0.94, 2), revenue_estimate_analyst_count: S(n, 2) });
    for (const r of rows.filter(r => r.date >= isoDate(todayUTC())).slice(-2)) out.push(est(r.date, 'fiscal year', r.epsAvg, r.revenueAvg, r.numAnalystsEps));
    const c = company(sym); const qrows = c ? statements(c).incQ : [];
    for (let k = 0; k < 8; k++) { const base = qrows[k % Math.max(1, qrows.length)]; const eps = base ? base.epsDiluted * 1.05 : t.netIncome / t.shares / 4; const rev = base ? base.revenue * 1.05 : t.revenue / 4; const d = addDays(todayUTC(), 90 * (2 - k)); out.push(est(isoDate(lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)), 'fiscal quarter', eps, rev, 12)); }
    return { symbol: sym, estimates: out };
  },
  INSIDER_TRANSACTIONS(p) {
    const sym = (p.symbol || '').toUpperCase(); const rows = FMP_CO.insiders(sym, 200);
    return { data: rows.map(x => ({ transaction_date: x.transactionDate, ticker: sym, executive: x.reportingName.toUpperCase(), executive_title: x.typeOfOwner.replace(/^officer: /, ''), security_type: /A-Award|M-Exempt/.test(x.transactionType) ? 'Restricted Stock Unit' : 'Common Stock', acquisition_or_disposal: x.acquisitionOrDisposition, shares: S(x.securitiesTransacted, 1), share_price: x.price ? S(x.price, 2) : '' })) };
  },
  INSTITUTIONAL_HOLDINGS(p) {
    const sym = (p.symbol || '').toUpperCase(); const inst = INSTRUMENTS[sym]; if (!inst || !inst.shares) return {};
    const t = nowET(); let y = t.y, q = Math.floor((t.m - 1) / 3); if (q === 0) { y -= 1; q = 4; }
    const rows = FMP_CO.holders(sym, y, q, 12); const inc = rows.filter(r => r.changeInSharesNumber > 0), dec = rows.filter(r => r.changeInSharesNumber < 0);
    const held = inst.shares * 0.62;                               // institutions hold ~62% in this mock; the 12 listed holders are a subset
    return {
      symbol: sym, total_institutional_holders: String(2400 + rows.length), total_institutional_shares: SI(held), holders_with_increased_holdings: String(1100 + inc.length), shares_with_increased_holdings: SI(sum(inc.map(r => r.changeInSharesNumber)) * 4),
      holders_with_decreased_holdings: String(1050 + dec.length), shares_with_decreased_holdings: SI(-sum(dec.map(r => r.changeInSharesNumber)) * 4), holders_with_unchanged_holdings: '250', shares_with_unchanged_holdings: SI(held * 0.4),
      total_institutional_ownership_percentage: `${Math.round(held / inst.shares * 100)}%`,
      holdings: rows.map(r => ({ holder_name: r.investorName, shares_held: SI(r.sharesNumber), shares_changed: SI(Math.abs(r.changeInSharesNumber)), shares_changed_percentage: `${S(Math.abs(r.changeInSharesNumberPercentage), 2)}%`, change_type: r.changeInSharesNumber > 0 ? 'increased' : r.changeInSharesNumber < 0 ? 'decreased' : 'unchanged', last_reported: r.date })),
    };
  },
  NEWS_SENTIMENT(p) {
    const tickers = (p.tickers || '').split(',').map(s => s.trim().toUpperCase().replace(/^CRYPTO:|^FOREX:/, '')).filter(Boolean);
    const topics = (p.topics || '').split(',').map(s => s.trim()).filter(Boolean);
    const limit = clamp(Number(p.limit) || 50, 1, 1000); const r = rng(seedOf(`avnews:${tickers.join()}:${topics.join()}`));
    const base = tickers.length ? newsRows('stock', tickers, limit) : newsRows(topics.includes('earnings') ? 'stock' : 'general', [], limit);
    const label = s => s <= -0.35 ? 'Bearish' : s <= -0.15 ? 'Somewhat-Bearish' : s < 0.15 ? 'Neutral' : s < 0.35 ? 'Somewhat-Bullish' : 'Bullish';
    const topicList = topics.length ? topics : ['financial_markets', 'earnings', 'economy_macro', 'technology'];
    const feed = base.map(a => {
      const score = clamp(gauss(r) * 0.25 + 0.05, -0.9, 0.9); const d = new Date(a.publishedDate.replace(' ', 'T') + 'Z');
      const ts = (a.symbol ? [a.symbol] : []).concat(['AAPL', 'MSFT', 'JPM'].filter(s => s !== a.symbol).slice(0, Math.floor(r() * 3)));
      return { title: a.title, url: a.url, time_published: avStamp(d), authors: [a.publisher + ' Staff'], summary: a.text, banner_image: r() < 0.1 ? null : a.image, source: a.publisher, category_within_source: 'General', source_domain: a.site, topics: topicList.slice(0, 1 + Math.floor(r() * 2)).map(t => ({ topic: t, relevance_score: S(0.4 + r() * 0.6, 6) })), overall_sentiment_score: round(score, 6), overall_sentiment_label: label(score), ticker_sentiment: ts.map((t, i) => { const s2 = clamp(score + gauss(r) * 0.15, -1, 1); return { ticker: t, relevance_score: S(i === 0 ? 0.9 + r() * 0.1 : 0.2 + r() * 0.5, 6), ticker_sentiment_score: S(s2, 6), ticker_sentiment_label: label(s2) }; }) };
    });
    if ((p.sort || 'LATEST').toUpperCase() === 'EARLIEST') feed.reverse();
    return { items: String(feed.length), sentiment_score_definition: 'x <= -0.35: Bearish; -0.35 < x <= -0.15: Somewhat-Bearish; -0.15 < x < 0.15: Neutral; 0.15 <= x < 0.35: Somewhat_Bullish; x >= 0.35: Bullish', relevance_score_definition: '0 < x <= 1, with a higher score indicating higher relevance.', feed };
  },
  TREASURY_YIELD(p) {
    const maturity = p.maturity || '10year', interval = p.interval || 'monthly'; const col = { '3month': 'month3', '2year': 'year2', '5year': 'year5', '7year': 'year7', '10year': 'year10', '30year': 'year30' }[maturity]; if (!col) return AV_ERR('TREASURY_YIELD');
    const rows = FMP_MKT.treasuryRates(null, null); const name = `${maturity.replace('month', '-Month').replace('year', '-Year')} Treasury Constant Maturity Rate`;
    const data = rows.map(x => ({ date: x.date, value: S(x[col], 2) }));
    return { name, interval, unit: 'percent', data: interval === 'daily' ? data : data.filter((_, i) => i % 5 === 0) };
  },
  FEDERAL_FUNDS_RATE(p) {
    const interval = p.interval || 'monthly'; const r = rng(seedOf('dff'));
    const data = interval === 'monthly' ? FMP_MKT.economicIndicators('federalFunds', null, '9999-12-31').map(x => ({ date: x.date, value: S(x.value, 2) })) : (() => { const out = []; let v = 3.88; let d = latestWeekday(); for (let i = 0; i < 30; i++) { out.push({ date: isoDate(d), value: S(v, 2) }); v = clamp(v + gauss(r) * 0.005, 3.5, 4.5); d = addDays(d, -1); } return out; })();
    return { name: 'Effective Federal Funds Rate', interval, unit: 'percent', data };
  },
  _commodity(sym, name, unit, p, scale = 1) {
    const interval = p.interval || 'monthly'; const h = history(sym).slice().reverse();
    let data;
    if (interval === 'daily') data = h.slice(0, 60).map(x => ({ date: x.date, value: S(x.close * scale, 2) }));
    else { const byMonth = new Map(); for (const x of h) { const k = x.date.slice(0, 7) + '-01'; if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(x.close); } data = [...byMonth.entries()].slice(0, 36).map(([date, v]) => ({ date, value: S(sum(v) / v.length * scale, 2) })); }
    return { name, interval, unit, data };
  },
  WTI(p) { return AV._commodity('CLUSD', 'Crude Oil Prices WTI', 'dollars per barrel', p); },
  BRENT(p) { return AV._commodity('BZUSD', 'Crude Oil Prices Brent', 'dollars per barrel', p); },
  NATURAL_GAS(p) { return AV._commodity('NGUSD', 'Henry Hub Natural Gas Spot Price', 'dollars per million BTU', p); },
  COPPER(p) { return AV._commodity('HGUSD', 'Global Price of Copper', 'dollar per metric ton', p, 2204.62); },   // AV quotes copper per metric ton, not per pound
  CURRENCY_EXCHANGE_RATE(p) {
    const from = (p.from_currency || '').toUpperCase(), to = (p.to_currency || 'USD').toUpperCase(); const names = { BTC: 'Bitcoin', ETH: 'Ethereum', USD: 'United States Dollar', EUR: 'Euro', GBP: 'British Pound Sterling', JPY: 'Japanese Yen' };
    const rate = { BTC: INSTRUMENTS.BTCUSD.price, ETH: INSTRUMENTS.ETHUSD.price, USD: 1, EUR: 1.17, GBP: 1.34, JPY: 0.0068 }[from]; if (!rate || to !== 'USD') return AV_ERR('CURRENCY_EXCHANGE_RATE');
    const now = new Date();
    return { 'Realtime Currency Exchange Rate': { '1. From_Currency Code': from, '2. From_Currency Name': names[from] || from, '3. To_Currency Code': to, '4. To_Currency Name': names[to], '5. Exchange Rate': S(rate, 8), '6. Last Refreshed': `${isoDate(now)} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`, '7. Time Zone': 'UTC', '8. Bid Price': S(rate * 0.9995, 8), '9. Ask Price': S(rate * 1.0005, 8) } };
  },
  TIME_SERIES_DAILY(p) {
    const sym = (p.symbol || '').toUpperCase(); if (!INSTRUMENTS[sym]) return AV_ERR('TIME_SERIES_DAILY');
    const h = history(sym).slice().reverse(); const rows = (p.outputsize === 'full' ? h : h.slice(0, 100));
    const ts = {}; for (const x of rows) ts[x.date] = { '1. open': S(x.open, 4), '2. high': S(x.high, 4), '3. low': S(x.low, 4), '4. close': S(x.close, 4), '5. volume': SI(x.volume) };
    return { 'Meta Data': { '1. Information': 'Daily Prices (open, high, low, close) and Volumes', '2. Symbol': sym, '3. Last Refreshed': rows[0].date, '4. Output Size': p.outputsize === 'full' ? 'Full size' : 'Compact', '5. Time Zone': 'US/Eastern' }, 'Time Series (Daily)': ts };
  },
};

/* ==========================================================================
   §9  FRED — /fred/series/observations
   ========================================================================== */
function fredObservations(q) {
  const id = (q.series_id || '').toUpperCase(); const today = isoDate(todayUTC());
  let obs = null;
  const ust = FMP_MKT.treasuryRates(null, null);
  if (/^DGS(2|10|30)$/.test(id)) { const col = { DGS2: 'year2', DGS10: 'year10', DGS30: 'year30' }[id]; obs = ust.map((x, i) => ({ date: x.date, value: i === 2 ? '.' : String(x[col]) })); }   // one "." row so holiday handling gets exercised
  else if (id === 'DFF') { const r = rng(seedOf('fred:dff')); obs = []; let v = 3.88; for (let d = addDays(todayUTC(), -1), i = 0; i < 40; d = addDays(d, -1), i++) { obs.push({ date: isoDate(d), value: v.toFixed(2) }); if (!isWeekend(d)) v = clamp(v + gauss(r) * 0.004, 3.5, 4.5); } }
  else if (id === 'DTWEXBGS') { const r = rng(seedOf('fred:dxy')); obs = []; let v = 120.33; for (let d = addDays(latestWeekday(), -5), i = 0; i < 40; d = addDays(d, -1)) { if (isWeekend(d)) continue; obs.push({ date: isoDate(d), value: v.toFixed(4) }); v += gauss(r) * 0.25; i++; } }
  if (!obs) return { status: 400, body: { error_code: 400, error_message: `Bad Request.  The series does not exist.  (mock knows DGS2, DGS10, DGS30, DFF, DTWEXBGS; got ${id || 'nothing'})` } };
  if ((q.sort_order || 'asc') === 'asc') obs.reverse();
  const limit = clamp(Number(q.limit) || 100000, 1, 100000), offset = Number(q.offset) || 0;
  const page = obs.slice(offset, offset + limit).map(o => ({ realtime_start: today, realtime_end: today, date: o.date, value: o.value }));
  return { status: 200, body: { realtime_start: today, realtime_end: today, observation_start: '1776-07-04', observation_end: '9999-12-31', units: 'lin', output_type: 1, file_type: 'json', order_by: 'observation_date', sort_order: q.sort_order || 'asc', count: obs.length, offset, limit, observations: page } };
}

/* ==========================================================================
   §10 ROUTER + SERVER
   ========================================================================== */
const PREMIUM_403 = { 'Error Message': 'Premium Endpoint: this endpoint requires a paid plan' };
const PLAN_403 = { 'Error Message': 'Premium Endpoint: This endpoint is not available on the Free plan. Please upgrade your plan at https://site.financialmodelingprep.com/developer/docs/pricing' };
const KEY_401 = { 'Error Message': 'Invalid API KEY. Feel free to create a Free API Key or visit https://site.financialmodelingprep.com/faqs?search=why-is-my-api-key-invalid for more information.' };
// Paths FMP's Free plan does not serve at all (prefix match)
const FREE_BLOCKED = ['batch-quote', 'news/', 'historical-chart/', 'economic-calendar', 'insider-trading/search', 'sp500-constituent', 'institutional-ownership/'];
const freeCap = (limit, cap) => PLAN === 'free' ? Math.min(limit, cap) : limit;

// Returns { status, body } (body is JSON-serialisable) or { status, text, type } for raw text.
function fmpRoute(fmpPath, q) {
  const sym = (q.symbol || '').toUpperCase();
  const limit = Math.max(1, Number(q.limit) || 100), period = q.period || 'annual';
  const okArr = body => ({ status: 200, body });
  const needSym = fn => okArr(!sym ? [] : fn());
  switch (fmpPath) {
    case 'batch-quote': return okArr(FMP_MKT.batchQuote((q.symbols || '').split(',')));
    case 'quote': return needSym(() => FMP_MKT.quote(sym));
    case 'profile': return needSym(() => symbolAllowed(sym) ? FMP_CO.profile(sym) : []);
    case 'shares-float': return needSym(() => symbolAllowed(sym) ? FMP_CO.sharesFloat(sym) : []);
    case 'key-metrics-ttm': return needSym(() => symbolAllowed(sym) ? FMP_CO.keyMetricsTTM(sym) : []);
    case 'ratios-ttm': return needSym(() => symbolAllowed(sym) ? FMP_CO.ratiosTTM(sym) : []);
    case 'key-metrics': return needSym(() => symbolAllowed(sym) ? FMP_CO.keyMetrics(sym, period, freeCap(limit, 5)) : []);
    case 'ratios': return needSym(() => symbolAllowed(sym) ? FMP_CO.ratios(sym, period, freeCap(limit, 5)) : []);
    case 'enterprise-values': return needSym(() => symbolAllowed(sym) ? FMP_CO.enterpriseValues(sym, freeCap(limit, 5)) : []);
    case 'income-statement': return needSym(() => symbolAllowed(sym) ? FMP_CO.statement(sym, 'income', period, freeCap(limit, 5)) : []);
    case 'balance-sheet-statement': return needSym(() => symbolAllowed(sym) ? FMP_CO.statement(sym, 'balance', period, freeCap(limit, 5)) : []);
    case 'cash-flow-statement': return needSym(() => symbolAllowed(sym) ? FMP_CO.statement(sym, 'cashflow', period, freeCap(limit, 5)) : []);
    case 'historical-price-eod/full': return needSym(() => FMP_MKT.eod(sym, true, q.from, q.to));
    case 'historical-price-eod/light': return needSym(() => FMP_MKT.eod(sym, false, q.from, q.to));
    case 'historical-chart/5min': return needSym(() => FMP_MKT.intraday(sym, q.from, q.to));
    case 'key-executives': return needSym(() => symbolAllowed(sym) ? FMP_CO.executives(sym) : []);
    case 'employee-count': return needSym(() => symbolAllowed(sym) ? FMP_CO.employeeCount(sym, freeCap(limit, 5)) : []);
    case 'revenue-product-segmentation': return needSym(() => symbolAllowed(sym) ? FMP_CO.segmentation(sym, 'product', period) : []);
    case 'revenue-geographic-segmentation': return needSym(() => symbolAllowed(sym) ? FMP_CO.segmentation(sym, 'geo', period) : []);
    case 'stock-peers': return needSym(() => FMP_CO.peers(sym));                       // open on every plan
    case 'analyst-estimates': return needSym(() => symbolAllowed(sym) ? FMP_CO.analystEstimates(sym, period, freeCap(limit, 10)) : []);
    case 'price-target-summary': return needSym(() => symbolAllowed(sym) ? FMP_CO.priceTargetSummary(sym) : []);
    case 'price-target-consensus': return needSym(() => symbolAllowed(sym) ? FMP_CO.priceTargetConsensus(sym) : []);
    case 'grades-consensus': return needSym(() => symbolAllowed(sym) ? FMP_CO.gradesConsensus(sym) : []);
    case 'earnings': return needSym(() => symbolAllowed(sym) ? FMP_CO.earnings(sym, freeCap(limit, 5)) : []);
    case 'earnings-calendar': return okArr(FMP_MKT.earningsCalendar(q.from, q.to).filter(x => symbolAllowed(x.symbol)));
    case 'economic-calendar': return okArr(FMP_MKT.economicCalendar(q.country, q.from, q.to));
    case 'insider-trading/search': return needSym(() => symbolAllowed(sym) ? FMP_CO.insiders(sym, limit) : []);
    case 'institutional-ownership/extract-analytics/holder': return needSym(() => FMP_CO.holders(sym, q.year || new Date().getUTCFullYear(), q.quarter || 1, Math.min(limit, 12)));
    case 'news/general-latest': return okArr(FMP_MKT.news('general', [], limit, Number(q.page) || 0));
    case 'news/stock-latest': return okArr(FMP_MKT.news('stock', [], limit, Number(q.page) || 0));
    case 'news/stock': return okArr(FMP_MKT.news('stock', (q.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(s => INSTRUMENTS[s]), limit, Number(q.page) || 0));
    case 'fmp-articles': return okArr(FMP_MKT.fmpArticles(limit, Number(q.page) || 0));
    case 'biggest-gainers': return okArr(FMP_MKT.movers('gainers'));
    case 'biggest-losers': return okArr(FMP_MKT.movers('losers'));
    case 'most-actives': return okArr(FMP_MKT.movers('actives'));
    case 'exchange-market-hours': return okArr(FMP_MKT.marketHours(q.exchange));
    case 'treasury-rates': return okArr(FMP_MKT.treasuryRates(q.from, q.to));
    case 'economic-indicators': return okArr(FMP_MKT.economicIndicators(q.name, q.from, q.to));
    case 'search-symbol': case 'search-name': return okArr(FMP_MKT.search(q.query, Math.min(limit, 50)));
    case 'sp500-constituent': return okArr(FMP_MKT.sp500());
    default: return { status: 404, body: { 'Error Message': `Mock: no handler for /stable/${fmpPath}` } };
  }
}

function avRoute(q) {
  const fn = (q.function || '').toUpperCase();
  if (!q.apikey) return { status: 200, body: { 'Error Message': 'the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key). It should take less than 20 seconds.' } };
  if (fn === 'EARNINGS_CALENDAR') return { status: 200, text: AV.EARNINGS_CALENDAR(q), type: 'text/csv' };
  if (!AV[fn] || fn.startsWith('_')) return { status: 200, body: AV_ERR(fn || 'this function') };
  return { status: 200, body: AV[fn](q) };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, X-Requested-With', 'Access-Control-Max-Age': '3600' };
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const q = Object.fromEntries(url.searchParams.entries());
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const logLine = status => { const shown = url.search.replace(/([?&]api_?key=)[^&]*/i, '$1***'); console.log(`${new Date().toISOString()} ${req.method} ${p}${shown} -> ${status} (${Date.now() - started} ms)`); };
  const finish = (status, body, type) => { send(res, status, body, type); logLine(status); };
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); logLine(204); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') return finish(405, { error: 'GET only' });
    if (p === '/' || p === '/index.html') {
      let html; try { html = fs.readFileSync(INDEX_HTML, 'utf8'); } catch (e) { return finish(500, `index.html not found at ${INDEX_HTML}: ${e.message}`, 'text/plain; charset=utf-8'); }
      return finish(200, html, 'text/html; charset=utf-8');
    }
    if (p === '/favicon.ico') return finish(204, '');
    if (q.fail === '1') return finish(403, PREMIUM_403);
    if (p.startsWith('/stable/')) {
      const fmpPath = p.slice('/stable/'.length);
      if (!q.apikey) return finish(401, KEY_401);
      if (PLAN === 'free' && FREE_BLOCKED.some(b => fmpPath.startsWith(b))) return finish(403, PLAN_403);
      const r = fmpRoute(fmpPath, q);
      return finish(r.status, r.body);
    }
    if (p === '/av' || p === '/av/query' || p === '/query') {
      const r = avRoute(q);
      return r.text !== undefined ? finish(r.status, r.text, r.type + '; charset=utf-8') : finish(r.status, r.body);
    }
    if (p === '/fred/series/observations') { const r = fredObservations(q); return finish(r.status, r.body); }
    if (p === '/health') return finish(200, { ok: true, plan: PLAN, symbols: Object.keys(INSTRUMENTS).length, marketOpen: isNyseOpenNow(), et: nowET().date });
    return finish(404, { error: `No route for ${p}. Try /, /stable/<path>, /av?function=..., /fred/series/observations` });
  } catch (e) {
    console.error(e);
    return finish(500, { error: `mock server error: ${e.message}` });
  }
});
server.listen(PORT, () => {
  console.log(`Market Desk mock API listening on http://localhost:${PORT}  (plan: ${PLAN}; ${Object.keys(INSTRUMENTS).length} symbols; index.html from ${INDEX_HTML})`);
  console.log(`  FMP base  http://localhost:${PORT}/stable   AV base  http://localhost:${PORT}/av   FRED base  http://localhost:${PORT}/fred`);
});
