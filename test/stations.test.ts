import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { InputError } from '../src/errors.js';
import { mdReport } from '../src/formats.js';
import { parseEvents, parseRoute, parseRoutes } from '../src/input.js';
import { stationRows, textReport } from '../src/report.js';
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
const ROUTE = parseRoute('step,optional\nA,\nB,y\nC,\n');
const S = [ex('stations/route.csv'), ex('stations/events.csv')];

/** events: "serial step station result" per line (file order); '-' station = empty cell. */
function events(lines: string, header = 'serial,step,station,result') {
  const csv =
    header +
    '\n' +
    lines
      .trim()
      .split('\n')
      .map((l) =>
        l
          .trim()
          .split(/\s+/)
          .map((c) => (c === '-' ? '' : c))
          .join(','),
      )
      .join('\n') +
    '\n';
  return csv;
}

describe('parseEvents station column', () => {
  it('opt-in: without stationColumn a station column is ignored and hasStation is absent', () => {
    const e = parseEvents(events('u1 A M1 pass'));
    expect(e.hasStation).toBeUndefined();
    expect(e.events[0]).toEqual({ serial: 'u1', step: 'A', pass: true, row: 2 });
  });
  it('reads the station (empty cell = "") and sets hasStation', () => {
    const e = parseEvents(events('u1 A M1 pass\nu1 B - pass'), { stationColumn: 'Station' });
    expect(e.hasStation).toBe(true);
    expect(e.events.map((x) => x.station)).toEqual(['M1', '']);
  });
  it('missing column is an input error', () => {
    expect(() => parseEvents('serial,step\nu1,A\n', { stationColumn: 'machine' })).toThrow(/no "machine" column/);
  });
  it('station column equal to the step or serial column is an input error', () => {
    expect(() => parseEvents('serial,step\nu1,A\n', { stationColumn: 'step' })).toThrow(/also the step column/);
    expect(() => parseEvents('serial,step\nu1,A\n', { stationColumn: 'SERIAL' })).toThrow(InputError);
  });
  it('time-ordered files keep the station on each event', () => {
    const e = parseEvents('timestamp,serial,step,machine\n2026-01-01 08:05,u1,B,M2\n2026-01-01 08:00,u1,A,M1\n', { stationColumn: 'machine' });
    expect(e.timeOrdered).toBe(true);
    expect(e.events.map((x) => [x.step, x.station])).toEqual([
      ['A', 'M1'],
      ['B', 'M2'],
    ]);
  });
});

describe('yield per station', () => {
  const log = events(`
    u1 A M1 pass
    u2 A M2 fail
    u2 A M1 pass
    u3 A m1 fail
    u3 A M2 fail
    u3 A M2 pass
    u1 C T1 pass
    u2 C - pass
    u3 C T1 pass
  `);
  const r = check(ROUTE, parseEvents(log, { stationColumn: 'station' }));
  const a = r.yields[0];

  it('first record attributes first pass to its station; retests count as records on their own station', () => {
    expect(a.stations).toEqual([
      { station: 'M1', units: 2, firstPass: 1, fpy: 0.5, records: 3, fails: 1 },
      { station: 'M2', units: 1, firstPass: 0, fpy: 0, records: 3, fails: 2 },
    ]);
  });
  it('station names match without regard to case (first spelling kept)', () => {
    expect(a.stations!.map((s) => s.station)).toEqual(['M1', 'M2']);
  });
  it('per-station counts sum to the step values', () => {
    for (const y of r.yields) {
      const st = y.stations!;
      const sum = (f: (s: (typeof st)[number]) => number) => st.reduce((x, s) => x + f(s), 0);
      expect(sum((s) => s.units)).toBe(y.units);
      expect(sum((s) => s.firstPass)).toBe(y.firstPass);
      expect(sum((s) => s.records)).toBe(y.records);
      expect(sum((s) => s.fails)).toBe(y.fails);
    }
  });
  it('a step without records has an empty station list; empty station cell sorts last', () => {
    expect(r.yields[1].stations).toEqual([]);
    expect(r.yields[2].stations!.map((s) => s.station)).toEqual(['T1', '']);
  });
  it('a retest-only station has fpy null', () => {
    const q = check(ROUTE, parseEvents(events('u1 A M1 fail\nu1 A M9 pass\nu1 C T1 pass'), { stationColumn: 'station' }));
    expect(q.yields[0].stations).toEqual([
      { station: 'M1', units: 1, firstPass: 0, fpy: 0, records: 1, fails: 1 },
      { station: 'M9', units: 0, firstPass: 0, fpy: null, records: 1, fails: 0 },
    ]);
  });
  it('findings and every other report field are identical with and without the station column', () => {
    const without = check(ROUTE, parseEvents(log));
    const strip = JSON.parse(JSON.stringify(r));
    for (const y of strip.yields) delete y.stations;
    expect(strip).toEqual(JSON.parse(JSON.stringify(without)));
  });
  it('rework / unknown steps are not in the station breakdown', () => {
    const q = check(ROUTE, parseEvents(events('u1 A M1 pass\nu1 REPAIR R1 pass\nu1 X X1 pass\nu1 C T1 pass'), { stationColumn: 'station' }), {
      reworkSteps: ['repair'],
    });
    expect(q.yields.flatMap((y) => y.stations!.map((s) => s.station))).toEqual(['M1', 'T1']);
  });
  it('text and Markdown tables; "(none)" for an empty station; Markdown cells escaped', () => {
    const rows = stationRows(r.yields)!;
    expect(rows[0]).toEqual(['Step', 'Station', 'Units', 'First pass', 'FPY', 'Fails', 'Retests', 'Records']);
    expect(rows[1]).toEqual(['A', 'M1', '2', '1', '50.0%', '1', '1', '3']);
    expect(rows.at(-1)).toEqual(['C', '(none)', '1', '1', '100.0%', '0', '0', '1']);
    expect(textReport(r, 50)).toMatch(/^A\s+M2\s+1\s+0\s+0\.0%\s+2\s+2\s+3$/m);
    const p = check(ROUTE, parseEvents(events('u1 A M|1 pass\nu1 C T1 pass'), { stationColumn: 'station' }));
    expect(mdReport(p)).toContain('| A | M\\|1 | 1 | 1 | 100.0% | 0 | 0 | 1 |');
  });
  it('station column but no records at route steps: table says so', () => {
    const q = check(ROUTE, parseEvents('serial,step,station\nu1,X,M1\n', { stationColumn: 'station' }));
    expect(q.yields.every((y) => y.stations!.length === 0)).toBe(true);
    expect(textReport(q, 50)).toContain('Yield per station (');
    expect(textReport(q, 50)).toMatch(/Yield per station[^\n]*\nNo records at route steps\./);
    expect(mdReport(q)).toContain('## Yield per station');
  });
  it('no station tables without a station column', () => {
    const q = check(ROUTE, parseEvents(log));
    expect(stationRows(q.yields)).toBeUndefined();
    expect(textReport(q, 50)).not.toContain('Yield per station');
    expect(mdReport(q)).not.toContain('Yield per station');
  });
});

