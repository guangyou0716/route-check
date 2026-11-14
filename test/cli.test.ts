import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { ex } from './helpers.js';

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

const base = [ex('route.csv'), ex('events.csv'), '--rework-steps', 'repair'];

describe('cli', () => {
  it('example: 5 findings, exit 1', () => {
    const r = run(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('route-check: 10 serials, 80 records, 8 route steps (7 required), replayed by timestamp');
    expect(r.out).toContain('Finished: 9 (first pass 4, 44.4%), WIP: 1, RTY: 59.3%, rework records: 5');
    expect(r.out).toMatch(/FCT\s+9\s+6\s+66\.7%\s+7\s+14\s+6/);
    expect(r.out).toContain('MTR-0003 ran ICT (row 10) but never passed AOI');
    expect(r.out).toContain('MTR-0005 ran CALIB (row 33) before passing FLASH (passed later, row 38)');
    expect(r.out).toContain('MTR-0004 failed FCT (row 37) and ran PACK (row 43) without passing FCT again');
    expect(r.out).toContain('MTR-0007 passed PACK (row 60) but its latest result at FCT is fail (row 64)');
    expect(r.out).toContain('step "XRAY" is not on the route');
  });
  it('json with --max-fails and --complete', () => {
    const r = run([...base, '--max-fails', '2', '--complete', '--json']);
    const d = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(d.counts).toEqual({
      'skipped-step': 1,
      'out-of-order': 1,
      'continued-after-fail': 1,
      'failed-after-later-step': 1,
      'too-many-fails': 1,
      incomplete: 4,
      'unknown-step': 1,
    });
    expect(d.summary).toMatchObject({ serials: 10, events: 80, finished: 9, wip: 1, finishedFirstPass: 4, reworkEvents: 5, unknownEvents: 1 });
    expect(d.summary.rty).toBeCloseTo(16 / 27, 10);
    expect(d.yields).toHaveLength(8);
  });
  it('--limit trims the text list', () => {
    const r = run([...base, '--complete', '--limit', '1']);
    expect(r.out).toContain('... 3 more (use --json or a higher --limit)');
  });
  it('--rework-steps takes a list (last flag wins): XRAY allowed, 4 findings remain', () => {
    const r = run([...base, '--rework-steps', 'repair,xray', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).findings).toHaveLength(4);
    expect(r.out).not.toContain('XRAY');
  });
  it('no findings: exit 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-check-test-'));
    writeFileSync(join(dir, 'events.csv'), 'serial,step,result\nU1,SMT,pass\nU1,AOI,pass\nU2,SMT,ok\n');
    const r = run([ex('route.csv'), join(dir, 'events.csv')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Finished: 0 (first pass 0), WIP: 2, RTY: 100.0%');
    expect(r.out).toContain('No findings.');
  });
  it('help', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: route-check <route.csv> <events.csv>');
  });
  it.each([
    [[], 'missing the route CSV file'],
    [[ex('route.csv')], 'missing the events CSV file'],
    [[ex('route.csv'), ex('events.csv'), 'extra'], 'unexpected arguments: extra'],
    [[ex('route.csv'), '/nonexistent.csv'], 'cannot read events file'],
    [[...base, '--max-fails', '-1'], 'Option'],
    [[...base, '--max-fails', 'x'], '--max-fails must be a whole number from 0'],
    [[...base, '--limit', '0'], '--limit must be a whole number from 1'],
    [[ex('route.csv'), ex('events.csv'), '--rework-steps', ' , '], '--rework-steps is empty'],
    [[ex('route.csv'), ex('events.csv'), '--rework-steps', 'FCT'], 'is a route step'],
    [[...base, '--bogus'], "Unknown option '--bogus'"],
  ])('input error %j', (args, msg) => {
    const r = run(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });
});
