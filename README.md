# route-check

Offline CLI that audits an MES station pass/fail log against the production route. It finds serials that
**skipped a required step**, ran steps **out of order**, or **moved on after a fail**, and reports **first-pass
yield (FPY)** per step and **rolled throughput yield (RTY)**.

Useful when route enforcement in the MES is off, bypassed (manual moves, offline stations, line-down
workarounds) or being commissioned, and you want to check what really happened from the exported log instead of
ad-hoc SQL or Excel. Reads local CSV files only; no network, no runtime dependencies.

## Install

```sh
npm ci
npm run build
node dist/cli.js --help
```

Node 20 or newer.

## Input

`route.csv` - one row per step, in route order; optional steps marked in an `optional` column (y/yes/true/1):

```csv
step,optional
SMT,
AOI,
ICT,
FLASH,
CALIB,
BURNIN,y
FCT,
PACK,
```

`events.csv` - one row per station record:

```csv
timestamp,serial,step,result
2026-11-10 08:00:00,MTR-0001,SMT,pass
2026-11-10 08:06:00,MTR-0001,AOI,pass
```

- `serial`, `step` required; `result` optional (pass, passed, ok, p, good, 1 / fail, failed, ng, nok, f, bad, 0).
  Without a result column every record counts as a pass (a move-only log).
- `timestamp` optional. With it, every row needs one (`YYYY-MM-DD HH:MM[:SS[.fff]]`, T or space, optional
  Z / +08:00 - all rows with a zone or all without) and records are replayed by time (equal times keep file
  order). Without it, file order is used.
- Column names are configurable (`--serial-column`, `--step-column`, `--result-column`, `--time-column`,
  `--route-step-column`, `--optional-column`). Step names match without regard to case.
- Off-route stations such as repair or debug go in `--rework-steps repair,debug`; their records are counted and
  otherwise ignored.

## What it checks

Records are replayed per serial. A unit may go back to an earlier step (e.g. re-flash after a functional test
fail); only reaching a **later** step matters.

| Finding | Meaning |
| --- | --- |
| `skipped-step` | Reached a later step but never passed this required step |
| `out-of-order` | Reached a later step before passing this required step (passed it afterwards) |
| `continued-after-fail` | Ran a later step while its latest result at this step was fail |
| `failed-after-later-step` | Latest result at this step is fail, after the unit had already passed a later step (e.g. a re-test after packing) |
| `too-many-fails` | More fails at one step than `--max-fails n` (opt-in) |
| `incomplete` | Has not passed every required step (opt-in, `--complete`, for a lot that should be finished) |
| `unknown-step` | Records at a step that is not on the route and not in `--rework-steps` (one finding per step name) |
| `unknown-part` | Routes per part only: serials whose part has no route (one finding per part) |
| `part-conflict` | Routes per part only: a serial with records naming more than one part (one finding per serial) |

Each kind is reported at most once per serial and step. A fail with no later record is work in progress, not a
finding. Optional steps may be skipped, but a fail at an
optional step followed by a later step is still `continued-after-fail`.

