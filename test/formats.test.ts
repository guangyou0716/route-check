import { describe, expect, it } from 'vitest';
import { csvCell, csvReport, mdCell, mdReport } from '../src/formats.js';
import { parseEvents, parseRoute } from '../src/input.js';
import { check } from '../src/route.js';

const route = parseRoute('step\nSMT\nAOI\nFCT\n');
const report = (events: string, opts = {}) => check(route, parseEvents(events), opts);

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['cr\rhere', '"cr\rhere"'],
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@x', "'@x"],
    ['\tx', "'\tx"],
    ['\rx', '"\'\rx"'],
    ['=a,b', '"\'=a,b"'],
    ['a=b', 'a=b'],
  ])('%j -> %j', (v, want) => expect(csvCell(v)).toBe(want));
  it('numbers and empty', () => {
    expect(csvCell(3)).toBe('3');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('mdCell', () => {
  it('escapes pipes and backslashes, flattens line breaks', () => {
    expect(mdCell('a|b\\c\r\nd\ne')).toBe('a\\|b\\\\c d e');
  });
});

describe('csvReport', () => {
  it('header only when there are no findings', () => {
    expect(csvReport(report('serial,step\nU1,SMT\n'))).toBe('kind,serial,step,reached_step,count,serials,steps,rows,detail\n');
  });
  it('one row per finding in kind order, every finding, formula-guarded serials', () => {
    const r = report('serial,step,result\n=U1,FCT,pass\nU2,SMT,fail\nU2,AOI,pass\nU3,BAKE,pass\n', { complete: true });
    const lines = csvReport(r).trimEnd().split('\n');
    expect(lines[0]).toBe('kind,serial,step,reached_step,count,serials,steps,rows,detail');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual([
      'skipped-step',
      'skipped-step',
      'continued-after-fail',
      'incomplete',
      'incomplete',
      'incomplete',
      'unknown-step',
    ]);
    expect(lines[1]).toBe("skipped-step,'=U1,SMT,FCT,,,,2,'=U1 ran FCT (row 2) but never passed SMT");
    expect(lines).toContain('continued-after-fail,U2,SMT,AOI,,,,3 4,U2 failed SMT (row 3) and ran AOI (row 4) without passing SMT again');
    expect(lines).toContain('incomplete,U3,SMT,,,,SMT AOI FCT,,"U3 has not passed SMT, AOI, FCT"');
    expect(lines.at(-1)).toMatch(/^unknown-step,,BAKE,,1,1,,5,"step ""BAKE"" is not on the route/);
  });
});

describe('mdReport', () => {
  const r = report('serial,step,result\nU1,SMT,pass\nU1,AOI,fail\nU1,AOI,pass\nU1,FCT,pass\nU2,SMT,pass\nU2,FCT,pass\nU3,SMT,pass\nU3,FCT,pass\n');
  it('summary, yield table with retests, RTY, findings honouring limit', () => {
    const md = mdReport(r, 1);
    expect(md).toContain('# Route check');
    expect(md).toContain('| 3 | 8 | 3 | 3 | 3 | 2 (66.7%) | 0 | 0.0% |');
    expect(md).toContain('| step | units | first pass | FPY | passed (final) | fails | retests | records |');
    expect(md).toContain('| AOI | 1 | 0 | 0.0% | 1 | 1 | 1 | 2 |');
    expect(md).toContain('| SMT | 3 | 3 | 100.0% | 3 | 0 | 0 | 3 |');
    expect(md).toContain('## Findings: 2');
    expect(md).toContain('| skipped-step | 2 |');
    expect(md).toContain('- U2 ran FCT (row 7) but never passed AOI');
    expect(md).not.toContain('U3 ran FCT');
    expect(md).toContain('- ... 1 more (use --json or --csv for all, or a higher --limit)');
    expect(mdReport(r, 5)).toContain('- U3 ran FCT (row 9) but never passed AOI');
  });
  it('no findings; pipes in step names escaped; optional marked', () => {
    const md = mdReport(check(parseRoute('step,optional\nA|B,\nC,y\n'), parseEvents('serial,step\nU1,A|B\n')));
    expect(md).toContain('| A\\|B | 1 | 1 | 100.0% | 1 | 0 | 0 | 1 |');
    expect(md).toContain('| C (optional) | 0 | 0 | - |');
    expect(md).toContain('No findings.');
    expect(md).toContain('Order: file order. No result column: every record counts as a pass.');
  });
});
