import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { formatDuration, parseDuration, parseDwellLimits } from '../src/dwell.js';
import { InputError } from '../src/errors.js';
import { csvReport, mdReport } from '../src/formats.js';
import { parseEvents, parseRoute, parseRoutes } from '../src/input.js';
import { textReport } from '../src/report.js';
import { check, checkParts } from '../src/route.js';
import { ex, root } from './helpers.js';

function run(args: string[]) {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  try {
    return { code: main(args), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

const golden = (name: string) => readFileSync(join(root, 'test', 'golden', name), 'utf8');
const ROUTE = parseRoute('step\nA\nB\nC\n');
const SH = [ex('shifts/route.csv'), ex('shifts/events.csv')];
const H = 3_600_000;
const M = 60_000;

/** events: "serial step result HH:MM[:SS]" per line, all on 2026-11-12. */
function events(lines: string) {
  const rows = lines
    .trim()
    .split('\n')
    .map((l) => {
      const [serial, step, result, time] = l.trim().split(/\s+/);
      return `${serial},${step},${result},2026-11-12 ${time}`;
    });
  return parseEvents('serial,step,result,timestamp\n' + rows.join('\n') + '\n');
}

const limits = (v: string) => parseDwellLimits(v);

describe('parseDuration / formatDuration', () => {
  it('parses d / h / m / s, combinations and decimals', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(30 * M);
    expect(parseDuration('2h')).toBe(2 * H);
    expect(parseDuration('1h30m')).toBe(90 * M);
    expect(parseDuration('1.5h')).toBe(90 * M);
    expect(parseDuration('1d2h')).toBe(26 * H);
    expect(parseDuration(' 2H ')).toBe(2 * H);
    expect(parseDuration('0.5s')).toBe(500);
  });
  it('rejects bare numbers, zero, repeated or out-of-order units and junk', () => {
    for (const bad of ['', '30', '0m', '0s', '1h1h', '30m1h', 'm', '-5m', '1 h', '2w', '1.h']) expect(parseDuration(bad), bad).toBeUndefined();
  });
  it('formats largest unit first, seconds left out when zero', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(30 * M)).toBe('30m');
    expect(formatDuration(2 * H + 5 * M)).toBe('2h05m');
    expect(formatDuration(2 * H + 5 * M + 7000)).toBe('2h05m07s');
    expect(formatDuration(27 * H)).toBe('1d03h00m');
    expect(formatDuration(250)).toBe('0.25s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(61_500)).toBe('1m01.5s');
  });
});

describe('parseDwellLimits', () => {
  it('comma list and repeated values, names trimmed', () => {
    expect(parseDwellLimits(['A>B=30m, B > C = 2h', 'A>C=1d'])).toEqual([
      { from: 'A', to: 'B', limitMs: 30 * M },
      { from: 'B', to: 'C', limitMs: 2 * H },
      { from: 'A', to: 'C', limitMs: 24 * H },
    ]);
  });
  it('input errors: syntax, duration, same step, duplicate pair, empty', () => {
    expect(() => limits('A-B=30m')).toThrow(/expected FROM>TO=DURATION/);
    expect(() => limits('A>B')).toThrow(/expected FROM>TO=DURATION/);
    expect(() => limits('>B=1h')).toThrow(/expected FROM>TO=DURATION/);
    expect(() => limits('A>B>C=1h')).toThrow(/expected FROM>TO=DURATION/);
    expect(() => limits('A>B=30')).toThrow(/duration "30" is not a positive time/);
    expect(() => limits('A>B=0m')).toThrow(InputError);
    expect(() => limits('a>A=1h')).toThrow(/same step/);
    expect(() => limits('A>B=1h,a>b=2h')).toThrow(/more than once/);
    expect(() => limits(' , ')).toThrow(/--max-dwell is empty/);
  });
});

describe('dwell rule (single route)', () => {
  it('dwell = first record at TO minus latest pass at FROM; equal to the limit is not a finding', () => {
    const e = events(`
      u1 A pass 08:00
      u1 B pass 08:30
      u2 A pass 08:00
      u2 B pass 08:31
    `);
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.findings.map((f) => f.serial)).toEqual(['u2']);
    expect(r.findings[0]).toMatchObject({
      kind: 'dwell-exceeded',
      serial: 'u2',
      step: 'A',
      reachedStep: 'B',
      rows: [4, 5],
      dwellMs: 31 * M,
      limitMs: 30 * M,
      message: 'u2 reached B (row 5) 31m after passing A (row 4); limit 30m',
    });
    expect(r.dwell).toEqual([{ from: 'A', to: 'B', limitMs: 30 * M, units: 2, exceeded: 1, medianMs: 30.5 * M, maxMs: 31 * M }]);
    expect(r.counts).toEqual({ 'dwell-exceeded': 1 });
  });
  it('retests at FROM: measured from the latest pass (repair time not counted)', () => {
    const e = events(`
      u1 A fail 08:00
      u1 A pass 09:00
      u1 B pass 09:20
    `);
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.findings).toEqual([]);
    expect(r.dwell![0]).toMatchObject({ units: 1, medianMs: 20 * M });
  });
  it('a fail at FROM after its pass does not reset the start (latest pass counts)', () => {
    const e = events(`
      u1 A pass 08:00
      u1 A fail 08:10
      u1 B pass 08:40
    `);
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.counts).toEqual({ 'continued-after-fail': 1, 'dwell-exceeded': 1 });
    expect(r.findings.find((f) => f.kind === 'dwell-exceeded')!.dwellMs).toBe(40 * M);
  });
  it('a unit back at TO later (rework loop) is measured once, at its first record at TO', () => {
    const e = events(`
      u1 A pass 08:00
      u1 B fail 08:10
      u1 A pass 09:00
      u1 B pass 12:00
    `);
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.findings).toEqual([]);
    expect(r.dwell![0]).toMatchObject({ units: 1, exceeded: 0, maxMs: 10 * M });
  });
  it('a fail at TO is still an arrival', () => {
    const e = events(`
      u1 A pass 08:00
      u1 B fail 09:00
    `);
    expect(check(ROUTE, e, { maxDwell: limits('A>B=30m') }).counts['dwell-exceeded']).toBe(1);
  });
  it('missing TO (WIP) or TO without a pass at FROM: not measured', () => {
    const e = events(`
      u1 A pass 08:00
      u2 B pass 08:00
      u2 A pass 09:00
      u2 C pass 12:00
    `);
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.dwell![0]).toMatchObject({ units: 0, exceeded: 0, medianMs: null, maxMs: null });
    expect(r.findings.map((f) => f.kind)).toEqual(['out-of-order']);
  });
  it('non-adjacent pairs and several pairs, stats in flag order', () => {
    const e = events(`
      u1 A pass 08:00
      u1 B pass 08:10
      u1 C pass 10:10
    `);
    const r = check(ROUTE, e, { maxDwell: limits('B>C=1h,A>C=3h') });
    expect(r.dwell!.map((d) => [d.from, d.to, d.maxMs])).toEqual([
      ['B', 'C', 2 * H],
      ['A', 'C', 2 * H + 10 * M],
    ]);
    expect(r.findings.map((f) => `${f.step}>${f.reachedStep}`)).toEqual(['B>C']);
  });
  it('mixed zone offsets: compared as instants', () => {
    const e = parseEvents('serial,step,timestamp\nu1,A,2026-11-12T08:00:00+08:00\nu1,B,2026-11-12T00:45:00Z\n');
    const r = check(ROUTE, e, { maxDwell: limits('A>B=30m') });
    expect(r.findings[0].dwellMs).toBe(45 * M);
  });
  it('step names match without regard to case; route spelling in output', () => {
    const r = check(ROUTE, events('u1 A pass 08:00\nu1 B pass 09:00'), { maxDwell: limits('a>b=30m') });
    expect(r.dwell![0]).toMatchObject({ from: 'A', to: 'B' });
  });
  it('input errors: no timestamps, unknown step, reversed order', () => {
    const noTime = parseEvents('serial,step\nu1,A\nu1,B\n');
    expect(() => check(ROUTE, noTime, { maxDwell: limits('A>B=1h') })).toThrow(/needs a timestamp column/);
    const e = events('u1 A pass 08:00');
    expect(() => check(ROUTE, e, { maxDwell: limits('A>X=1h') })).toThrow(/step "X" is not on the route/);
    expect(() => check(ROUTE, e, { maxDwell: limits('C>A=1h') })).toThrow(/A comes before C on the route/);
  });
  it('without maxDwell the report has no dwell field and no dwell-exceeded findings', () => {
    const e = events('u1 A pass 08:00\nu1 B pass 12:00');
    const r = check(ROUTE, e);
    expect(r.dwell).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('dwell');
    expect(check(ROUTE, e, { maxDwell: [] }).dwell).toBeUndefined();
  });
});

