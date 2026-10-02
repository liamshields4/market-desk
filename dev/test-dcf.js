#!/usr/bin/env node
// Unit tests for the DCF engine embedded in ../index.html (between the @@ENGINE markers).
// Run: node dev/test-dcf.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.split('/* @@ENGINE-START */')[1].split('/* @@ENGINE-END */')[0];
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src + '\nthis.DCF = DCF;', ctx);
const DCF = ctx.DCF;
let passed = 0, failed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// A simple, fully known assumption set
const base = () => ({
  baseRevenue: 1000, baseLabel: 'FY', growth: [0.10, 0.08, 0.06, 0.04, 0.025], margin: [0.20, 0.20, 0.20, 0.20, 0.20],
  taxRate: 0.25, daPct: 0.05, capexPct: 0.06, nwcPct: 0.01,
  rf: 0.04, beta: 1.0, erp: 0.05, costOfDebt: 0.06, equityValue: 8000, debtValue: 2000, waccOverride: null,
  tvMethod: 'perpetuity', termGrowth: 0.025, exitMultiple: 10, midYear: false,
  shares: 100, netDebt: 1500, minority: 0, preferred: 0, price: 50, meta: {},
});

console.log('DCF engine tests');
t('WACC build-up', () => {
  const W = DCF.wacc(base());
  assert(near(W.ke, 0.09)); assert(near(W.kdAfter, 0.045)); assert(near(W.we, 0.8)); assert(near(W.wd, 0.2));
  assert(near(W.wacc, 0.8 * 0.09 + 0.2 * 0.045));
});
t('WACC override and no-debt case', () => {
  assert(near(DCF.wacc({ ...base(), waccOverride: 0.1 }).wacc, 0.1));
  const W = DCF.wacc({ ...base(), debtValue: 0 }); assert(near(W.wacc, 0.09)); assert(near(W.wd, 0));
});
t('Year-1 FCFF arithmetic', () => {
  const r = DCF.run(base()); const y = r.rows[0];
  assert(near(y.revenue, 1100)); assert(near(y.ebit, 220)); assert(near(y.tax, 55)); assert(near(y.nopat, 165));
  assert(near(y.da, 55)); assert(near(y.capex, 66)); assert(near(y.dNWC, 11)); assert(near(y.fcff, 165 + 55 - 66 - 11));
  assert(near(y.df, 1 / 1.081)); assert(near(y.pv, y.fcff / 1.081));
});
t('Perpetuity terminal value and bridge', () => {
  const a = base(); const r = DCF.run(a); const y5 = r.rows[4]; const w = r.wacc.wacc;
  const tv = y5.fcff * 1.025 / (w - 0.025);
  assert(near(r.perp.tv, tv)); assert(near(r.perp.pvTv, tv / Math.pow(1 + w, 5)));
  assert(near(r.perp.ev, r.sumPv + r.perp.pvTv)); assert(near(r.perp.equity, r.perp.ev - 1500)); assert(near(r.perp.perShare, r.perp.equity / 100));
  assert(near(r.perp.upside, r.perp.perShare / 50 - 1)); assert(near(r.perp.tvPct, r.perp.pvTv / r.perp.ev));
  assert(r.selected === r.perp);
});
t('Exit multiple terminal value', () => {
  const a = { ...base(), tvMethod: 'exit' }; const r = DCF.run(a); const y5 = r.rows[4];
  assert(near(r.exit.tv, y5.ebitda * 10)); assert(near(y5.ebitda, y5.ebit + y5.da)); assert(r.selected === r.exit);
  assert(near(r.impliedExitFromPerp, r.perp.tv / y5.ebitda));
});
t('Mid-year convention raises PV', () => {
  const r0 = DCF.run(base()), r1 = DCF.run({ ...base(), midYear: true });
  assert(r1.sumPv > r0.sumPv); assert(near(r1.rows[0].df, 1 / Math.pow(1.081, 0.5)));
});
t('WACC <= g marks perpetuity invalid, exit still valid', () => {
  const r = DCF.run({ ...base(), waccOverride: 0.02 });
  assert(!r.perp.valid); assert(Number.isNaN(r.perp.tv)); assert(r.exit.valid);
});
t('Losses: no tax on negative EBIT; all-negative FCFF flagged', () => {
  const a = { ...base(), margin: [-0.3, -0.25, -0.2, -0.15, -0.1] }; const r = DCF.run(a);
  assert(r.rows.every(x => x.tax === 0)); assert(r.rows.every(x => x.fcff < 0));
  const flags = DCF.flags(a, r, {}); assert(flags.some(f => /negative in every year/.test(f.text)));
  assert(!r.exit.valid, 'exit invalid when year-5 EBITDA negative');
});
t('Equity bridge subtracts minority and preferred', () => {
  const a = { ...base(), minority: 100, preferred: 50 }; const r = DCF.run(a);
  assert(near(r.perp.equity, r.perp.ev - 1500 - 150));
});
t('Sensitivity grid shape, base cell and nearest-to-price cell', () => {
  const a = base(); const s = DCF.sensitivity(a, 'perpetuity');
  assert.strictEqual(s.waccs.length, 7); assert.strictEqual(s.cols.length, 5); assert.strictEqual(s.grid.length, 7);
  assert.strictEqual(JSON.stringify(s.baseCell), "[3,2]");
  assert(near(s.grid[3][2], DCF.run(a).perp.perShare));
  const [i, j] = s.near; const best = Math.min(...s.grid.flat().map(v => Math.abs(v - 50)));
  assert(near(Math.abs(s.grid[i][j] - 50), best));
  const sx = DCF.sensitivity(a, 'exit'); assert.strictEqual(sx.cols.length, 5); assert(near(sx.grid[3][2], DCF.run({ ...a, tvMethod: 'exit' }).exit.perShare));
  // monotone: higher WACC → lower price down a column
  for (let c = 0; c < 5; c++) for (let r = 1; r < 7; r++) assert(s.grid[r][c] < s.grid[r - 1][c]);
});
t('Reverse DCF reproduces the price', () => {
  const a = base(); const rev = DCF.reverse(a);
  assert(rev.growth !== null, rev.reason); assert(near(rev.price, 50, 1e-4));
  // consistency: plugging the solved growth back in gives the price
  const p = DCF.priceFor(a, { growth: Array(5).fill(rev.growth) }); assert(near(p, 50, 1e-4));
});
t('Reverse DCF reports no solution when the price is unreachable', () => {
  const rev = DCF.reverse({ ...base(), price: 1e9 }); assert.strictEqual(rev.growth, null); assert(rev.reason);
});
t('Scenarios shift growth and margins symmetrically', () => {
  const s = DCF.scenarios(base(), { growthShift: 0.03, marginShift: 0.02 });
  assert(near(s.bull.avgGrowth - s.base.avgGrowth, 0.03)); assert(near(s.base.avgMargin - s.bear.avgMargin, 0.02));
  assert(s.bear.price < s.base.price && s.base.price < s.bull.price);
  assert(near(s.base.price, DCF.run(base()).perp.perShare));
});
t('Defaults from history: growth fade, margin average, tax, reinvestment signs', () => {
  const metrics = [
    { year: '2021', revenue: 700, operatingMargin: 0.18, taxRate: 0.20, da: 30, capex: -40, changeInWorkingCapital: -5, debt: 100, interestExpense: 6, sharesDiluted: 100 },
    { year: '2022', revenue: 800, operatingMargin: 0.20, taxRate: 0.22, da: 35, capex: -45, changeInWorkingCapital: -8, debt: 120, interestExpense: 7, sharesDiluted: 100 },
    { year: '2023', revenue: 900, operatingMargin: 0.22, taxRate: 0.21, da: 40, capex: -50, changeInWorkingCapital: -9, debt: 140, interestExpense: 8, sharesDiluted: 100 },
    { year: '2024', revenue: 1000, operatingMargin: 0.24, taxRate: 0.23, da: 45, capex: -55, changeInWorkingCapital: -10, debt: 160, interestExpense: 9, sharesDiluted: 100 },
  ];
  const a = DCF.defaults({ metrics, ttm: null, latestBal: { totalDebt: 160, cashAndShortTermInvestments: 60, minorityInterest: 0, preferredStock: 0 }, price: 50, marketCap: 5000, shares: 100, rf: 0.04, erp: 0.05, beta: 1.2, peerExitMultiple: 12 });
  const cagr3 = Math.pow(1000 / 700, 1 / 3) - 1;
  assert(near(a.growth[0], +cagr3.toFixed(4), 1e-3)); assert(near(a.growth[4], 0.025));
  assert(a.growth[0] > a.growth[1] && a.growth[1] > a.growth[2] && a.growth[2] > a.growth[3] && a.growth[3] > a.growth[4]);
  assert(near(a.margin[0], 0.22, 1e-3));                       // avg of 0.20, 0.22, 0.24
  assert(near(a.taxRate, 0.22, 1e-3));                         // avg of 0.22, 0.21, 0.23
  assert(a.daPct > 0 && a.capexPct > 0 && a.nwcPct > 0);      // capex and NWC investment come out positive
  assert(near(a.netDebt, 100)); assert(near(a.debtValue, 160)); assert(near(a.equityValue, 5000));
  assert(near(a.exitMultiple, 12)); assert(a.costOfDebt >= 0.045 && a.costOfDebt <= 0.14);
  assert(near(a.beta, 1.2));
});
t('Defaults clamp a wild CAGR and fall back with thin history', () => {
  const m = [{ year: '2023', revenue: 100, operatingMargin: -0.5, taxRate: null, da: 5, capex: -20, changeInWorkingCapital: 0, debt: 0, interestExpense: 0, sharesDiluted: 10 }, { year: '2024', revenue: 300, operatingMargin: -0.4, taxRate: null, da: 10, capex: -30, changeInWorkingCapital: 0, debt: 0, interestExpense: 0, sharesDiluted: 10 }];
  const a = DCF.defaults({ metrics: m, latestBal: {}, price: 10, marketCap: 100, shares: 10, rf: 0.04 });
  assert(near(a.growth[0], 0.40)); assert(near(a.taxRate, 0.21)); assert(near(a.margin[0], -0.45, 1e-3));
  assert(near(a.debtValue, 0)); assert(near(a.netDebt, 0)); assert(near(a.exitMultiple, 10));
  const flags = DCF.flags(a, DCF.run(a), { years: 2 });
  assert(flags.some(f => /fiscal year/.test(f.text))); assert(flags.some(f => /clamped/.test(f.text)));
});
t('Bank flag', () => { const a = base(); const f = DCF.flags(a, DCF.run(a), { isFinancial: true }); assert(f.some(x => x.level === 'bad' && /Bank/.test(x.text))); });
t('CSV export has the key sections', () => {
  const a = base(); const r = DCF.run(a);
  const csv = DCF.toCSV(a, r, DCF.sensitivity(a, 'perpetuity'), DCF.sensitivity(a, 'exit'), DCF.reverse(a), DCF.scenarios(a), 'TEST');
  for (const s of ['ASSUMPTIONS', 'PROJECTION', 'TERMINAL VALUE', 'SENSITIVITY', 'REVERSE DCF', 'SCENARIOS']) assert(csv.includes(s), s);
  assert(csv.split('\n').length > 40);
});

