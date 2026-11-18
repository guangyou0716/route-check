import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { InputError } from '../src/errors.js';
import { parseEvents, parseRoutes } from '../src/input.js';
import { checkParts } from '../src/route.js';
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

const tmp = () => mkdtempSync(join(tmpdir(), 'route-check-parts-'));
const ROUTES = parseRoutes('part,step,optional\nP1,A,\nP1,B,\nP2,A,\nP2,X,\nP2,B,\nP2,C,y\n').parts!;

/** events: "serial part step result" per line, file order. */
function check(lines: string, options = {}) {
  const csv = 'serial,part,step,result\n' + lines.trim().split('\n').map((l) => l.trim().split(/\s+/).join(',')).join('\n') + '\n';
  return checkParts(ROUTES, parseEvents(csv), options);
}

describe('parseRoutes', () => {
  it('no part column: one route, parts undefined', () => {
    const r = parseRoutes('step\nA\nB\n');
    expect(r.parts).toBeUndefined();
    expect(r.steps.map((s) => s.name)).toEqual(['A', 'B']);
  });
  it('groups rows per part (interleaved, case-insensitive, first spelling kept)', () => {
    const r = parseRoutes('Part,Step,optional\nP1,A,\nP2,A,\np1,B,\nP2,C,y\nP2,D,\n');
    expect(r.parts!.map((p) => [p.part, p.steps.map((s) => `${s.name}@${s.row}${s.optional ? '?' : ''}`)])).toEqual([
      ['P1', ['A@2', 'B@4']],
      ['P2', ['A@3', 'C@5?', 'D@6']],
    ]);
    expect(r.steps.map((s) => s.row)).toEqual([2, 3, 4, 5, 6]);
  });
  it('same step on two parts is fine; twice on one part is an error', () => {
    expect(() => parseRoutes('part,step\nP1,A\nP1,a\n')).toThrow('step "a" is already on the route of part "P1" (row 2)');
  });
  it.each([
    ['part,step\nP1,A\n,B\n', {}, 'route row 3: part is empty'],
    ['part,step,optional\nP1,A,\nP2,B,y\n', {}, 'every step of part "P2" is optional'],
    ['part,step\n', {}, 'route: no steps'],
    ['step\nA\n', { partColumn: 'pn' }, 'route: no "pn" column'],
  ])('input error %#', (text, cols, msg) => {
    expect(() => parseRoutes(text, cols)).toThrow(InputError);
    expect(() => parseRoutes(text, cols)).toThrow(msg);
  });
  it('custom part column', () => {
    expect(parseRoutes('pn,step\nP1,A\n', { partColumn: 'PN' }).parts![0].part).toBe('P1');
  });
});

describe('parseEvents part column', () => {
  it('reads the part; empty cells left out; hasPart', () => {
    const e = parseEvents('serial,step,part\nU1,A,P1\nU1,B,\n');
    expect(e.hasPart).toBe(true);
    expect(e.events.map((x) => x.part)).toEqual(['P1', undefined]);
    expect(parseEvents('serial,step\nU1,A\n').hasPart).toBe(false);
    expect(() => parseEvents('serial,step\nU1,A\n', { partColumn: 'pn' })).toThrow('events: no "pn" column');
  });
});

