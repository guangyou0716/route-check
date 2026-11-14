import { type FindingKind, KINDS, type Report } from './route.js';

const TITLES: Record<FindingKind, string> = {
  'skipped-step': 'Skipped steps (a later step ran, this required step never passed)',
  'out-of-order': 'Out of order (a later step ran before this step was passed)',
  'continued-after-fail': 'Continued after fail (a later step ran while the latest result here was fail)',
  'failed-after-later-step': 'Failed after a later step (re-run failed after the unit had passed a later step)',
  'too-many-fails': 'Too many fails at one step (--max-fails)',
  incomplete: 'Incomplete units (--complete)',
  'unknown-step': 'Steps not on the route',
};

export const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);

function pad(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  ').trimEnd()).join('\n');
}

export function yieldRows(report: Report): string[][] {
  return [
    ['Step', 'Units', 'First pass', 'FPY', 'Passed', 'Records', 'Fails'],
    ...report.yields.map((y) => [
      y.optional ? `${y.step} (optional)` : y.step,
      String(y.units),
      String(y.firstPass),
      pct(y.fpy),
      String(y.passed),
      String(y.records),
      String(y.fails),
    ]),
  ];
}

export function textReport(report: Report, limit: number): string {
  const s = report.summary;
  const out: string[] = [];
  out.push(
    `route-check: ${s.serials} serials, ${s.events} records, ${s.steps} route steps (${s.requiredSteps} required)` +
      `${s.timeOrdered ? ', replayed by timestamp' : ', file order'}${s.hasResult ? '' : ', no result column (all records = pass)'}`,
  );
  out.push(
    `Finished: ${s.finished} (first pass ${s.finishedFirstPass}${s.finished ? `, ${pct(s.finishedFirstPass / s.finished)}` : ''}), WIP: ${s.wip}, RTY: ${pct(s.rty)}` +
      `${s.reworkEvents ? `, rework records: ${s.reworkEvents}` : ''}${s.unknownEvents ? `, records at steps not on the route: ${s.unknownEvents}` : ''}`,
  );
  out.push('', pad(yieldRows(report)));
  if (!report.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `Findings: ${report.findings.length}`);
  for (const kind of KINDS) {
    const list = report.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `${TITLES[kind]}: ${list.length}`);
    for (const f of list.slice(0, limit)) out.push(`  - ${f.message}`);
    if (list.length > limit) out.push(`  ... ${list.length - limit} more (use --json or a higher --limit)`);
  }
  return out.join('\n') + '\n';
}

export function jsonReport(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}
