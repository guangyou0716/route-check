import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { listFlag, parseEvents, parseRoute, parseStamp } from '../src/input.js';

describe('parseRoute', () => {
  it('reads steps in order with optional flags', () => {
    expect(parseRoute('Step,Optional\nSMT,\nBURNIN,yes\nPACK,no\n')).toEqual([
      { name: 'SMT', optional: false, row: 2 },
      { name: 'BURNIN', optional: true, row: 3 },
      { name: 'PACK', optional: false, row: 4 },
    ]);
  });
  it('custom columns', () => {
    expect(parseRoute('op,skip\nA,0\nB,1\n', { stepColumn: 'op', optionalColumn: 'skip' }).map((s) => s.optional)).toEqual([false, true]);
  });
  it.each([
    ['', 'empty'],
    ['name\nA\n', 'no "step" column'],
    ['step\n', 'no steps'],
    ['step\nA\na\n', 'already on the route (row 2)'],
    ['step,optional\n,y\n', 'step name is empty'],
    ['step,optional\nA,maybe\n', 'optional must be'],
    ['step,optional\nA,y\n', 'every step is optional'],
  ])('rejects %j', (csv, msg) => {
    expect(() => parseRoute(csv)).toThrow(InputError);
    expect(() => parseRoute(csv)).toThrow(msg);
  });
});

describe('parseEvents', () => {
  it('result words', () => {
    const e = parseEvents('serial,step,result\nU1,A,PASS\nU1,B,ng\nU1,C,OK\nU1,D,0\n');
    expect(e.events.map((x) => x.pass)).toEqual([true, false, true, false]);
    expect(e).toMatchObject({ hasResult: true, timeOrdered: false });
  });
  it('no result column: every record is a pass', () => {
    const e = parseEvents('serial,step\nU1,A\n');
    expect(e.events[0]).toEqual({ serial: 'U1', step: 'A', pass: true, row: 2 });
    expect(e.hasResult).toBe(false);
  });
  it('custom columns', () => {
    const e = parseEvents('sn,station,verdict,ts\nU1,A,fail,2026-11-10T08:00:00Z\n', {
      serialColumn: 'sn',
      stepColumn: 'station',
      resultColumn: 'verdict',
      timeColumn: 'ts',
    });
    expect(e.events[0]).toMatchObject({ serial: 'U1', step: 'A', pass: false, time: Date.UTC(2026, 10, 10, 8) });
  });
  it('stable sort by time', () => {
    const e = parseEvents('serial,step,timestamp\nU1,B,2026-11-10 08:01\nU2,A,2026-11-10 08:00\nU1,A,2026-11-10 08:00\n');
    expect(e.events.map((x) => x.row)).toEqual([3, 4, 2]);
  });
  it.each([
    ['serial,step,result\nU1,A,maybe\n', 'is not a pass word'],
    ['serial,step,result\nU1,A,\n', 'is not a pass word'],
    ['serial,step\n,A\n', 'serial is empty'],
    ['serial,step\nU1,\n', 'step is empty'],
    ['serial\nU1\n', 'no "step" column'],
    ['serial,step,timestamp\nU1,A,\n', 'no timestamp'],
    ['serial,step,timestamp\nU1,A,yesterday\n', 'is not a date and time'],
    ['serial,step,timestamp\nU1,A,2026-11-10 08:00+08:00\nU1,B,2026-11-10 09:00\n', 'use one style'],
  ])('rejects %j', (csv, msg) => {
    expect(() => parseEvents(csv)).toThrow(msg);
  });
  it('a named column that is missing is an error', () => {
    expect(() => parseEvents('serial,step\nU1,A\n', { resultColumn: 'verdict' })).toThrow('no "verdict" column');
  });
});

describe('parseStamp / listFlag', () => {
  it('zones and invalid dates', () => {
    expect(parseStamp('2026-11-10 08:00+08:00')).toEqual({ ms: Date.UTC(2026, 10, 10, 0), zoned: true });
    expect(parseStamp('2026-11-10 08:00:30.5')).toEqual({ ms: Date.UTC(2026, 10, 10, 8, 0, 30, 500), zoned: false });
    expect(parseStamp('2026-02-30 08:00')).toBeUndefined();
    expect(parseStamp('2026-11-10')).toBeUndefined();
  });
  it('listFlag', () => {
    expect(listFlag(' repair, ,debug ')).toEqual(['repair', 'debug']);
    expect(listFlag(undefined)).toEqual([]);
  });
});