describe('routes per part with stations', () => {
  const routes = parseRoutes('part,step\nP1,A\nP1,B\nP2,A\n');
  const log = events(
    `
    u1 P1 A M1 pass
    u1 P1 B M3 pass
    u2 P2 A M2 fail
    u2 P2 A M2 pass
  `,
    'serial,part,step,station,result',
  );
  const r = checkParts(routes.parts!, parseEvents(log, { stationColumn: 'station' }));
  it('each part has its own station breakdown', () => {
    expect(r.parts!.map((p) => p.yields.map((y) => y.stations!.map((s) => `${s.station}:${s.units}/${s.records}`)))).toEqual([
      [['M1:1/1'], ['M3:1/1']],
      [['M2:1/2']],
    ]);
    const t = textReport(r, 50);
    expect(t.match(/Yield per station/g)).toHaveLength(2);
    expect(mdReport(r).match(/### Yield per station/g)).toHaveLength(2);
  });
});

describe('cli --station-column', () => {
  it('goldens: example text / JSON / Markdown', () => {
    expect(run([...S, '--station-column', 'station']).out).toBe(golden('stations.txt'));
    expect(run([...S, '--station-column', 'station', '--json']).out).toBe(golden('stations.json'));
    expect(run([...S, '--station-column', 'station', '--md']).out).toBe(golden('stations.md'));
  });
  it('byte-identical to the previous release without the flag (goldens from a main build), exit 1', () => {
    const t = run(S);
    expect(t.code).toBe(1);
    expect(t.out).toBe(golden('stations-off.txt'));
    expect(run([...S, '--json']).out).toBe(golden('stations-off.json'));
  });
  it('example: FCT-B is the weak tester', () => {
    const d = JSON.parse(run([...S, '--station-column', 'station', '--json']).out);
    const fct = d.yields.find((y: { step: string }) => y.step === 'FCT');
    expect(fct.stations).toEqual([
      { station: 'FCT-A', units: 6, firstPass: 6, fpy: 1, records: 9, fails: 0 },
      { station: 'FCT-B', units: 6, firstPass: 2, fpy: 2 / 6, records: 6, fails: 4 },
    ]);
  });
  it('works with --by-day (period tables unchanged, station table overall)', () => {
    const withS = run([...S, '--station-column', 'station', '--by-day']).out;
    const without = run([...S, '--by-day']).out;
    expect(withS).toContain('FPY by day');
    expect(withS).toContain('Yield per station');
    expect(withS.replace(/\n\nYield per station[^\n]*\n(?:[^\n]+\n)+/, '\n')).toBe(without);
  });
  it('input errors (exit 2): --csv with the flag, missing column', () => {
    const c = run([...S, '--station-column', 'station', '--csv']);
    expect(c.code).toBe(2);
    expect(c.err).toContain('--csv lists findings only; for yield per station');
    const dir = mkdtempSync(join(tmpdir(), 'route-check-stations-'));
    const f = join(dir, 'e.csv');
    writeFileSync(f, 'serial,step\nu1,SMT\n');
    const m = run([S[0], f, '--station-column', 'station']);
    expect(m.code).toBe(2);
    expect(m.err).toContain('no "station" column');
  });
  it('--help documents the flag', () => {
    expect(run(['--help']).out).toContain('--station-column <name>');
  });
});
