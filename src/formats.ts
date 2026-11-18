import type { PeriodYield } from './periods.js';
import { pct, periodRows, periodTitle, STATION_DETAIL, stationRows, TITLES } from './report.js';
import { type Finding, KINDS, type Report, type StepYield, type Summary } from './route.js';

/**
 * One CSV cell (RFC 4180): quoted when it holds a quote, comma or line break. Cells starting with = + - @ tab or CR
 * get a leading ' so spreadsheets do not run them as formulas.
 */
export function csvCell(v: string | number | undefined): string {
  let s = v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: (string | number | undefined)[]) => cells.map(csvCell).join(',');

/** Markdown table / list text: backslashes and pipes escaped, line breaks flattened. */
export const mdCell = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');

export const CSV_HEADER = ['kind', 'serial', 'step', 'reached_step', 'count', 'serials', 'steps', 'rows', 'detail'];
/** CSV header with routes per part: a part column after kind. */
export const CSV_PART_HEADER = ['kind', 'part', 'serial', 'step', 'reached_step', 'count', 'serials', 'steps', 'rows', 'detail'];

const byKind = (findings: Finding[]) => [...findings].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));

/**
 * Findings as CSV, one row per finding (all of them, --limit is ignored), in the text report's kind order. Lists
 * inside a cell (rows, steps) are space separated. No findings = header only. With routes per part the second
 * column is the part (CSV_PART_HEADER).
 */
export function csvReport(report: Report): string {
  const parts = report.parts !== undefined;
  const lines = [csvLine(parts ? CSV_PART_HEADER : CSV_HEADER)];
  for (const f of byKind(report.findings)) {
    const rest = [f.serial, f.step, f.reachedStep, f.count, f.serials, f.steps?.join(' '), f.rows.join(' '), f.message];
    lines.push(csvLine(parts ? [f.kind, f.part, ...rest] : [f.kind, ...rest]));
  }
  return lines.join('\n') + '\n';
}

const ffp = (s: Summary) => `${s.finishedFirstPass}${s.finished ? ` (${pct(s.finishedFirstPass / s.finished)})` : ''}`;

function mdYield(yields: StepYield[]): string[] {
  return [
    '| step | units | first pass | FPY | passed (final) | fails | retests | records |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...yields.map(
      (y) =>
        `| ${mdCell(y.step)}${y.optional ? ' (optional)' : ''} | ${y.units} | ${y.firstPass} | ${pct(y.fpy)} | ${y.passed} | ${y.fails} | ${y.records - y.units} | ${y.records} |`,
    ),
  ];
}

/** Yield-per-station section (station column only); `level` is the heading prefix. */
function mdStations(yields: StepYield[], level: string): string[] {
  const rows = stationRows(yields);
  if (!rows) return [];
  const out = ['', `${level} Yield per station`, '', `${mdCell(STATION_DETAIL[0].toUpperCase() + STATION_DETAIL.slice(1))}.`, ''];
  if (rows.length === 1) return [...out, 'No records at route steps.'];
  const [head, ...body] = rows;
  return [
    ...out,
    `| ${head.map((h) => mdCell(h.toLowerCase())).join(' | ')} |`,
    `| --- | --- | ${head.slice(2).map(() => '---:').join(' | ')} |`,
    ...body.map((r) => `| ${r.map(mdCell).join(' | ')} |`),
  ];
}

/** FPY-per-period section (byDay / shifts only); `level` is the heading prefix. */
function mdPeriods(report: Report, periods: PeriodYield[] | undefined, yields: StepYield[], level: string): string[] {
  const info = report.periodSettings;
  if (!info || !periods) return [];
  const t = periodTitle(info);
  const out = ['', `${level} ${t.name}`, '', `${mdCell(t.detail)}.`, ''];
  if (!periods.length) return [...out, 'No records at route steps.'];
  const [head, ...rows] = periodRows(info, periods, yields);
  return [
    ...out,
    `| ${head.map(mdCell).join(' | ')} |`,
    `| --- | ${head.slice(1).map(() => '---:').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`),
  ];
}

/** Markdown summary and per-step yield (single route). */
function mdSingle(report: Report): string[] {
  const s = report.summary;
  return [
    '# Route check',
    '',
    '| serials | records | route steps | required | finished | finished first pass | WIP | RTY |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.serials} | ${s.events} | ${s.steps} | ${s.requiredSteps} | ${s.finished} | ${ffp(s)} | ${s.wip} | ${pct(s.rty)} |`,
    '',
    `Order: ${s.timeOrdered ? 'replayed by timestamp' : 'file order'}.${s.hasResult ? '' : ' No result column: every record counts as a pass.'}` +
      `${s.reworkEvents ? ` Rework records: ${s.reworkEvents}.` : ''}${s.unknownEvents ? ` Records at steps not on the route: ${s.unknownEvents}.` : ''}`,
    '',
    '## Yield per step',
    '',
    ...mdYield(report.yields),
    ...mdStations(report.yields, '##'),
    ...mdPeriods(report, report.periods, report.yields, '##'),
  ];
}

/** Markdown summary and per-part sections (routes per part). */
function mdParts(report: Report): string[] {
  const s = report.summary;
  const out = [
    '# Route check',
    '',
    '| serials | records | part routes | finished | finished first pass | WIP | serials of parts without a route |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.serials} | ${s.events} | ${s.parts} | ${s.finished} | ${ffp(s)} | ${s.wip} | ${s.unknownPartSerials} |`,
    '',
    `Order: ${s.timeOrdered ? 'replayed by timestamp' : 'file order'}.${s.hasResult ? '' : ' No result column: every record counts as a pass.'}` +
      `${s.reworkEvents ? ` Rework records: ${s.reworkEvents}.` : ''}${s.unknownEvents ? ` Records at steps not on the route: ${s.unknownEvents}.` : ''}` +
      `${s.unknownPartEvents ? ` Records of parts without a route: ${s.unknownPartEvents}.` : ''}`,
  ];
  for (const p of report.parts!) {
    const ps = p.summary;
    out.push(
      '',
      `## Part ${mdCell(p.part)}`,
      '',
      '| serials | records | route steps | required | finished | finished first pass | WIP | RTY |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      `| ${ps.serials} | ${ps.events} | ${ps.steps} | ${ps.requiredSteps} | ${ps.finished} | ${ffp(ps)} | ${ps.wip} | ${pct(ps.rty)} |`,
      '',
      ...mdYield(p.yields),
      ...mdStations(p.yields, '###'),
      ...mdPeriods(report, p.periods, p.yields, '###'),
    );
  }
  return out;
}

/** Markdown report: summary, per-step yield table, findings per kind (each list capped at `limit`). */
export function mdReport(report: Report, limit = 50): string {
  const out = report.parts ? mdParts(report) : mdSingle(report);
  out.push('', 'Retests = records after each unit\'s first record at the step. RTY = product of FPY over required steps.');
  if (!report.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `## Findings: ${report.findings.length}`, '', '| kind | count |', '| --- | ---: |');
  for (const kind of KINDS) {
    const n = report.findings.filter((f) => f.kind === kind).length;
    if (n) out.push(`| ${kind} | ${n} |`);
  }
  for (const kind of KINDS) {
    const list = report.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `### ${mdCell(TITLES[kind])}: ${list.length}`, '');
    for (const f of list.slice(0, limit)) out.push(`- ${mdCell(f.message)}`);
    if (list.length > limit) out.push(`- ... ${list.length - limit} more (use --json or --csv for all, or a higher --limit)`);
  }
  return out.join('\n') + '\n';
}
