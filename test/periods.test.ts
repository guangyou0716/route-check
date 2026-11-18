import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { InputError } from '../src/errors.js';
import { parseEvents, parseRoute, parseRoutes } from '../src/input.js';
import { makePeriods, parseShifts } from '../src/periods.js';
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

const tmp = () => mkdtempSync(join(tmpdir(), 'route-check-periods-'));
const golden = (name: string) => readFileSync(join(root, 'test', 'golden', name), 'utf8');
const ROUTE = parseRoute('step,optional\nA,\nB,y\nC,\n');

/** events: "timestamp(date_time) serial step result" per line; '_' in the stamp becomes a space. */
function events(lines: string) {
  const csv =
    'timestamp,serial,step,result\n' +
    lines
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).join(',').replace('_', ' '))
      .join('\n') +
    '\n';
  return parseEvents(csv);
}

const bucketOf = (settings: object, stamp: string, first = stamp) =>
  makePeriods(settings, events(`${first} U A pass\n${stamp} U A pass`))!.bucket(parseEvents(`timestamp,serial,step\n${stamp.replace('_', ' ')},U,A\n`).events[0].time!);

describe('parseShifts', () => {
  it('sorts by start time', () => {
    expect(parseShifts('Night=19:00, Day=7:00')).toEqual([
      { name: 'Day', startMin: 420 },
      { name: 'Night', startMin: 1140 },
    ]);
  });
  it.each([
    ['Day', 'is not name=HH:MM'],
    ['=07:00', 'is not name=HH:MM'],
    ['Day=7', 'is not a time of day'],
    ['Day=24:00', 'is not a time of day'],
    ['Day=07:00,day=19:00', 'names shift "day" twice'],
    ['A=07:00,B=07:00', '"A" and "B" both start at 07:00'],
  ])('%s -> input error', (spec, msg) => {
    expect(() => parseShifts(spec)).toThrow(InputError);
    expect(() => parseShifts(spec)).toThrow(msg);
  });
});

