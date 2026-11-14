#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError } from './errors.js';
import { listFlag, parseEvents, parseRoute } from './input.js';
import { jsonReport, textReport } from './report.js';
import { check } from './route.js';

const USAGE = `Usage: route-check <route.csv> <events.csv> [options]

Audits a station pass/fail log, as exported from an MES or test stations, against the production route: which
serials skipped a required step, ran steps out of order, or moved on after a fail. Also reports first-pass yield
(FPY) per step and rolled throughput yield (RTY). Offline; reads local files only.

route.csv:  header "step" (optional "optional" column, y/n). One row per step, in route order.
events.csv: header "serial,step" plus optional "result" (pass / fail; pass, ok, p, good, 1 / fail, ng, f, nok, 0)
            and optional "timestamp". No result column = a move-only log (every record counts as a pass). With a
            timestamp column every row needs one (one style: all with or all without a zone) and records are
            replayed by time (equal times keep file order); otherwise file order is used.
Step names match without regard to case. A unit may go back to an earlier step (e.g. re-flash after a test fail).

Findings (exit 1), per serial:
  skipped-step             reached a later step, never passed this required step
  out-of-order             reached a later step before passing this required step (passed it afterwards)
  continued-after-fail     ran a later step while its latest result at this step was fail
  failed-after-later-step  latest result at this step is fail, after it had already passed a later step
  too-many-fails           more fails at one step than --max-fails (opt-in)
  incomplete               has not passed every required step (opt-in, --complete)
and per step name: unknown-step (records at a step that is not on the route and not in --rework-steps).

Yield: units at each step, first pass (first record at the step is a pass), FPY, units whose latest record is a
pass, records, fails. RTY = product of FPY over required steps. Finished = latest record at the last required step
is a pass; WIP = the rest.

Options:
  --rework-steps <a,b>      off-route stations allowed anywhere (repair, debug, ...); not findings
  --max-fails <n>           flag a serial with more than n fails at one step
  --complete                every unit should be finished: flag units that have not passed every required step
  --limit <n>               findings listed per kind in the text report (default 50)
  --serial-column <name>    events serial column (default serial)
  --step-column <name>      events step column (default step)
  --result-column <name>    events result column (default result, optional)
  --time-column <name>      events timestamp column (default timestamp, optional)
  --route-step-column <n>   route step column (default step)
  --optional-column <name>  route optional column (default optional, optional)
  --json                    JSON report (summary, per-step yield, every finding)
  -h, --help                show this help

Exit codes: 0 no findings, 1 findings, 2 input error.
`;

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${what} file ${path}: ${(e as Error).message}`);
  }
}

function int(v: string | undefined, flag: string, def: number | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new InputError(`${flag} must be a whole number from ${min} to ${max}.`);
  }
  return Number(v);
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'rework-steps': { type: 'string' },
        'max-fails': { type: 'string' },
        complete: { type: 'boolean' },
        limit: { type: 'string' },
        'serial-column': { type: 'string' },
        'step-column': { type: 'string' },
        'result-column': { type: 'string' },
        'time-column': { type: 'string' },
        'route-step-column': { type: 'string' },
        'optional-column': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const [routeFile, eventsFile, ...rest] = positionals;
    if (routeFile === undefined) throw new InputError('missing the route CSV file; see --help.');
    if (eventsFile === undefined) throw new InputError('missing the events CSV file; see --help.');
    if (rest.length) throw new InputError(`unexpected arguments: ${rest.join(' ')}`);
    const route = parseRoute(read(routeFile, 'route'), {
      stepColumn: values['route-step-column'],
      optionalColumn: values['optional-column'],
    });
    const events = parseEvents(read(eventsFile, 'events'), {
      serialColumn: values['serial-column'],
      stepColumn: values['step-column'],
      resultColumn: values['result-column'],
      timeColumn: values['time-column'],
    });
    if (values['rework-steps'] !== undefined && !listFlag(values['rework-steps']).length) throw new InputError('--rework-steps is empty.');
    const report = check(route, events, {
      reworkSteps: listFlag(values['rework-steps']),
      maxFails: int(values['max-fails'], '--max-fails', undefined, 0, 1_000_000),
      complete: values.complete === true,
    });
    const limit = int(values.limit, '--limit', 50, 1, 1_000_000)!;
    process.stdout.write(values.json ? jsonReport(report) : textReport(report, limit));
    return report.findings.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`route-check: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
