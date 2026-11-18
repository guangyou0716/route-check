#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError } from './errors.js';
import { csvReport, mdReport } from './formats.js';
import { listFlag, parseEvents, parseRoutes } from './input.js';
import { jsonReport, textReport } from './report.js';
import { check, checkParts } from './route.js';

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

Routes per part number: give route.csv a "part" column (one route per part; a part's rows keep file order) and
events.csv a "part" column (every row needs one). Each serial is checked against the route of the part on its
first record; yield, RTY and finished / WIP are reported per part. Without a part column in route.csv there is
one route for every serial (a part column in events.csv is then ignored).

Findings (exit 1), per serial:
  skipped-step             reached a later step, never passed this required step
  out-of-order             reached a later step before passing this required step (passed it afterwards)
  continued-after-fail     ran a later step while its latest result at this step was fail
  failed-after-later-step  latest result at this step is fail, after it had already passed a later step
  too-many-fails           more fails at one step than --max-fails (opt-in)
  incomplete               has not passed every required step (opt-in, --complete)
and per step name: unknown-step (records at a step that is not on the route and not in --rework-steps).
Routes per part only: unknown-part (per part: serials whose part has no route; not checked, not in yield or WIP)
and part-conflict (per serial: records naming another part than its first record; checked as its first part).

Yield: units at each step, first pass (first record at the step is a pass), FPY, units whose latest record is a
pass, records, fails. RTY = product of FPY over required steps. Finished = latest record at the last required step
is a pass; WIP = the rest.

FPY per day / per shift (opt-in, needs a timestamp column): each unit's first record at a step counts in the day /
shift of its timestamp (that record decides first pass). Per period: units, first pass and FPY per step, and RTY
over required steps (per part with routes per part). Text, --json and --md only. A record exactly on a boundary
belongs to the period that starts there.

Yield per station (opt-in, --station-column): per step, units, first pass, FPY, fails, retests and records per
station (machine). Each unit's first record at a step counts for the station it ran on; later records at the step
are retests on whatever station they ran. Overall only (not per day / shift). Text, --json and --md only.

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
  --route-part-column <n>   route part number column (default part, optional; turns on routes per part)
  --part-column <name>      events part number column (default part; needed with routes per part)
  --station-column <name>   events station / machine column under a step (opt-in): yield per station
  --by-day                  FPY per day (with --shifts: per day and shift; a shift counts on the day it starts,
                            so a night shift's records after midnight count on the day before)
  --day-start <HH:MM>       time of day a day starts for --by-day (default 00:00; e.g. 07:00); not with --shifts
  --shifts <name=HH:MM,...> shift calendar, e.g. Day=07:00,Night=19:00: each shift lasts until the next starts;
                            FPY per shift, each shift summed over every day (with --by-day: per day and shift)
  --day-offset <+HH:MM>     zone offset for day and shift boundaries when the timestamps carry offsets
                            (default the offset on the first row)
  --json                    JSON report (summary, per-step yield, every finding)
  --md                      Markdown report (summary, per-step yield table, findings; lists capped by --limit)
  --csv                     CSV, one row per finding (every finding, --limit ignored), columns
                            kind,serial,step,reached_step,count,serials,steps,rows,detail
                            (routes per part: a part column after kind)
                            (pick one of --json, --md, --csv)
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
        'part-column': { type: 'string' },
        'route-part-column': { type: 'string' },
        'station-column': { type: 'string' },
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        csv: { type: 'boolean' },
        'by-day': { type: 'boolean' },
        'day-start': { type: 'string' },
        'day-offset': { type: 'string' },
        shifts: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if ([values.json, values.md, values.csv].filter(Boolean).length > 1) throw new InputError('pick one of --json, --md, --csv.');
    if (values.csv && (values['by-day'] || values.shifts !== undefined)) {
      throw new InputError('--csv lists findings only; for FPY per day / shift use the text report, --json or --md.');
    }
    if (values.csv && values['station-column'] !== undefined) {
      throw new InputError('--csv lists findings only; for yield per station use the text report, --json or --md.');
    }
    const [routeFile, eventsFile, ...rest] = positionals;
    if (routeFile === undefined) throw new InputError('missing the route CSV file; see --help.');
    if (eventsFile === undefined) throw new InputError('missing the events CSV file; see --help.');
    if (rest.length) throw new InputError(`unexpected arguments: ${rest.join(' ')}`);
    const routes = parseRoutes(read(routeFile, 'route'), {
      stepColumn: values['route-step-column'],
      optionalColumn: values['optional-column'],
      partColumn: values['route-part-column'],
    });
    if (!routes.parts && values['part-column'] !== undefined) {
      throw new InputError('--part-column needs routes per part: the route file has no part column (see --route-part-column).');
    }
    const events = parseEvents(read(eventsFile, 'events'), {
      serialColumn: values['serial-column'],
      stepColumn: values['step-column'],
      resultColumn: values['result-column'],
      timeColumn: values['time-column'],
      partColumn: values['part-column'],
      stationColumn: values['station-column'],
    });
    if (values['rework-steps'] !== undefined && !listFlag(values['rework-steps']).length) throw new InputError('--rework-steps is empty.');
    const options = {
      reworkSteps: listFlag(values['rework-steps']),
      maxFails: int(values['max-fails'], '--max-fails', undefined, 0, 1_000_000),
      complete: values.complete === true,
      byDay: values['by-day'] === true,
      dayStart: values['day-start'],
      dayOffset: values['day-offset'],
      shifts: values.shifts,
    };
    const report = routes.parts ? checkParts(routes.parts, events, options) : check(routes.steps, events, options);
    const limit = int(values.limit, '--limit', 50, 1, 1_000_000)!;
    process.stdout.write(
      values.json ? jsonReport(report) : values.md ? mdReport(report, limit) : values.csv ? csvReport(report) : textReport(report, limit),
    );
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