describe('makePeriods', () => {
  it('no flags: undefined', () => {
    expect(makePeriods({}, events('2026-11-10_08:00 U A pass'))).toBeUndefined();
  });
  it('day: midnight start; a record exactly on the start belongs to the new day', () => {
    expect(bucketOf({ byDay: true }, '2026-11-10_23:59:59').period).toBe('2026-11-10');
    expect(bucketOf({ byDay: true }, '2026-11-11_00:00').period).toBe('2026-11-11');
  });
  it('day with --day-start 07:00: early hours count on the day before', () => {
    expect(bucketOf({ byDay: true, dayStart: '07:00' }, '2026-11-11_06:59').day).toBe('2026-11-10');
    expect(bucketOf({ byDay: true, dayStart: '07:00' }, '2026-11-11_07:00').day).toBe('2026-11-11');
  });
  it('shift: a night shift wraps midnight; before the first shift of the day = last shift', () => {
    const s = { shifts: 'Day=07:00,Night=19:00' };
    expect(bucketOf(s, '2026-11-10_07:00')).toEqual({ key: 0, period: 'Day', shift: 'Day' });
    expect(bucketOf(s, '2026-11-10_18:59:59').shift).toBe('Day');
    expect(bucketOf(s, '2026-11-10_19:00').shift).toBe('Night');
    expect(bucketOf(s, '2026-11-11_03:00').shift).toBe('Night');
  });
  it('day and shift: a shift crossing midnight counts on the day it starts', () => {
    const s = { byDay: true, shifts: 'A=07:00,B=15:00,C=23:00' };
    expect(bucketOf(s, '2026-11-10_23:30').period).toBe('2026-11-10 C');
    expect(bucketOf(s, '2026-11-11_06:59').period).toBe('2026-11-10 C');
    expect(bucketOf(s, '2026-11-11_07:00').period).toBe('2026-11-11 A');
    expect(bucketOf(s, '2026-11-11_00:00')).toMatchObject({ day: '2026-11-10', shift: 'C' });
    // Keys order periods by time.
    expect(bucketOf(s, '2026-11-10_23:30').key).toBeLessThan(bucketOf(s, '2026-11-11_07:00').key);
  });
  it('zoned timestamps: boundaries in the first row\'s offset unless --day-offset', () => {
    // 2026-11-10 23:30Z is 2026-11-11 07:30 at +08:00.
    expect(bucketOf({ byDay: true }, '2026-11-10T23:30:00Z').day).toBe('2026-11-10');
    expect(bucketOf({ byDay: true }, '2026-11-10T23:30:00Z', '2026-11-10T08:00:00+08:00').day).toBe('2026-11-11');
    expect(bucketOf({ byDay: true, dayOffset: '+08:00' }, '2026-11-10T23:30:00Z').day).toBe('2026-11-11');
    expect(bucketOf({ byDay: true, dayOffset: '-0500' }, '2026-11-11T03:00:00Z').day).toBe('2026-11-10');
  });
  it('info', () => {
    const e = events('2026-11-10T08:00+08:00 U A pass');
    expect(makePeriods({ byDay: true, dayStart: '6:30' }, e)!.info).toEqual({ by: 'day', dayStart: '06:30', offset: '+08:00', shifts: null });
    expect(makePeriods({ byDay: true, shifts: 'N=19:00,D=07:00' }, events('2026-11-10_08:00 U A pass'))!.info).toEqual({
      by: 'day-shift',
      dayStart: null,
      offset: null,
      shifts: [
        { name: 'D', start: '07:00', end: '19:00' },
        { name: 'N', start: '19:00', end: '07:00' },
      ],
    });
    expect(makePeriods({ shifts: 'Only=06:00' }, e)!.info.shifts).toEqual([{ name: 'Only', start: '06:00', end: '06:00' }]);
  });
  it.each([
    [{ dayStart: '07:00' }, '--day-start and --day-offset need --by-day'],
    [{ dayOffset: '+08:00' }, '--day-start and --day-offset need --by-day'],
    [{ shifts: 'D=07:00', dayStart: '07:00' }, '--day-start needs --by-day'],
    [{ byDay: true, shifts: 'D=07:00', dayStart: '07:00' }, '--day-start does not apply with --shifts'],
    [{ byDay: true, dayStart: '7am' }, '--day-start "7am" is not a time of day'],
    [{ byDay: true, dayOffset: '+08:00' }, '--day-offset is only for timestamps that carry a zone offset'],
  ])('input error %#', (settings, msg) => {
    expect(() => makePeriods(settings, events('2026-11-10_08:00 U A pass'))).toThrow(msg);
  });
  it('bad --day-offset on zoned timestamps', () => {
    expect(() => makePeriods({ byDay: true, dayOffset: '8' }, events('2026-11-10T08:00Z U A pass'))).toThrow('--day-offset "8" is not a zone offset');
  });
  it('needs a timestamp column', () => {
    expect(() => makePeriods({ byDay: true }, parseEvents('serial,step\nU,A\n'))).toThrow('--by-day / --shifts need a timestamp column');
  });
});

