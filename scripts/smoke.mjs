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
      rows.push(`${s},${st},fail,${stamp(t++)}`);
      if (i === 1234) continue;
      rows.push(`${s},REPAIR,pass,${stamp(t++)}`);
    }
    rows.push(`${s},${st},pass,${stamp(t++)}`);
  }
}
rows.reverse();
writeFileSync(join(dir, 'events.csv'), 'serial,step,result,timestamp\n' + rows.join('\n') + '\n');
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