Yield per step: units with a record there, first pass (the unit's first record at the step is a pass), FPY,
units whose latest record is a pass, records and fails. RTY is the product of FPY over required steps that have
units. Finished = latest record at the last required step is a pass; WIP = the rest. "Finished first pass" =
finished units without any failed record at a route step (it does not look at skipped steps - those are
findings).

## Example

```sh
node dist/cli.js examples/route.csv examples/events.csv --rework-steps repair
```

```text
route-check: 10 serials, 80 records, 8 route steps (7 required), replayed by timestamp
Finished: 9 (first pass 4, 44.4%), WIP: 1, RTY: 59.3%, rework records: 5, records at steps not on the route: 1

Step               Units  First pass     FPY  Passed  Records  Fails
SMT                   10          10  100.0%      10       10      0
AOI                    9           9  100.0%       9        9      0
ICT                    9           8   88.9%       9       10      1
FLASH                  9           9  100.0%       9       10      0
CALIB                  9           9  100.0%       9       11      0
BURNIN (optional)      1           1  100.0%       1        1      0
FCT                    9           6   66.7%       7       14      6
PACK                   9           9  100.0%       9        9      0

Findings: 5

Skipped steps (a later step ran, this required step never passed): 1
  - MTR-0003 ran ICT (row 10) but never passed AOI

Out of order (a later step ran before this step was passed): 1
  - MTR-0005 ran CALIB (row 33) before passing FLASH (passed later, row 38)

Continued after fail (a later step ran while the latest result here was fail): 1
  - MTR-0004 failed FCT (row 37) and ran PACK (row 43) without passing FCT again

Failed after a later step (re-run failed after the unit had passed a later step): 1
  - MTR-0007 passed PACK (row 60) but its latest result at FCT is fail (row 64)

Steps not on the route: 1
  - step "XRAY" is not on the route (1 row, 1 serial, first row 48); add it to the route or to --rework-steps
```

Row numbers are CSV record numbers in the events file (header = 1). `--limit n` caps findings per kind in the text
and Markdown reports (default 50).

## Routes per part number

When a line builds several products, give `route.csv` a `part` column - one route per part number, a part's rows
in route order (parts may be interleaved) - and give `events.csv` a `part` column too (every row needs one):

```csv
part,step,optional
MTR-1P,SMT,
MTR-1P,AOI,
MTR-1P,ICT,
MTR-1P,FLASH,
MTR-1P,FCT,
MTR-1P,PACK,
MTR-3P,SMT,
...
MTR-3P,HIPOT,
MTR-3P,BURNIN,y
MTR-3P,FCT,
MTR-3P,PACK,
```

```csv
timestamp,serial,part,step,result
2026-11-11 08:01:00,U1P-001,MTR-1P,SMT,pass
```

- Each serial is checked against the route of the part on its **first** record (in replay order) - the part a unit
  is launched as. Part numbers match without regard to case.
- `part-conflict` (one per serial): the serial has records naming another part. It is still checked as its first
  part; the finding lists the other parts, the number of such rows and the first rows.
- `unknown-part` (one per part): serials whose part has no route in `route.csv`. They are not checked and are left
  out of yield, finished and WIP (counted separately as "serials of parts without a route").
- Yield (per-step FPY, RTY, finished / WIP) is reported **per part**; the top line gives totals (no overall RTY -
  RTY only makes sense per route). `unknown-step` is per part ("not on the route of part ...").
- `--rework-steps` apply to every part and must not be a step on any part's route.
- `--route-part-column` / `--part-column` rename the columns (default `part`). Without a part column in `route.csv`
  everything works as before - one route for every serial, a part column in `events.csv` is ignored, and the output
  is byte-for-byte the same.
- `--json` gains `parts` (per part: `part`, `summary`, `yields`), top-level `yields` is empty and `summary` holds
  totals plus `parts`, `unknownPartSerials`, `unknownPartEvents`; findings carry `part` (and `parts` for
  part-conflict). `--md` has a section per part. `--csv` gains a `part` column after `kind`.

```sh
node dist/cli.js examples/parts/route.csv examples/parts/events.csv --rework-steps repair
```

```text
route-check: 11 serials, 73 records, 2 part routes (15 steps, 14 required), replayed by timestamp
Finished: 9 (first pass 7, 77.8%), WIP: 1, rework records: 3, serials of parts without a route: 1 (2 records)

Part MTR-1P: 5 serials, 30 records, 6 route steps (6 required)
Finished: 4 (first pass 3, 75.0%), WIP: 1, RTY: 60.0%

Step   Units  First pass     FPY  Passed  Records  Fails
SMT        5           5  100.0%       5        5      0
AOI        5           5  100.0%       5        5      0
ICT        5           4   80.0%       4        5      1
FLASH      4           4  100.0%       4        4      0
FCT        4           3   75.0%       4        5      1
PACK       4           4  100.0%       4        4      0

Part MTR-3P: 5 serials, 41 records, 9 route steps (8 required)
Finished: 5 (first pass 4, 80.0%), WIP: 0, RTY: 80.0%

Step               Units  First pass     FPY  Passed  Records  Fails
SMT                    5           5  100.0%       5        5      0
AOI                    5           5  100.0%       5        5      0
ICT                    5           5  100.0%       5        5      0
FLASH                  5           5  100.0%       5        5      0
CALIB                  5           4   80.0%       5        6      1
HIPOT                  4           4  100.0%       4        4      0
BURNIN (optional)      0           0       -       0        0      0
FCT                    5           5  100.0%       5        5      0
PACK                   5           5  100.0%       5        5      0

Findings: 3

Skipped steps (a later step ran, this required step never passed): 1
  - U3P-002 ran FCT (row 45) but never passed HIPOT (part MTR-3P)

Parts without a route: 1
  - part "GW-4G" has no route (1 serial, 2 rows, first row 73); add its steps to the route file

Serials with records for more than one part: 1
  - U3P-005 has records for part MTR-1P (1 row, first row 72) but its first record is part MTR-3P; checked as MTR-3P
```

## FPY per day / per shift

First-pass yield drifts with the shift, the operator crew or the day's material lot, so a single FPY over a week
hides the bad night. With a `timestamp` column, opt-in flags add an FPY table per period (the same flag names and
shift syntax as [oee-log-check](https://github.com/guangyou0716/oee-log-check)):

- `--by-day` - one row per day. A day starts at `--day-start` (default 00:00; e.g. 07:00 when the first shift starts
  at 7) and is labelled with the date it starts on.
- `--shifts Day=07:00,Night=19:00` (or `A=07:00,B=15:00,C=23:00`) - a shift calendar: each shift starts at its time
  every day and lasts until the next one starts. Alone, one row per shift, **summed over every day**.
- `--by-day --shifts ...` - one row per day **and** shift. A shift counts on the day it **starts**, so a night shift's
  records after midnight count on the day before (`--day-start` does not apply here).

Each unit's **first** record at a step counts in the period of its timestamp - that record decides first pass. A
retest in a later shift is not counted again, so per-period units and first passes add up to the per-step yield
table. Per period: units (with a first record at some route step in the period), first pass / units and FPY per
step, and RTY over required steps that have units in the period. With routes per part number there is one table
per part. A record exactly on a boundary belongs to the period that starts there; periods without records are left
out. For timestamps with a zone offset, boundaries use the offset on the first row of the file unless
`--day-offset +08:00` is given (timestamps without a zone are taken as written).

Text, `--json` (`periodSettings`: `by` day / shift / day-shift, `dayStart`, `offset`, `shifts`; `periods`: per period
`period`, `day`, `shift`, `units`, `steps[]` with `units`, `firstPass`, `fpy`, and `rty`; with routes per part each
part has `periods` and the top-level list is empty) and `--md` (a section after the yield table). `--csv` stays
one row per finding, so it cannot be combined with these flags (exit 2). Without a timestamp column the flags are
an input error (exit 2). Without the flags the output is byte-for-byte the same as before. Period tables raise no
findings of their own.

`examples/shifts/` is made-up data: 12 boards over two days, Day 07:00-19:00 / Night 19:00-07:00. PCB-109 fails FCT
at 06:48 (Night) and passes the retest at 07:17 (Day) - the fail counts against the night shift of 2026-11-12.

```sh
node dist/cli.js examples/shifts/route.csv examples/shifts/events.csv --rework-steps repair --by-day --shifts Day=07:00,Night=19:00
```

```text
route-check: 12 serials, 62 records, 4 route steps (4 required), replayed by timestamp
Finished: 12 (first pass 6, 50.0%), WIP: 0, RTY: 55.6%, rework records: 7

Step  Units  First pass     FPY  Passed  Records  Fails
SMT      12          12  100.0%      12       12      0
ICT      12          10   83.3%      12       14      2
FCT      12           8   66.7%      12       17      5
PACK     12          12  100.0%      12       12      0

FPY by day and shift (Day 07:00-19:00, Night 19:00-07:00; a shift counts on the day it starts; each unit's first record at a step counts in the period of its timestamp; cells: first pass / units and FPY):
Day / shift       Units         SMT         ICT        FCT        PACK    RTY
2026-11-12 Day        5  5/5 100.0%   4/5 80.0%  4/5 80.0%  4/4 100.0%  64.0%
2026-11-12 Night      5  4/4 100.0%   3/4 75.0%  2/4 50.0%  4/4 100.0%  37.5%
2026-11-13 Day        4  3/3 100.0%  3/3 100.0%  2/3 66.7%  4/4 100.0%  66.7%

No findings.
```

## Output formats

`--json`, `--md` or `--csv`, one at a time (more than one is an input error, exit 2). Exit codes are the same for
every format.

- `--json`: summary, per-step yield and every finding with its rows (plus `periodSettings` / `periods` with
  `--by-day` / `--shifts`).
- `--md`: Markdown for a ticket or wiki page - summary table (serials, records, steps, finished, finished first
  pass, WIP, RTY), per-step yield table (units, first pass, FPY, passed (final), fails, retests, records; retests =
  records after each unit's first record at the step), finding counts per kind and the findings per kind (capped by
  `--limit`).
- `--csv`: one row per finding, every finding (`--limit` is ignored), in the text report's kind order; header only
  when there are none. Columns `kind,serial,step,reached_step,count,serials,steps,rows,detail`; `rows` and `steps`
  are space separated lists, `detail` is the text message. Cells are quoted per RFC 4180, and cells starting with
  `=`, `+`, `-`, `@`, tab or CR get a leading `'` so a spreadsheet does not run them as formulas.

```sh
node dist/cli.js examples/route.csv examples/events.csv --rework-steps repair --csv
```

```text
kind,serial,step,reached_step,count,serials,steps,rows,detail
skipped-step,MTR-0003,AOI,ICT,,,,10,MTR-0003 ran ICT (row 10) but never passed AOI
out-of-order,MTR-0005,FLASH,CALIB,,,,33,"MTR-0005 ran CALIB (row 33) before passing FLASH (passed later, row 38)"
continued-after-fail,MTR-0004,FCT,PACK,,,,37 43,MTR-0004 failed FCT (row 37) and ran PACK (row 43) without passing FCT again
failed-after-later-step,MTR-0007,FCT,PACK,,,,64 60,MTR-0007 passed PACK (row 60) but its latest result at FCT is fail (row 64)
unknown-step,,XRAY,,1,1,,48,"step ""XRAY"" is not on the route (1 row, 1 serial, first row 48); add it to the route or to --rework-steps"
```

Exit codes: 0 no findings, 1 findings, 2 input error.

## Library

```ts
import { check, checkParts, parseEvents, parseRoute, parseRoutes } from './dist/index.js';
const report = check(parseRoute(routeCsv), parseEvents(eventsCsv), { reworkSteps: ['REPAIR'], maxFails: 3 });
// Routes per part number:
const routes = parseRoutes(routeCsv); // routes.parts is set when the file has a part column
const byPart = routes.parts ? checkParts(routes.parts, parseEvents(eventsCsv)) : check(routes.steps, parseEvents(eventsCsv));
// FPY per day and shift (needs timestamps): report.periodSettings, report.periods (per part: parts[i].periods)
const daily = check(parseRoute(routeCsv), parseEvents(eventsCsv), { byDay: true, shifts: 'Day=07:00,Night=19:00' });
```

## Development

```sh
npm run check   # lint + typecheck + tests
npm run build && npm run smoke   # built CLI end to end, incl. 100,000 units / ~700,000 records
```

## Not yet

A station (machine) column under a step, dwell-time limits between steps.