describe('check with periods', () => {
  const log = `
    2026-11-10_08:00 U1 A pass
    2026-11-10_08:10 U1 B fail
    2026-11-10_09:00 U2 A fail
    2026-11-10_20:00 U1 B pass
    2026-11-10_20:10 U1 C pass
    2026-11-11_02:00 U2 A pass
    2026-11-11_02:30 U2 C fail
    2026-11-11_08:00 U2 C pass
    2026-11-11_08:30 U3 A pass
  `;
  it('only the first record at a step counts, in the period of its timestamp', () => {
    const r = check(ROUTE, events(log), { byDay: true });
    expect(r.periodSettings).toEqual({ by: 'day', dayStart: '00:00', offset: null, shifts: null });
    expect(r.periods).toEqual([
      {
        period: '2026-11-10',
        day: '2026-11-10',
        units: 2,
        steps: [
          { step: 'A', optional: false, units: 2, firstPass: 1, fpy: 0.5 },
          { step: 'B', optional: true, units: 1, firstPass: 0, fpy: 0 },
          { step: 'C', optional: false, units: 1, firstPass: 1, fpy: 1 },
        ],
        rty: 0.5, // optional B left out of RTY
      },
      {
        period: '2026-11-11',
        day: '2026-11-11',
        // U2's retests at A and C are not first records; U2's first C record (02:30) is, U3's A is.
        units: 2,
        steps: [
          { step: 'A', optional: false, units: 1, firstPass: 1, fpy: 1 },
          { step: 'B', optional: true, units: 0, firstPass: 0, fpy: null },
          { step: 'C', optional: false, units: 1, firstPass: 0, fpy: 0 },
        ],
        rty: 0,
      },
    ]);
    // Per-period first records add up to the overall per-step units / first pass.
    for (const [k, y] of r.yields.entries()) {
      expect(r.periods!.reduce((a, p) => a + p.steps[k].units, 0)).toBe(y.units);
      expect(r.periods!.reduce((a, p) => a + p.steps[k].firstPass, 0)).toBe(y.firstPass);
    }
  });
  it('day and shift: night records after midnight count on the day before', () => {
    const r = check(ROUTE, events(log), { byDay: true, shifts: 'Day=07:00,Night=19:00' });
    expect(r.periods!.map((p) => [p.period, p.units, p.steps.map((s) => `${s.firstPass}/${s.units}`).join(' ')])).toEqual([
      ['2026-11-10 Day', 2, '1/2 0/1 0/0'],
      ['2026-11-10 Night', 2, '0/0 0/0 1/2'],
      ['2026-11-11 Day', 1, '1/1 0/0 0/0'],
    ]);
  });
  it('shift: summed over every day, in shift order', () => {
    const r = check(ROUTE, events(log), { shifts: 'Night=19:00,Day=07:00' });
    expect(r.periods!.map((p) => [p.period, p.shift, p.day, p.units])).toEqual([
      ['Day', 'Day', undefined, 3],
      ['Night', 'Night', undefined, 2],
    ]);
  });
  it('without flags: no period keys in the report', () => {
    const r = check(ROUTE, events(log));
    expect('periods' in r).toBe(false);
    expect('periodSettings' in r).toBe(false);
  });
  it('findings and the rest of the report are unchanged by the flags', () => {
    const plain = check(ROUTE, events(log));
    const { periods, periodSettings, ...rest } = check(ROUTE, events(log), { byDay: true, shifts: 'D=07:00' });
    expect(periods).toBeDefined();
    expect(periodSettings).toBeDefined();
    expect(rest).toEqual(plain);
  });
  it('routes per part: periods per part, top-level periods empty', () => {
    const routes = parseRoutes('part,step\nP1,A\nP1,B\nP2,A\n').parts!;
    const ev = parseEvents(
      'timestamp,serial,part,step,result\n2026-11-10 08:00,U1,P1,A,pass\n2026-11-10 08:05,U1,P1,B,fail\n2026-11-11 08:00,U2,P2,A,pass\n2026-11-11 09:00,U3,P9,A,pass\n',
    );
    const r = checkParts(routes, ev, { byDay: true });
    expect(r.periods).toEqual([]);
    expect(r.periodSettings?.by).toBe('day');
    expect(r.parts!.map((p) => p.periods!.map((x) => `${x.period} ${x.rty}`))).toEqual([['2026-11-10 0'], ['2026-11-11 1']]);
  });
  it('routes per part: --by-day needs timestamps', () => {
    const routes = parseRoutes('part,step\nP1,A\n').parts!;
    expect(() => checkParts(routes, parseEvents('serial,part,step\nU1,P1,A\n'), { shifts: 'D=07:00' })).toThrow('need a timestamp column');
  });
});

