import type { PeriodInfo, PeriodYield } from './periods.js';
import { type FindingKind, KINDS, type Report, type StepYield, type Summary } from './route.js';

export const TITLES: Record<FindingKind, string> = {
  'skipped-step': 'Skipped steps (a later step ran, this required step never passed)',
  'out-of-order': 'Out of order (a later step ran before this step was passed)',
  'continued-after-fail': 'Continued after fail (a later step ran while the latest result here was fail)',
  'failed-after-later-step': 'Failed after a later step (re-run failed after the unit had passed a later step)',
  'too-many-fails': 'Too many fails at one step (--max-fails)',
  incomplete: 'Incomplete units (--complete)',
  'unknown-step': 'Steps not on the route',
  'unknown-part': 'Parts without a route',
  'part-conflict': 'Serials with records for more than one part',
};

export const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);

function pad(rows: string[][]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  ').trimEnd()).join('\n');
}

export function yieldRows(report: Pick<Report, 'yields'>): string[][] {
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

/** Name and explanation of the FPY-per-period table. */
export function periodTitle(info: PeriodInfo): { name: string; detail: string } {
  const at = info.offset ? ` at ${info.offset}` : '';
  const shifts = (info.shifts ?? []).map((s) => `${s.name} ${s.start}-${s.end}`).join(', ');
  const [name, head] =
    info.by === 'day'
      ? ['FPY by day', `day starts ${info.dayStart}${at}`]
      : info.by === 'shift'
        ? ['FPY by shift', `${shifts}${at}; each shift summed over every day`]
        : ['FPY by day and shift', `${shifts}${at}; a shift counts on the day it starts`];
  return { name, detail: `${head}; each unit's first record at a step counts in the period of its timestamp; cells: first pass / units and FPY` };
}

/** FPY-per-period table: one row per period, one column per route step, then RTY. */
export function periodRows(info: PeriodInfo, periods: PeriodYield[], yields: StepYield[]): string[][] {
  const first = info.by === 'day' ? 'Day' : info.by === 'shift' ? 'Shift' : 'Day / shift';
  return [
    [first, 'Units', ...yields.map((y) => (y.optional ? `${y.step} (optional)` : y.step)), 'RTY'],
    ...periods.map((p) => [
      p.period,
      String(p.units),
      ...p.steps.map((st) => (st.units ? `${st.firstPass}/${st.units} ${pct(st.fpy)}` : '-')),
      pct(p.rty),
    ]),
  ];
}

function periodText(report: Report, periods: PeriodYield[] | undefined, yields: StepYield[], out: string[]): void {
  if (!report.periodSettings || !periods) return;
  const t = periodTitle(report.periodSettings);
  out.push('', `${t.name} (${t.detail}):`);
  out.push(periods.length ? pad(periodRows(report.periodSettings, periods, yields)) : 'No records at route steps.');
}

export function textReport(report: Report, limit: number): string {
  const s = report.summary;
  const out: string[] = [];
  if (report.parts) partsText(report, out);
  else {
    out.push(
      `route-check: ${s.serials} serials, ${s.events} records, ${s.steps} route steps (${s.requiredSteps} required)` +
        `${s.timeOrdered ? ', replayed by timestamp' : ', file order'}${s.hasResult ? '' : ', no result column (all records = pass)'}`,
    );
    out.push(
      `${finishedText(s)}, RTY: ${pct(s.rty)}` +
        `${s.reworkEvents ? `, rework records: ${s.reworkEvents}` : ''}${s.unknownEvents ? `, records at steps not on the route: ${s.unknownEvents}` : ''}`,
    );
    out.push('', pad(yieldRows(report)));
    periodText(report, report.periods, report.yields, out);
  }
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

const finishedText = (s: Summary) => `Finished: ${s.finished} (first pass ${s.finishedFirstPass}${s.finished ? `, ${pct(s.finishedFirstPass / s.finished)}` : ''}), WIP: ${s.wip}`;

/** Text summary and per-part yield tables (routes per part). */
function partsText(report: Report, out: string[]): void {
  const s = report.summary;
  out.push(
    `route-check: ${s.serials} serials, ${s.events} records, ${s.parts} part routes (${s.steps} steps, ${s.requiredSteps} required)` +
      `${s.timeOrdered ? ', replayed by timestamp' : ', file order'}${s.hasResult ? '' : ', no result column (all records = pass)'}`,
  );
  out.push(
    `${finishedText(s)}` +
      `${s.reworkEvents ? `, rework records: ${s.reworkEvents}` : ''}${s.unknownEvents ? `, records at steps not on the route: ${s.unknownEvents}` : ''}` +
      `${s.unknownPartSerials ? `, serials of parts without a route: ${s.unknownPartSerials} (${s.unknownPartEvents} records)` : ''}`,
  );
  for (const p of report.parts!) {
    const ps = p.summary;
    out.push(
      '',
      `Part ${p.part}: ${ps.serials} serials, ${ps.events} records, ${ps.steps} route steps (${ps.requiredSteps} required)`,
      `${finishedText(ps)}, RTY: ${pct(ps.rty)}`,
      '',
      pad(yieldRows(p)),
    );
    periodText(report, p.periods, p.yields, out);
  }
}

export function jsonReport(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}