describe('checkParts', () => {
  it('each serial is checked against its own part route; yield per part', () => {
    const r = check('U1 P1 A pass\nU1 P1 B pass\nU2 P2 A pass\nU2 P2 B pass\nU3 P2 A fail\nU3 P2 A pass\nU3 P2 X pass\nU3 P2 B pass');
    expect(r.counts).toEqual({ 'skipped-step': 1 });
    expect(r.findings[0]).toMatchObject({ serial: 'U2', part: 'P2', step: 'X', reachedStep: 'B', message: 'U2 ran B (row 5) but never passed X (part P2)' });
    expect(r.yields).toEqual([]);
    expect(r.parts!.map((p) => [p.part, p.summary.serials, p.summary.finished, p.summary.events, p.summary.rty])).toEqual([
      ['P1', 1, 1, 2, 1],
      ['P2', 2, 2, 6, 0.5],
    ]);
    expect(r.parts![1].yields.map((y) => [y.step, y.units, y.firstPass])).toEqual([
      ['A', 2, 1],
      ['X', 1, 1],
      ['B', 2, 2],
      ['C', 0, 0],
    ]);
    expect(r.summary).toMatchObject({ serials: 3, events: 8, finished: 3, wip: 0, finishedFirstPass: 2, rty: null, steps: 6, requiredSteps: 5, parts: 2 });
  });
  it('part matched without regard to case', () => {
    expect(check('U1 p1 A pass\nU1 P1 B pass').findings).toEqual([]);
  });
  it('unknown-part: one finding per part, serials left out of yield and WIP', () => {
    const r = check('U1 Q9 A pass\nU2 Q9 A pass\nU2 Q9 B pass\nU3 P1 A pass');
    expect(r.counts).toEqual({ 'unknown-part': 1 });
    expect(r.findings[0]).toMatchObject({ kind: 'unknown-part', part: 'Q9', count: 3, serials: 2, rows: [2, 3, 4] });
    expect(r.findings[0].message).toBe('part "Q9" has no route (2 serials, 3 rows, first row 2); add its steps to the route file');
    expect(r.summary).toMatchObject({ serials: 3, wip: 1, unknownPartSerials: 2, unknownPartEvents: 3 });
    expect(r.parts![0].summary.serials).toBe(1);
  });
  it('part-conflict: checked against the first part', () => {
    const r = check('U1 P1 A pass\nU1 P2 X pass\nU1 P2 B pass\nU1 P1 B pass');
    expect(r.counts).toEqual({ 'unknown-step': 1, 'part-conflict': 1 });
    const c = r.findings.find((f) => f.kind === 'part-conflict')!;
    expect(c).toMatchObject({ serial: 'U1', part: 'P1', parts: ['P1', 'P2'], count: 2, rows: [3, 4] });
    expect(c.message).toBe('U1 has records for part P2 (2 rows, first row 3) but its first record is part P1; checked as P1');
    const u = r.findings.find((f) => f.kind === 'unknown-step')!;
    expect(u.part).toBe('P1');
    expect(u.message).toContain('step "X" is not on the route of part "P1" (1 row');
    expect(u.message).toContain("add it to the part's route or to --rework-steps");
  });
  it('findings ordered by kind, then part order', () => {
    const r = check('U1 P2 B pass\nU2 P1 B pass\nU3 Q1 A pass');
    expect(r.findings.map((f) => `${f.kind}:${f.part}`)).toEqual(['skipped-step:P1', 'skipped-step:P2', 'skipped-step:P2', 'unknown-part:Q1']);
  });
  it.each([
    ['serial,step\nU1,A\n', {}, 'events: no part column'],
    ['serial,step,part\nU1,A,P1\nU1,B,\n', {}, 'events row 3: part is empty'],
    ['serial,step,part\nU1,A,P1\n', { reworkSteps: ['x'] }, '"x" is a step on the route of part "P2"'],
  ])('input error %#', (csv, options, msg) => {
    expect(() => checkParts(ROUTES, parseEvents(csv), options)).toThrow(InputError);
    expect(() => checkParts(ROUTES, parseEvents(csv), options)).toThrow(msg);
  });
});

const parts = [ex('parts/route.csv'), ex('parts/events.csv'), '--rework-steps', 'repair'];

