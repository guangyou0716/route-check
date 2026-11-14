import { InputError } from './errors.js';
import { type Events, type Step, stepKey } from './input.js';

export type FindingKind =
  | 'skipped-step'
  | 'out-of-order'
  | 'continued-after-fail'
  | 'failed-after-later-step'
  | 'too-many-fails'
  | 'incomplete'
  | 'unknown-step';

export const KINDS: FindingKind[] = [
  'skipped-step',
  'out-of-order',
  'continued-after-fail',
  'failed-after-later-step',
  'too-many-fails',
  'incomplete',
  'unknown-step',
];

export interface Finding {
  kind: FindingKind;
  /** Unit serial (absent for unknown-step, which is one finding per step name). */
  serial?: string;
  /** Route step the finding is about (the skipped / failed / unknown step). */
  step: string;
  /**
   * Later step the unit reached while `step` was not passed (skipped-step, out-of-order, continued-after-fail), or the
   * later step it had already passed when `step` was re-run and failed (failed-after-later-step).
   */
  reachedStep?: string;
  /**
   * Events rows: the row at the later step (skipped-step, out-of-order); fail row + later-step row
   * (continued-after-fail, failed-after-later-step); fail rows (too-many-fails, first 20); rows at the step
   * (unknown-step, first 20); none (incomplete).
   */
  rows: number[];
  /** too-many-fails: fail count at the step. unknown-step: number of rows. */
  count?: number;
  /** unknown-step: number of serials with rows at that step. */
  serials?: number;
  /** incomplete: required steps without a latest pass. */
  steps?: string[];
  message: string;
}

export interface StepYield {
  step: string;
  optional: boolean;
  /** Units with at least one record at the step. */
  units: number;
  /** Units whose first record at the step is a pass. */
  firstPass: number;
  /** firstPass / units (null when no units). */
  fpy: number | null;
  /** Units whose latest record at the step is a pass. */
  passed: number;
  /** Records at the step (tests incl. retests). */
  records: number;
  fails: number;
}

export interface Summary {
  steps: number;
  requiredSteps: number;
  events: number;
  serials: number;
  /** Units whose latest record at the last required step is a pass. */
  finished: number;
  wip: number;
  /** Finished units with no failed record at any route step. */
  finishedFirstPass: number;
  /** Product of FPY over required steps that have units (null when none). */
  rty: number | null;
  reworkEvents: number;
  unknownEvents: number;
  timeOrdered: boolean;
  hasResult: boolean;
}

export interface Report {
  summary: Summary;
  yields: StepYield[];
  findings: Finding[];
  counts: Partial<Record<FindingKind, number>>;
}

export interface CheckOptions {
  /** Off-route stations that are allowed anywhere (repair, debug, ...). */
  reworkSteps?: string[];
  /** Flag units with more than this many fails at one step. */
  maxFails?: number;
  /** Every unit should have finished: flag units that have not passed every required step. */
  complete?: boolean;
}

interface UnitEvent {
  idx: number;
  pass: boolean;
  row: number;
}

const ROWS_SHOWN = 20;

