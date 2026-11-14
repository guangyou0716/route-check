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

A fail with no later record is work in progress, not a finding. Optional steps may be skipped, but a fail at an
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

Row numbers are CSV record numbers in the events file (header = 1). `--json` gives the summary, per-step yield and
every finding with its rows; `--limit n` caps findings per kind in the text report (default 50).

Exit codes: 0 no findings, 1 findings, 2 input error.

## Library

```ts
import { check, parseEvents, parseRoute } from './dist/index.js';
const report = check(parseRoute(routeCsv), parseEvents(eventsCsv), { reworkSteps: ['REPAIR'], maxFails: 3 });
```

## Development

```sh
npm run check   # lint + typecheck + tests
npm run build && npm run smoke   # built CLI end to end, incl. 100,000 units / ~700,000 records
```

## Not yet

Markdown / CSV output, several routes by part number, FPY per day or shift, a station (machine) column under a
step, dwell-time limits between steps.