describe('dwell with routes per part', () => {
  const routes = parseRoutes('part,step\nP1,A\nP1,B\nP2,A\nP2,C\nP2,B\n').parts!;
  const ev = parseEvents(
    'serial,part,step,timestamp\n' +
      's1,P1,A,2026-11-12 08:00\ns1,P1,B,2026-11-12 09:00\n' +
      's2,P2,A,2026-11-12 08:00\ns2,P2,C,2026-11-12 08:05\ns2,P2,B,2026-11-12 08:20\n',
  );
  it('a pair applies to every part route that has both steps; per-part stats, findings carry the part', () => {
    const r = checkParts(routes, ev, { maxDwell: limits('A>B=30m,A>C=10m') });
    expect(r.dwell).toEqual([]);
    expect(r.parts![0].dwell!.map((d) => `${d.from}>${d.to}`)).toEqual(['A>B']);
    expect(r.parts![1].dwell!.map((d) => `${d.from}>${d.to}`)).toEqual(['A>B', 'A>C']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'dwell-exceeded', serial: 's1', part: 'P1' });
    expect(r.findings[0].message).toMatch(/limit 30m \(part P1\)$/);
  });
  it('no part route has both steps, or reversed on one part: input error', () => {
    expect(() => checkParts(routes, ev, { maxDwell: limits('B>C=1h') })).toThrow(/C comes before B/);
    expect(() => checkParts(routes, ev, { maxDwell: limits('A>X=1h') })).toThrow(/no part route has both steps/);
  });
  it('text and Markdown: a part without any pair says so', () => {
    const r = checkParts(routes, ev, { maxDwell: limits('A>C=10m') });
    expect(r.parts![0].dwell).toEqual([]);
    expect(textReport(r, 50)).toContain('Dwell between steps (per unit');
    expect(textReport(r, 50)).toContain('No step pair on this route.');
    expect(mdReport(r)).toContain('### Dwell between steps');
  });
});

