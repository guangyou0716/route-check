import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { parseEvents, parseRoute } from '../src/input.js';
import { check, type CheckOptions } from '../src/route.js';

const ROUTE = parseRoute('step,optional\nA,\nB,\nC,y\nD,\n');

/** events: "serial step result" per line, file order. */
function run(lines: string, options: CheckOptions = {}, route = ROUTE) {
  const csv = 'serial,step,result\n' + lines.trim().split('\n').map((l) => l.trim().split(/\s+/).join(',')).join('\n') + '\n';
  return check(route, parseEvents(csv), options);
}

describe('check', () => {
  it('clean unit: no findings, finished, FPY 100%', () => {
    const r = run('U1 A pass\nU1 B pass\nU1 C pass\nU1 D pass');
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ serials: 1, finished: 1, wip: 0, finishedFirstPass: 1, rty: 1, events: 4 });
  });
  it('optional step may be skipped', () => {
    expect(run('U1 A pass\nU1 B pass\nU1 D pass').findings).toEqual([]);
  });
  it('skipped required step', () => {
    const r = run('U1 A pass\nU1 D pass');
    expect(r.counts).toEqual({ 'skipped-step': 1 });
    expect(r.findings[0]).toMatchObject({ serial: 'U1', step: 'B', reachedStep: 'D', rows: [3] });
  });
  it('out of order when the earlier step is passed afterwards', () => {
    const r = run('U1 A pass\nU1 D pass\nU1 B pass');
    expect(r.counts).toEqual({ 'out-of-order': 1 });
    expect(r.findings[0].message).toBe('U1 ran D (row 3) before passing B (passed later, row 4)');
  });
  it('skipped step reported once even when several later steps run', () => {
    const r = run('U1 A pass\nU1 C pass\nU1 D pass');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'skipped-step', step: 'B', reachedStep: 'C' });
  });
  it('continued after fail', () => {
    const r = run('U1 A pass\nU1 B fail\nU1 D pass');
    expect(r.counts).toEqual({ 'continued-after-fail': 1 });
    expect(r.findings[0]).toMatchObject({ step: 'B', reachedStep: 'D', rows: [3, 4] });
  });
  it('retest after fail is fine; going back to an earlier step is fine', () => {
    const r = run('U1 A pass\nU1 B pass\nU1 D fail\nU1 A pass\nU1 B pass\nU1 D pass');
    expect(r.findings).toEqual([]);
    expect(r.yields.find((y) => y.step === 'D')).toMatchObject({ units: 1, firstPass: 0, fpy: 0, passed: 1, records: 2, fails: 1 });
  });
  it('fail at the last step with no later record is not a finding (WIP)', () => {
    const r = run('U1 A pass\nU1 B pass\nU1 D fail');
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ finished: 0, wip: 1 });
  });
  it('failed after a later step', () => {
    const r = run('U1 A pass\nU1 B pass\nU1 D pass\nU1 B fail');
    expect(r.counts).toEqual({ 'failed-after-later-step': 1 });
    expect(r.findings[0]).toMatchObject({ step: 'B', reachedStep: 'D', rows: [5, 4] });
  });
  it('a pass after the re-run fail clears it', () => {
    expect(run('U1 A pass\nU1 B pass\nU1 D pass\nU1 B fail\nU1 B pass').findings).toEqual([]);
  });
  it('fail at an optional step then moving on is still continued-after-fail', () => {
    expect(run('U1 A pass\nU1 B pass\nU1 C fail\nU1 D pass').counts).toEqual({ 'continued-after-fail': 1 });
  });
  it('skipped then failed later: skipped-step (latest fail)', () => {
    const r = run('U1 A pass\nU1 D pass\nU1 B fail');
    expect(r.counts).toEqual({ 'skipped-step': 1 });
    expect(r.findings[0].message).toContain('never passed B (latest result fail)');
  });
  it('unknown step: one finding per step name; rework steps allowed', () => {
    const lines = 'U1 A pass\nU1 X pass\nU1 B fail\nU1 repair pass\nU1 B pass\nU1 D pass\nU2 x pass';
    const r = run(lines);
    expect(r.counts).toEqual({ 'unknown-step': 2 });
    expect(r.findings.find((f) => f.step === 'X')).toMatchObject({ count: 2, serials: 2, rows: [3, 8] });
    const ok = run(lines, { reworkSteps: ['REPAIR', 'x'] });
    expect(ok.findings).toEqual([]);
    expect(ok.summary).toMatchObject({ reworkEvents: 3, unknownEvents: 0 });
  });
  it('step names match without regard to case', () => {
    expect(run('U1 a pass\nU1 b PASS\nU1 d ok').findings).toEqual([]);
  });
  it('rework step that is on the route is an input error', () => {
    expect(() => run('U1 A pass', { reworkSteps: ['b'] })).toThrow(InputError);
  });
  it('--max-fails', () => {
    const lines = 'U1 A pass\nU1 B fail\nU1 B fail\nU1 B fail\nU1 B pass\nU1 D pass';
    expect(run(lines, { maxFails: 3 }).findings).toEqual([]);
    const r = run(lines, { maxFails: 2 });
    expect(r.counts).toEqual({ 'too-many-fails': 1 });
    expect(r.findings[0]).toMatchObject({ serial: 'U1', step: 'B', count: 3, rows: [3, 4, 5] });
    expect(run(lines, { maxFails: 0 }).findings[0].count).toBe(3);
  });
  it('--complete flags units without a pass at every required step', () => {
    const r = run('U1 A pass\nU1 B pass\nU1 D pass\nU2 A pass\nU3 A pass\nU3 B fail', { complete: true });
    expect(r.counts).toEqual({ incomplete: 2 });
    expect(r.findings.map((f) => [f.serial, f.steps])).toEqual([
      ['U2', ['B', 'D']],
      ['U3', ['B', 'D']],
    ]);
  });
  it('yield and RTY over required steps only', () => {
    const r = run('U1 A pass\nU1 B fail\nU1 B pass\nU1 C fail\nU1 C pass\nU1 D pass\nU2 A pass\nU2 B pass\nU2 D pass');
    const b = r.yields.find((y) => y.step === 'B')!;
    expect(b).toMatchObject({ units: 2, firstPass: 1, fpy: 0.5, passed: 2, records: 3, fails: 1 });
    expect(r.yields.find((y) => y.step === 'C')).toMatchObject({ optional: true, fpy: 0 });
    expect(r.summary.rty).toBe(0.5);
    expect(r.summary).toMatchObject({ finished: 2, finishedFirstPass: 1 });
  });
  it('rty is null when no required step has units', () => {
    const r = run('U1 X pass');
    expect(r.summary.rty).toBeNull();
    expect(r.summary).toMatchObject({ serials: 1, wip: 1 });
  });
  it('findings are grouped by kind, serial order kept within a kind', () => {
    const r = run('U2 A pass\nU2 D pass\nU1 A pass\nU1 B fail\nU1 D pass\nU1 Z pass\nU3 D pass');
    expect(r.findings.map((f) => `${f.kind}:${f.serial ?? f.step}:${f.step}`)).toEqual([
      'skipped-step:U2:B',
      'skipped-step:U3:A',
      'skipped-step:U3:B',
      'continued-after-fail:U1:B',
      'unknown-step:Z:Z',
    ]);
  });
  it('timestamps replay records by time', () => {
    const csv = 'serial,step,timestamp\nU1,D,2026-11-10 09:00\nU1,A,2026-11-10 08:00\nU1,B,2026-11-10 08:30\n';
    const r = check(ROUTE, parseEvents(csv));
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ timeOrdered: true, hasResult: false, finished: 1 });
  });
});