describe('cli --by-day / --shifts', () => {
  const sh = [ex('shifts/route.csv'), ex('shifts/events.csv'), '--rework-steps', 'repair'];
  it('text: FPY by day and shift table', () => {
    const r = run([...sh, '--by-day', '--shifts', 'Day=07:00,Night=19:00']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('FPY by day and shift (Day 07:00-19:00, Night 19:00-07:00; a shift counts on the day it starts;');
    expect(r.out).toMatch(/2026-11-12 Day\s+5\s+5\/5 100\.0%\s+4\/5 80\.0%\s+4\/5 80\.0%\s+4\/4 100\.0%\s+64\.0%/);
    expect(r.out).toMatch(/2026-11-12 Night\s+5\s+4\/4 100\.0%\s+3\/4 75\.0%\s+2\/4 50\.0%\s+4\/4 100\.0%\s+37\.5%/);
    expect(r.out).toMatch(/2026-11-13 Day\s+4\s+3\/3 100\.0%\s+3\/3 100\.0%\s+2\/3 66\.7%\s+4\/4 100\.0%\s+66\.7%/);
    expect(r.out).not.toContain('2026-11-13 Night');
  });
  it('text: by day and by shift', () => {
    expect(run([...sh, '--by-day']).out).toMatch(/2026-11-13\s+6\s+5\/5 100\.0%\s+4\/5 80\.0%\s+3\/5 60\.0%\s+6\/6 100\.0%\s+48\.0%/);
    expect(run([...sh, '--by-day', '--day-start', '07:00']).out).toContain('FPY by day (day starts 07:00;');
    const s = run([...sh, '--shifts', 'Day=07:00,Night=19:00']).out;
    expect(s).toContain('each shift summed over every day');
    expect(s).toMatch(/Night\s+5\s+4\/4 100\.0%\s+3\/4 75\.0%\s+2\/4 50\.0%\s+4\/4 100\.0%\s+37\.5%/);
  });
  it('json: periodSettings and periods; md: section', () => {
    const d = JSON.parse(run([...sh, '--shifts', 'Day=07:00,Night=19:00', '--json']).out);
    expect(d.periodSettings.by).toBe('shift');
    expect(d.periods.map((p: { period: string }) => p.period)).toEqual(['Day', 'Night']);
    const md = run([...sh, '--by-day', '--md']).out;
    expect(md).toContain('## FPY by day\n\nday starts 00:00;');
    expect(md).toContain('| Day | Units | SMT | ICT | FCT | PACK | RTY |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    expect(md).toContain('| 2026-11-12 | 7 | 7/7 100.0% | 6/7 85.7% | 5/7 71.4% | 6/6 100.0% | 61.2% |');
  });
  it('parts: a table per part (text and md)', () => {
    const p = [ex('parts/route.csv'), ex('parts/events.csv'), '--rework-steps', 'repair', '--by-day'];
    const t = run(p).out;
    expect(t.match(/FPY by day \(/g)).toHaveLength(2);
    expect(t).toMatch(/2026-11-11\s+5\s+5\/5 100\.0%/);
    expect(run([...p, '--md']).out.match(/### FPY by day/g)).toHaveLength(2);
  });
  it('md escapes pipes in shift names', () => {
    expect(run([...sh, '--shifts', 'A|1=07:00', '--md']).out).toContain('| A\\|1 |');
  });
  it('empty events file with --by-day: no rows', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'e.csv'), 'timestamp,serial,step\n');
    expect(run([ex('shifts/route.csv'), join(dir, 'e.csv'), '--by-day']).out).toContain('No records at route steps.');
  });
  it.each([
    [[ex('route.csv'), ex('events.csv'), '--by-day', '--time-column', 'when'], 'events: no "when" column'],
    [[ex('parts/route.csv'), ex('parts/events.csv'), '--by-day', '--csv'], '--csv lists findings only'],
    [[...sh, '--shifts', 'Day', '--json'], '--shifts: "Day" is not name=HH:MM'],
    [[...sh, '--day-start', '07:00'], '--day-start and --day-offset need --by-day'],
    [[...sh, '--by-day', '--shifts', 'D=07:00', '--day-start', '07:00'], '--day-start does not apply with --shifts'],
    [[...sh, '--by-day', '--day-offset', '+08:00'], '--day-offset is only for timestamps that carry a zone offset'],
  ])('input error %#', (args, msg) => {
    const r = run(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });
  it('no timestamp column -> exit 2', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'e.csv'), 'serial,step,result\nU1,SMT,pass\n');
    const r = run([ex('shifts/route.csv'), join(dir, 'e.csv'), '--shifts', 'D=07:00']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--by-day / --shifts need a timestamp column in the events file');
  });
  it('help lists the flags', () => {
    const h = run(['--help']).out;
    for (const f of ['--by-day', '--day-start', '--shifts <name=HH:MM,...>', '--day-offset']) expect(h).toContain(f);
  });
});

describe('output without the new flags is unchanged (regression)', () => {
  const parts = [ex('parts/route.csv'), ex('parts/events.csv'), '--rework-steps', 'repair', '--max-fails', '1', '--complete'];
  it.each([
    ['parts.txt', []],
    ['parts.json', ['--json']],
    ['parts.md', ['--md']],
    ['parts.csv', ['--csv']],
  ])('%s byte-identical to the pre-period output', (name, flags) => {
    expect(run([...parts, ...(flags as string[])]).out).toBe(golden(name));
  });
  it('shifts example byte-identical without flags', () => {
    const sh = [ex('shifts/route.csv'), ex('shifts/events.csv'), '--rework-steps', 'repair'];
    expect(run(sh).out).toBe(golden('shifts.txt'));
    expect(run([...sh, '--json']).out).toBe(golden('shifts.json'));
  });
});