describe('output formats', () => {
  const e = events(`
    u1 A pass 08:00
    u1 B pass 10:05
    u2 A pass 08:00
    u2 B pass 08:10
    u3 A pass 08:00
    u3 B pass 11:00
  `);
  const r = check(ROUTE, e, { maxDwell: limits('A>B=2h') });
  it('text: table and findings section, --limit respected', () => {
    const t = textReport(r, 1);
    expect(t).toContain('Steps  Limit  Units  Exceeded  Median    Max\nA > B  2h00m      3         2   2h05m  3h00m');
    expect(t).toContain('Dwell over the limit between steps (--max-dwell): 2\n  - u1 reached B (row 3) 2h05m after passing A (row 2); limit 2h00m\n  ... 1 more');
  });
  it('Markdown: section and findings', () => {
    const md = mdReport(r, 50);
    expect(md).toContain('## Dwell between steps\n\nPer unit: from its latest pass');
    expect(md).toContain('| steps | limit | units | exceeded | median | max |\n| --- | ---: | ---: | ---: | ---: | ---: |\n| A > B | 2h00m | 3 | 2 | 2h05m | 3h00m |');
    expect(md).toContain('| dwell-exceeded | 2 |');
  });
  it('CSV: one row per finding, step = FROM, reached_step = TO, rows, message', () => {
    const lines = csvReport(r).trim().split('\n');
    expect(lines[0]).toBe('kind,serial,step,reached_step,count,serials,steps,rows,detail');
    expect(lines.slice(1)).toEqual([
      'dwell-exceeded,u1,A,B,,,,2 3,u1 reached B (row 3) 2h05m after passing A (row 2); limit 2h00m',
      'dwell-exceeded,u3,A,B,,,,6 7,u3 reached B (row 7) 3h00m after passing A (row 6); limit 2h00m',
    ]);
  });
  it('JSON: dwell stats and finding fields', () => {
    const d = JSON.parse(JSON.stringify(r));
    expect(d.dwell[0]).toEqual({ from: 'A', to: 'B', limitMs: 2 * H, units: 3, exceeded: 2, medianMs: 2 * H + 5 * M, maxMs: 3 * H });
    expect(d.findings[0].dwellMs).toBe(2 * H + 5 * M);
  });
});