t('Sensitivity centre cell equals the headline price (exact base, no rounding)', () => {
  const a = base(); const s = DCF.sensitivity(a, 'perpetuity');
  assert(near(s.grid[3][2], DCF.run(a).perp.perShare, 1e-12)); assert(near(s.waccs[3], DCF.wacc(a).wacc, 1e-12));
  const a2 = { ...a, beta: 1.137 }; const s2 = DCF.sensitivity(a2, 'exit');
  assert.strictEqual(JSON.stringify(s2.baseCell), '[3,2]'); assert(near(s2.grid[3][2], DCF.run({ ...a2, tvMethod: 'exit' }).exit.perShare, 1e-12));
});
t('Perpetuity invalid when year-5 FCFF <= 0; UI-level fallback data present', () => {
  const a = { ...base(), margin: [-0.1, -0.1, -0.1, -0.1, -0.1] }; const r = DCF.run(a);
  assert(!r.perp.valid); assert(r.rows[4].fcff <= 0);
  const flags = DCF.flags(a, r, {}); assert(flags.some(f => f.level === 'bad' && /Year-5 FCFF/.test(f.text)));
});
t('Unknown equity value → all-equity WACC and a warning, not Kd-only', () => {
  const a = { ...base(), equityValue: null }; const W = DCF.wacc(a);
  assert(W.equityUnknown); assert(near(W.we, 1)); assert(near(W.wacc, 0.09));
  assert(DCF.flags(a, DCF.run(a), {}).some(f => /Market cap unavailable/.test(f.text)));
});
t('Mid-year: perpetuity TV discounted at 4.5 years, exit TV at 5', () => {
  const r = DCF.run({ ...base(), midYear: true }); const w = r.wacc.wacc;
  assert(near(r.perp.pvTv, r.perp.tv / Math.pow(1 + w, 4.5))); assert(near(r.exit.pvTv, r.exit.tv / Math.pow(1 + w, 5)));
});
t('Reverse DCF rejects zero shares with a clear reason', () => { const rev = DCF.reverse({ ...base(), shares: 0 }); assert.strictEqual(rev.growth, null); assert(/share count/.test(rev.reason)); });
t('Exit-method WACC≈g is a warning, not a bad flag', () => {
  const a = { ...base(), tvMethod: 'exit', waccOverride: 0.03 }; const f = DCF.flags(a, DCF.run(a), {});
  assert(!f.some(x => x.level === 'bad')); assert(f.some(x => x.level === 'warn' && /cross-check/.test(x.text)));
});
t('Defaults: beta 0 treated as missing; interest expense from annual metrics; tax clamp noted', () => {
  const m = [
    { year: '2022', date: '2022-12-31', revenue: 800, operatingMargin: 0.2, taxRate: 0.05, da: 35, capex: -45, changeInWorkingCapital: -8, debt: 360, interestExpense: 19, sharesDiluted: 100 },
    { year: '2023', date: '2023-12-31', revenue: 900, operatingMargin: 0.2, taxRate: 0.05, da: 40, capex: -50, changeInWorkingCapital: -9, debt: 380, interestExpense: 20, sharesDiluted: 100 },
    { year: '2024', date: '2024-12-31', revenue: 1000, operatingMargin: 0.2, taxRate: 0.05, da: 45, capex: -55, changeInWorkingCapital: -10, debt: 400, interestExpense: 21, sharesDiluted: 100 },
  ];
  const a = DCF.defaults({ metrics: m, ttm: null, latestBal: { date: '2024-12-31', totalDebt: 400, cashAndShortTermInvestments: 50 }, price: 50, marketCap: 5000, shares: 100, rf: 0.04, beta: 0 });
  assert(near(a.beta, 1.0));
  assert(near(a.costOfDebt, 21 / ((400 + 380) / 2), 1e-3));     // avg of latest and prior year-end debt
  assert(near(a.taxRate, 0.10)); assert(/clamped/.test(a.meta.taxSource));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
