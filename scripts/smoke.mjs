#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const ex = (n) => join(root, 'examples', n);
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const dir = mkdtempSync(join(tmpdir(), 'route-smoke-'));
const link = join(dir, 'route-check');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const res = run(bin, [ex('route.csv'), ex('events.csv'), '--rework-steps', 'repair', '--json']);
  const data = res.stdout ? JSON.parse(res.stdout) : {};
  if (res.status !== 1 || data.findings?.length !== 5 || data.summary?.serials !== 10 || data.summary?.finished !== 9) {
    fail(`example via ${bin}: status ${res.status} ${JSON.stringify(data.summary)} ${res.stderr}`);
  }
}
console.log('smoke: ok example (direct and via symlink): 10 serials, 9 finished, 5 findings, exit 1');

// Routes per part number: example with two part routes, one part without a route and one part conflict.
const pr = run(cli, [ex('parts/route.csv'), ex('parts/events.csv'), '--rework-steps', 'repair', '--json']);
const pd = pr.stdout ? JSON.parse(pr.stdout) : {};
if (
  pr.status !== 1 ||
  pd.parts?.length !== 2 ||
  pd.summary?.serials !== 11 ||
  pd.summary?.finished !== 9 ||
  JSON.stringify(pd.counts) !== JSON.stringify({ 'skipped-step': 1, 'unknown-part': 1, 'part-conflict': 1 })
) {
  fail(`parts example: status ${pr.status} ${JSON.stringify(pd.summary)} ${JSON.stringify(pd.counts)} ${pr.stderr}`);
}
console.log('smoke: ok parts example: 2 part routes, 11 serials, 9 finished, 3 findings, exit 1');

// 100,000 units x 7 steps, timestamped; every 50th unit fails FCT once and is retested after REPAIR;
// unit 777 skips AOI, unit 1234 goes on to PACK after an FCT fail. File order reversed (replayed by time).
// Station column: unit i runs every step on station <step>-<i % 4> (ignored unless --station-column).
const steps = ['SMT', 'AOI', 'ICT', 'FLASH', 'CALIB', 'FCT', 'PACK'];
writeFileSync(join(dir, 'route.csv'), 'step\n' + steps.join('\n') + '\n');
const stamp = (min) => new Date(Date.UTC(2026, 10, 1) + min * 60_000).toISOString().replace('T', ' ').slice(0, 19);
const rows = [];
for (let i = 0; i < 100_000; i++) {
  const s = `M${i}`;
  let t = i * 2;
  for (const st of steps) {
    if (i === 777 && st === 'AOI') continue;
    if (st === 'FCT' && (i % 50 === 0 || i === 1234)) {
      rows.push(`${s},${st},fail,${stamp(t++)},${st}-${i % 4}`);
      if (i === 1234) continue;
      rows.push(`${s},REPAIR,pass,${stamp(t++)},R-1`);
    }
    rows.push(`${s},${st},pass,${stamp(t++)},${st}-${i % 4}`);
  }
}
rows.reverse();
writeFileSync(join(dir, 'events.csv'), 'serial,step,result,timestamp,station\n' + rows.join('\n') + '\n');
const t0 = Date.now();
const big = run(cli, [join(dir, 'route.csv'), join(dir, 'events.csv'), '--rework-steps', 'REPAIR', '--json']);
const bd = big.stdout ? JSON.parse(big.stdout) : {};
const ms = Date.now() - t0;
const fct = bd.yields?.find((y) => y.step === 'FCT');
if (
  big.status !== 1 ||
  bd.summary?.serials !== 100_000 ||
  bd.summary?.finished !== 100_000 ||
  bd.counts?.['skipped-step'] !== 1 ||
  bd.counts?.['continued-after-fail'] !== 1 ||
  bd.findings?.length !== 2 ||
  fct?.firstPass !== 100_000 - 2001 ||
  bd.summary?.reworkEvents !== 2000
) {
  fail(`large: status ${big.status} ${JSON.stringify(bd.summary)} ${JSON.stringify(bd.counts)} ${JSON.stringify(fct)} ${big.stderr}`);
}
console.log(`smoke: ok large (100,000 units, ${rows.length.toLocaleString('en')} timestamped records, reversed) in ${ms} ms: 1 skipped, 1 continued after fail`);