export function check(route: Step[], input: Events, options: CheckOptions = {}): Report {
  const index = new Map(route.map((s, i) => [stepKey(s.name), i]));
  const rework = new Set<string>();
  for (const r of options.reworkSteps ?? []) {
    if (index.has(stepKey(r))) throw new InputError(`--rework-steps: "${r}" is a route step; rework steps must be off the route.`);
    rework.add(stepKey(r));
  }
  const n = route.length;
  const required = route.map((s) => !s.optional);
  const lastRequired = required.lastIndexOf(true);

  // Group route events by serial (first-seen order); count rework / unknown rows.
  const units = new Map<string, UnitEvent[]>();
  const unknown = new Map<string, { name: string; rows: number[]; count: number; serials: Set<string> }>();
  let reworkEvents = 0;
  let unknownEvents = 0;
  for (const e of input.events) {
    let list = units.get(e.serial);
    if (!list) units.set(e.serial, (list = []));
    const key = stepKey(e.step);
    const idx = index.get(key);
    if (idx !== undefined) {
      list.push({ idx, pass: e.pass, row: e.row });
    } else if (rework.has(key)) {
      reworkEvents++;
    } else {
      unknownEvents++;
      let u = unknown.get(key);
      if (!u) unknown.set(key, (u = { name: e.step, rows: [], count: 0, serials: new Set() }));
      u.count++;
      u.serials.add(e.serial);
      if (u.rows.length < ROWS_SHOWN) u.rows.push(e.row);
    }
  }

  const yields: StepYield[] = route.map((s) => ({
    step: s.name,
    optional: s.optional,
    units: 0,
    firstPass: 0,
    fpy: null,
    passed: 0,
    records: 0,
    fails: 0,
  }));
  const findings: Finding[] = [];
  let finished = 0;
  let finishedFirstPass = 0;

  // Per-unit state, reused across units (reset via touched lists).
  const latest: (boolean | undefined)[] = new Array(n).fill(undefined);
  const latestRow: number[] = new Array(n).fill(0);
  const failCount: number[] = new Array(n).fill(0);
  const failRows: number[][] = Array.from({ length: n }, () => []);
  const missing: ({ reached: number; row: number } | undefined)[] = new Array(n).fill(undefined);
  const reportedFail: boolean[] = new Array(n).fill(false);

  for (const [serial, list] of units) {
    latest.fill(undefined);
    failCount.fill(0);
    missing.fill(undefined);
    reportedFail.fill(false);
    for (const r of failRows) r.length = 0;
    let anyFail = false;

    for (const ev of list) {
      const k = ev.idx;
      // Arriving at step k: every earlier required step should be passed, and no step before k should be failed.
      for (let j = 0; j < k; j++) {
        if (latest[j] === false) {
          if (!reportedFail[j]) {
            reportedFail[j] = true;
            findings.push({
              kind: 'continued-after-fail',
              serial,
              step: route[j].name,
              reachedStep: route[k].name,
              rows: [latestRow[j], ev.row],
              message: `${serial} failed ${route[j].name} (row ${latestRow[j]}) and ran ${route[k].name} (row ${ev.row}) without passing ${route[j].name} again`,
            });
          }
        } else if (latest[j] === undefined && required[j] && !missing[j]) {
          missing[j] = { reached: k, row: ev.row };
        }
      }
      const y = yields[k];
      if (latest[k] === undefined) {
        y.units++;
        if (ev.pass) y.firstPass++;
      }
      y.records++;
      if (!ev.pass) {
        y.fails++;
        failCount[k]++;
        if (failRows[k].length < ROWS_SHOWN) failRows[k].push(ev.row);
        anyFail = true;
      }
      latest[k] = ev.pass;
      latestRow[k] = ev.row;
    }

    for (let j = 0; j < n; j++) {
      if (latest[j] === true) yields[j].passed++;
      const m = missing[j];
      if (m) {
        const later = latest[j] === true;
        findings.push({
          kind: later ? 'out-of-order' : 'skipped-step',
          serial,
          step: route[j].name,
          reachedStep: route[m.reached].name,
          rows: [m.row],
          message: later
            ? `${serial} ran ${route[m.reached].name} (row ${m.row}) before passing ${route[j].name} (passed later, row ${latestRow[j]})`
            : `${serial} ran ${route[m.reached].name} (row ${m.row}) but never passed ${route[j].name}${latest[j] === false ? ' (latest result fail)' : ''}`,
        });
      }
      if (latest[j] === false && !reportedFail[j] && !m) {
        // Never moved on after this fail, but a later step had already been passed (re-test after finishing).
        // Not for a step already reported as skipped (its message says the latest result is fail).
        let k = n - 1;
        while (k > j && latest[k] !== true) k--;
        if (k > j) {
          findings.push({
            kind: 'failed-after-later-step',
            serial,
            step: route[j].name,
            reachedStep: route[k].name,
            rows: [latestRow[j], latestRow[k]],
            message: `${serial} passed ${route[k].name} (row ${latestRow[k]}) but its latest result at ${route[j].name} is fail (row ${latestRow[j]})`,
          });
        }
      }
      if (options.maxFails !== undefined && failCount[j] > options.maxFails) {
        findings.push({
          kind: 'too-many-fails',
          serial,
          step: route[j].name,
          rows: [...failRows[j]],
          count: failCount[j],
          message: `${serial} failed ${route[j].name} ${failCount[j]} times (limit ${options.maxFails})`,
        });
      }
    }

    const done = latest[lastRequired] === true;
    if (done) {
      finished++;
      if (!anyFail) finishedFirstPass++;
    }
    if (options.complete) {
      const open = route.filter((s, j) => required[j] && latest[j] !== true).map((s) => s.name);
      if (open.length) {
        findings.push({
          kind: 'incomplete',
          serial,
          step: open[0],
          steps: open,
          rows: [],
          message: `${serial} has not passed ${open.join(', ')}`,
        });
      }
    }
  }

  for (const u of unknown.values()) {
    findings.push({
      kind: 'unknown-step',
      step: u.name,
      rows: u.rows,
      count: u.count,
      serials: u.serials.size,
      message: `step "${u.name}" is not on the route (${u.count} row${u.count === 1 ? '' : 's'}, ${u.serials.size} serial${u.serials.size === 1 ? '' : 's'}, first row ${u.rows[0]}); add it to the route or to --rework-steps`,
    });
  }

  let rty: number | null = null;
  for (const y of yields) {
    y.fpy = y.units ? y.firstPass / y.units : null;
    if (!y.optional && y.fpy !== null) rty = (rty ?? 1) * y.fpy;
  }

  // Order: by kind (KINDS order), stable within a kind (serial first-seen order, then route order).
  const rank = new Map(KINDS.map((k, i) => [k, i]));
  const ordered = findings.map((f, i) => ({ f, i })).sort((a, b) => rank.get(a.f.kind)! - rank.get(b.f.kind)! || a.i - b.i).map((x) => x.f);
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of ordered) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  return {
    summary: {
      steps: n,
      requiredSteps: required.filter(Boolean).length,
      events: input.events.length,
      serials: units.size,
      finished,
      wip: units.size - finished,
      finishedFirstPass,
      rty,
      reworkEvents,
      unknownEvents,
      timeOrdered: input.timeOrdered,
      hasResult: input.hasResult,
    },
    yields,
    findings: ordered,
    counts,
  };
}
