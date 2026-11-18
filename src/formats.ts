import { pct, TITLES } from './report.js';
import { type Finding, KINDS, type Report } from './route.js';

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

const byKind = (findings: Finding[]) => [...findings].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));

/**
 * Findings as CSV, one row per finding (all of them, --limit is ignored), in the text report's kind order. Lists
 * inside a cell (rows, steps) are space separated. No findings = header only.
 */
export function csvReport(report: Report): string {
  const lines = [csvLine(CSV_HEADER)];
  for (const f of byKind(report.findings)) {
    lines.push(csvLine([f.kind, f.serial, f.step, f.reachedStep, f.count, f.serials, f.steps?.join(' '), f.rows.join(' '), f.message]));
  }
  return lines.join('\n') + '\n';
}

/** Markdown report: summary, per-step yield table, findings per kind (each list capped at `limit`). */
export function mdReport(report: Report, limit = 50): string {
  const s = report.summary;
  const out = [
    '# Route check',
    '',
    '| serials | records | route steps | required | finished | finished first pass | WIP | RTY |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.serials} | ${s.events} | ${s.steps} | ${s.requiredSteps} | ${s.finished} | ${s.finishedFirstPass}${s.finished ? ` (${pct(s.finishedFirstPass / s.finished)})` : ''} | ${s.wip} | ${pct(s.rty)} |`,
    '',
    `Order: ${s.timeOrdered ? 'replayed by timestamp' : 'file order'}.${s.hasResult ? '' : ' No result column: every record counts as a pass.'}` +
      `${s.reworkEvents ? ` Rework records: ${s.reworkEvents}.` : ''}${s.unknownEvents ? ` Records at steps not on the route: ${s.unknownEvents}.` : ''}`,
    '',
    '## Yield per step',
    '',
    '| step | units | first pass | FPY | passed (final) | fails | retests | records |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const y of report.yields) {
    out.push(
      `| ${mdCell(y.step)}${y.optional ? ' (optional)' : ''} | ${y.units} | ${y.firstPass} | ${pct(y.fpy)} | ${y.passed} | ${y.fails} | ${y.records - y.units} | ${y.records} |`,
    );
  }
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