// FPY per day and shift on the same large log: per-period first records add up to the per-step yield.
const t1 = Date.now();
const per = run(cli, [join(dir, 'route.csv'), join(dir, 'events.csv'), '--rework-steps', 'REPAIR', '--json', '--by-day', '--shifts', 'A=07:00,B=15:00,C=23:00']);
const pdd = per.stdout ? JSON.parse(per.stdout) : {};
const ms1 = Date.now() - t1;
const k = steps.indexOf('FCT');
const sum = (f) => (pdd.periods ?? []).reduce((a, p) => a + f(p), 0);
if (
  per.status !== 1 ||
  pdd.periodSettings?.by !== 'day-shift' ||
  !(pdd.periods?.length > 400) ||
  sum((p) => p.steps[k].units) !== 100_000 ||
  sum((p) => p.steps[k].firstPass) !== 100_000 - 2001 ||
  JSON.stringify(pdd.counts) !== JSON.stringify(bd.counts)
) {
  fail(`periods: status ${per.status} ${JSON.stringify(pdd.periodSettings)} ${pdd.periods?.length} ${per.stderr}`);
}
console.log(`smoke: ok --by-day --shifts on the large log in ${ms1} ms: ${pdd.periods.length} day/shift periods, FCT first records add up`);

// Yield per station on the same large log: station counts add up to the step; findings unchanged.
const t2 = Date.now();
const stn = run(cli, [join(dir, 'route.csv'), join(dir, 'events.csv'), '--rework-steps', 'REPAIR', '--json', '--station-column', 'station']);
const sd = stn.stdout ? JSON.parse(stn.stdout) : {};
const ms2 = Date.now() - t2;
const fs = sd.yields?.find((y) => y.step === 'FCT')?.stations ?? [];
const fails = Object.fromEntries(fs.map((x) => [x.station, x.fails]));
if (
  stn.status !== 1 ||
  fs.length !== 4 ||
  fs.reduce((a, x) => a + x.units, 0) !== 100_000 ||
  fs.reduce((a, x) => a + x.firstPass, 0) !== 100_000 - 2001 ||
  JSON.stringify(fails) !== JSON.stringify({ 'FCT-0': 1000, 'FCT-1': 0, 'FCT-2': 1001, 'FCT-3': 0 }) ||
  JSON.stringify(sd.counts) !== JSON.stringify(bd.counts)
) {
  fail(`stations: status ${stn.status} ${JSON.stringify(fs)} ${stn.stderr}`);
}
console.log(`smoke: ok --station-column on the large log in ${ms2} ms: 4 FCT stations, counts add up, FCT-0 / FCT-2 hold the fails`);

// Dwell limits on the same large log: steps are 1 min apart, so SMT>PACK is 6 min, 8 min for the 2,000 units
// retested at FCT after REPAIR (over 6m, exactly 6m is not over); unit 1234 never passed FCT, so FCT>PACK skips it.
const t3 = Date.now();
const dw = run(cli, [join(dir, 'route.csv'), join(dir, 'events.csv'), '--rework-steps', 'REPAIR', '--json', '--max-dwell', 'SMT>PACK=6m,FCT>PACK=1m']);
const dd = dw.stdout ? JSON.parse(dw.stdout) : {};
const ms3 = Date.now() - t3;
const [sp, fp] = dd.dwell ?? [];
if (
  dw.status !== 1 ||
  sp?.units !== 100_000 ||
  sp?.exceeded !== 2000 ||
  sp?.maxMs !== 8 * 60_000 ||
  sp?.medianMs !== 6 * 60_000 ||
  fp?.units !== 99_999 ||
  fp?.exceeded !== 0 ||
  dd.counts?.['dwell-exceeded'] !== 2000 ||
  dd.findings?.length !== 2002
) {
  fail(`dwell: status ${dw.status} ${JSON.stringify(dd.dwell)} ${JSON.stringify(dd.counts)} ${dw.stderr}`);
}
console.log(`smoke: ok --max-dwell on the large log in ${ms3} ms: SMT>PACK 2,000 of 100,000 over 6m, FCT>PACK 99,999 measured`);