describe('cli routes per part', () => {
  it('text: per-part yield tables and part findings', () => {
    const r = run(parts);
    expect(r.code).toBe(1);
    expect(r.out).toContain('route-check: 11 serials, 73 records, 2 part routes (15 steps, 14 required), replayed by timestamp');
    expect(r.out).toContain('Finished: 9 (first pass 7, 77.8%), WIP: 1, rework records: 3, serials of parts without a route: 1 (2 records)');
    expect(r.out).toContain('Part MTR-1P: 5 serials, 30 records, 6 route steps (6 required)\nFinished: 4 (first pass 3, 75.0%), WIP: 1, RTY: 60.0%');
    expect(r.out).toContain('Part MTR-3P: 5 serials, 41 records, 9 route steps (8 required)\nFinished: 5 (first pass 4, 80.0%), WIP: 0, RTY: 80.0%');
    expect(r.out).toMatch(/CALIB\s+5\s+4\s+80\.0%\s+5\s+6\s+1/);
    expect(r.out).toContain('U3P-002 ran FCT (row 45) but never passed HIPOT (part MTR-3P)');
    expect(r.out).toContain('part "GW-4G" has no route (1 serial, 2 rows, first row 73)');
    expect(r.out).toContain('U3P-005 has records for part MTR-1P (1 row, first row 72) but its first record is part MTR-3P; checked as MTR-3P');
  });
  it('json: parts array, empty top-level yields', () => {
    const d = JSON.parse(run([...parts, '--json']).out);
    expect(d.counts).toEqual({ 'skipped-step': 1, 'unknown-part': 1, 'part-conflict': 1 });
    expect(d.yields).toEqual([]);
    expect(d.parts.map((p: { part: string }) => p.part)).toEqual(['MTR-1P', 'MTR-3P']);
    expect(d.parts[0].summary.rty).toBeCloseTo(0.6, 10);
    expect(d.summary).toMatchObject({ serials: 11, finished: 9, wip: 1, parts: 2, unknownPartSerials: 1, unknownPartEvents: 2, rty: null });
  });
  it('md: a section per part', () => {
    const out = run([...parts, '--md']).out;
    expect(out).toContain('| 11 | 73 | 2 | 9 | 7 (77.8%) | 1 | 1 |');
    expect(out).toContain('## Part MTR-1P\n\n| serials | records | route steps | required | finished | finished first pass | WIP | RTY |');
    expect(out).toContain('| 5 | 41 | 9 | 8 | 5 | 4 (80.0%) | 0 | 80.0% |');
    expect(out).toContain('| CALIB | 5 | 4 | 80.0% | 5 | 1 | 1 | 6 |');
    expect(out).toContain('| unknown-part | 1 |');
    expect(out).toContain('Records of parts without a route: 2.');
  });
  it('csv: part column after kind', () => {
    const lines = run([...parts, '--csv']).out.trimEnd().split('\n');
    expect(lines[0]).toBe('kind,part,serial,step,reached_step,count,serials,steps,rows,detail');
    expect(lines[1]).toBe('skipped-step,MTR-3P,U3P-002,HIPOT,FCT,,,,45,U3P-002 ran FCT (row 45) but never passed HIPOT (part MTR-3P)');
    expect(lines[2]).toMatch(/^unknown-part,GW-4G,,,,2,1,,73 74,/);
    expect(lines[3]).toMatch(/^part-conflict,MTR-3P,U3P-005,,,1,,,72,/);
  });
  it('custom part columns', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'route.csv'), 'model,step\nM1,A\nM1,B\n');
    writeFileSync(join(dir, 'events.csv'), 'serial,pn,step\nU1,M1,A\nU1,M1,B\n');
    const r = run([join(dir, 'route.csv'), join(dir, 'events.csv'), '--route-part-column', 'model', '--part-column', 'pn']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Part M1: 1 serials, 2 records');
  });
  it.each([
    [[ex('route.csv'), ex('events.csv'), '--part-column', 'part'], '--part-column needs routes per part'],
    [[ex('parts/route.csv'), ex('events.csv')], 'events: no part column'],
    [[ex('route.csv'), ex('events.csv'), '--route-part-column', 'part'], 'route: no "part" column'],
    [[...parts, '--rework-steps', 'hipot'], '"hipot" is a step on the route of part "MTR-3P"'],
  ])('input error %#', (args, msg) => {
    const r = run(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });
});

describe('single route output is unchanged (regression)', () => {
  const single = [ex('route.csv'), ex('events.csv'), '--rework-steps', 'repair', '--max-fails', '2', '--complete'];
  const golden = (name: string) => readFileSync(join(root, 'test', 'golden', name), 'utf8');
  it.each([
    ['single.txt', []],
    ['single.json', ['--json']],
    ['single.md', ['--md']],
    ['single.csv', ['--csv']],
  ])('%s byte-identical to the pre-part output', (name, flags) => {
    expect(run([...single, ...(flags as string[])]).out).toBe(golden(name));
  });
  it('a part column in events.csv is ignored when route.csv has none', () => {
    const dir = tmp();
    const lines = readFileSync(ex('events.csv'), 'utf8').trimEnd().split('\n');
    writeFileSync(join(dir, 'events.csv'), lines.map((l, i) => `${l},${i ? 'P' + (i % 3) : 'part'}`).join('\n') + '\n');
    const args = [ex('route.csv'), join(dir, 'events.csv'), ...single.slice(2)];
    expect(run(args).out).toBe(golden('single.txt'));
    expect(run([...args, '--json']).out).toBe(golden('single.json'));
    expect(run([...args, '--csv']).out).toBe(golden('single.csv'));
  });
});