describe('CLI --max-dwell', () => {
  it('goldens: shifts example text / JSON / Markdown / CSV', () => {
    const a = [...SH, '--rework-steps', 'repair', '--max-dwell', 'ICT>FCT=20m', '--max-dwell', 'SMT>PACK=50m'];
    const t = run(a);
    expect(t.code).toBe(1);
    expect(t.out).toBe(golden('dwell.txt'));
    expect(run([...a, '--json']).out).toBe(golden('dwell.json'));
    expect(run([...a, '--md']).out).toBe(golden('dwell.md'));
    expect(run([...a, '--csv']).out).toBe(golden('dwell.csv'));
  });
  it('comma list equals repeated flags', () => {
    const one = run([...SH, '--max-dwell', 'ICT>FCT=20m,SMT>PACK=50m', '--json']).out;
    const two = run([...SH, '--max-dwell', 'ICT>FCT=20m', '--max-dwell', 'SMT>PACK=50m', '--json']).out;
    expect(one).toBe(two);
  });
  it('without the flag output is unchanged (byte-identical to goldens from a main build)', () => {
    expect(run([...SH, '--rework-steps', 'repair']).out).toBe(golden('shifts.txt'));
    expect(run([...SH, '--rework-steps', 'repair', '--json']).out).toBe(golden('shifts.json'));
  });
  it('generous limit: table only, no findings, exit 0 on a clean log', () => {
    const r = run([...SH, '--rework-steps', 'repair', '--max-dwell', 'SMT>PACK=1d', '--json']);
    const d = JSON.parse(r.out);
    expect(d.dwell[0]).toMatchObject({ units: 12, exceeded: 0 });
    expect(d.counts['dwell-exceeded']).toBeUndefined();
  });
  it('works with --by-day (dwell table after the period table)', () => {
    const r = run([...SH, '--max-dwell', 'SMT>PACK=50m', '--by-day']);
    expect(r.out).toContain('FPY by day');
    expect(r.out.indexOf('Dwell between steps')).toBeGreaterThan(r.out.indexOf('FPY by day'));
  });
  it('input errors exit 2: bad syntax, unknown step, reversed, no timestamps', () => {
    const cases: [string[], RegExp][] = [
      [[...SH, '--max-dwell', 'ICT-FCT=20m'], /expected FROM>TO=DURATION/],
      [[...SH, '--max-dwell', 'ICT>FCT=20'], /not a positive time/],
      [[...SH, '--max-dwell', 'ICT>XRAY=20m'], /step "XRAY" is not on the route/],
      [[...SH, '--max-dwell', 'FCT>ICT=20m'], /ICT comes before FCT/],
      [[...SH, '--max-dwell', ''], /--max-dwell is empty/],
    ];
    const dir = mkdtempSync(join(tmpdir(), 'dwell-'));
    const f = join(dir, 'events.csv');
    writeFileSync(f, 'serial,step,result\nu1,SMT,pass\n');
    cases.push([[SH[0], f, '--max-dwell', 'SMT>PACK=1h'], /--max-dwell needs a timestamp column/]);
    for (const [args, msg] of cases) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(msg);
      expect(r.out).toBe('');
    }
  });
  it('--help documents the flag and the rule', () => {
    const h = run(['--help']).out;
    expect(h).toContain('--max-dwell <FROM>TO=T>');
    expect(h).toContain('dwell-exceeded');
    expect(h).toContain('latest pass at FROM');
  });
});
