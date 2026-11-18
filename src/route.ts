import { InputError } from './errors.js';
import { type Event, type Events, type PartRoute, type Step, stepKey } from './input.js';
import { type PeriodInfo, type Periods, type PeriodSettings, type PeriodYield, makePeriods } from './periods.js';

export type FindingKind =
  | 'skipped-step'
  | 'out-of-order'
  | 'continued-after-fail'
  | 'failed-after-later-step'
  | 'too-many-fails'
  | 'incomplete'
  | 'unknown-step'
  | 'unknown-part'
  | 'part-conflict';

export const KINDS: FindingKind[] = [
  'skipped-step',
  'out-of-order',
  'continued-after-fail',
  'failed-after-later-step',
  'too-many-fails',
  'incomplete',
  'unknown-step',
  'unknown-part',
  'part-conflict',
];

export interface Finding {
  kind: FindingKind;
  /** Unit serial (absent for unknown-step and unknown-part, which are one finding per step / part name). */
  serial?: string;
  /** Route step the finding is about (the skipped / failed / unknown step); absent for unknown-part and part-conflict. */
  step?: string;
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
  /**
   * Routes per part only: the part whose route the serial was checked against (unknown-part: the part without a
   * route; part-conflict: the serial's first part).
   */
  part?: string;
  /** part-conflict: every part seen for the serial, first one first. */
  parts?: string[];
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
  /** Routes per part only: number of part routes. */
  parts?: number;
  /** Routes per part only: serials / records whose part has no route (not checked, not in yield or WIP). */
  unknownPartSerials?: number;
  unknownPartEvents?: number;
}

/** Routes per part: one part's summary (steps, yield, finished / WIP, RTY) and per-step yield. */
export interface PartReport {
  part: string;
  summary: Summary;
  yields: StepYield[];
  /** With byDay / shifts: this part's FPY per period. */
  periods?: PeriodYield[];
}

export interface Report {
  /**
   * Routes per part: totals over all parts (steps / requiredSteps summed over the part routes, rty null - see
   * `parts` for each part's RTY; serials includes unknownPartSerials, wip does not).
   */
  summary: Summary;
  /** Per-step yield of the single route (empty with routes per part - see `parts`). */
  yields: StepYield[];
  findings: Finding[];
  counts: Partial<Record<FindingKind, number>>;
  /** Routes per part only, in route-file order. */
  parts?: PartReport[];
  /** With byDay / shifts only: how records were bucketed. */
  periodSettings?: PeriodInfo;
  /**
   * With byDay / shifts only: FPY per period, in time order (per shift: shift order), periods without records left
   * out. Empty with routes per part (see each part's `periods`).
   */
  periods?: PeriodYield[];
}

export interface CheckOptions extends PeriodSettings {
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
  time?: number;
}

const ROWS_SHOWN = 20;

export function check(route: Step[], input: Events, options: CheckOptions = {}): Report {
  const periods = makePeriods(options, input);
  const report = checkRoute(route, input, options, undefined, periods);
  if (periods) report.periodSettings = periods.info;
  return report;
}

function checkRoute(route: Step[], input: Events, options: CheckOptions, part?: string, periods?: Periods): Report {
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
      list.push({ idx, pass: e.pass, row: e.row, time: e.time });
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

  // Per-unit state, reused across units and reset for each one.
  const latest: (boolean | undefined)[] = new Array(n).fill(undefined);
  const latestRow: number[] = new Array(n).fill(0);
  const failCount: number[] = new Array(n).fill(0);
  const failRows: number[][] = Array.from({ length: n }, () => []);
  const missing: ({ reached: number; row: number } | undefined)[] = new Array(n).fill(undefined);
  const reportedFail: boolean[] = new Array(n).fill(false);

  // FPY per period: each unit's first record at a step counts in the period of its timestamp.
  const buckets = new Map<number, { label: ReturnType<Periods['bucket']>; units: number; firstPass: number[]; tried: number[] }>();
  const unitBuckets = new Set<number>();

  for (const [serial, list] of units) {
    latest.fill(undefined);
    failCount.fill(0);
    missing.fill(undefined);
    reportedFail.fill(false);
    for (const r of failRows) r.length = 0;
    unitBuckets.clear();
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
        if (periods) {
          const label = periods.bucket(ev.time!);
          let b = buckets.get(label.key);
          if (!b) buckets.set(label.key, (b = { label, units: 0, firstPass: new Array(n).fill(0), tried: new Array(n).fill(0) }));
          b.tried[k]++;
          if (ev.pass) b.firstPass[k]++;
          if (!unitBuckets.has(label.key)) {
            unitBuckets.add(label.key);
            b.units++;
          }
        }
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

  if (part !== undefined) {
    for (const f of findings) {
      f.part = part;
      f.message =
        f.kind === 'unknown-step'
          ? f.message.replace('is not on the route (', `is not on the route of part "${part}" (`).replace('add it to the route', "add it to the part's route")
          : `${f.message} (part ${part})`;
    }
  }
  const { ordered, counts } = byKind(findings);

  const report: Report = {
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
  if (periods) report.periods = periodYields(route, buckets);
  return report;
}

/** Per-period step yields and RTY, periods in key order (time order; per shift: shift order). */
function periodYields(
  route: Step[],
  buckets: Map<number, { label: ReturnType<Periods['bucket']>; units: number; firstPass: number[]; tried: number[] }>,
): PeriodYield[] {
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      let rty: number | null = null;
      const steps = route.map((s, k) => {
        const fpy = b.tried[k] ? b.firstPass[k] / b.tried[k] : null;
        if (!s.optional && fpy !== null) rty = (rty ?? 1) * fpy;
        return { step: s.name, optional: s.optional, units: b.tried[k], firstPass: b.firstPass[k], fpy };
      });
      const { period, day, shift } = b.label;
      const p: PeriodYield = { period, ...(day !== undefined && { day }), ...(shift !== undefined && { shift }), units: b.units, steps, rty };
      return p;
    });
}

/** Orders findings by kind (KINDS order), stable within a kind, and counts them. */
function byKind(findings: Finding[]): { ordered: Finding[]; counts: Partial<Record<FindingKind, number>> } {
  // Stable within a kind: serial first-seen order, then route order (routes per part: part order first).
  const rank = new Map(KINDS.map((k, i) => [k, i]));
  const ordered = findings.map((f, i) => ({ f, i })).sort((a, b) => rank.get(a.f.kind)! - rank.get(b.f.kind)! || a.i - b.i).map((x) => x.f);
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of ordered) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return { ordered, counts };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Routes per part number. Each serial's part is the part of its first record (in replay order); the serial is
 * checked against that part's route only. A serial with records naming another part gets a part-conflict finding
 * (it is still checked against its first part). Serials whose part has no route give one unknown-part finding per
 * part and are left out of yield, finished and WIP. Every event needs a part (input error otherwise).
 */
export function checkParts(parts: PartRoute[], input: Events, options: CheckOptions = {}): Report {
  if (!input.hasPart) throw new InputError('events: no part column (the route has one route per part, so every record needs a part number).');
  const routes = new Map(parts.map((p) => [stepKey(p.part), p]));
  for (const r of options.reworkSteps ?? []) {
    for (const p of parts) {
      if (p.steps.some((st) => stepKey(st.name) === stepKey(r))) {
        throw new InputError(`--rework-steps: "${r}" is a step on the route of part "${p.part}"; rework steps must be off every route.`);
      }
    }
  }

  const periods = makePeriods(options, input);
  const buckets = new Map<string, Event[]>(parts.map((p) => [stepKey(p.part), []]));
  const serialPart = new Map<string, string>();
  const conflicts = new Map<string, { parts: string[]; keys: Set<string>; rows: number[]; count: number }>();
  const unknown = new Map<string, { name: string; rows: number[]; count: number; serials: Set<string> }>();
  for (const e of input.events) {
    if (e.part === undefined) throw new InputError(`events row ${e.row}: part is empty (the route has one route per part, so every record needs one).`);
    const key = stepKey(e.part);
    let assigned = serialPart.get(e.serial);
    if (assigned === undefined) serialPart.set(e.serial, (assigned = key));
    else if (key !== assigned) {
      let c = conflicts.get(e.serial);
      if (!c) conflicts.set(e.serial, (c = { parts: [], keys: new Set(), rows: [], count: 0 }));
      c.count++;
      if (c.rows.length < ROWS_SHOWN) c.rows.push(e.row);
      if (!c.keys.has(key)) {
        c.keys.add(key);
        c.parts.push(e.part);
      }
    }
    const bucket = buckets.get(assigned);
    if (bucket) bucket.push(e);
    else {
      let u = unknown.get(assigned);
      if (!u) unknown.set(assigned, (u = { name: e.part, rows: [], count: 0, serials: new Set() }));
      u.count++;
      u.serials.add(e.serial);
      if (u.rows.length < ROWS_SHOWN) u.rows.push(e.row);
    }
  }

  const reports: PartReport[] = [];
  const findings: Finding[] = [];
  for (const p of parts) {
    const r = checkRoute(p.steps, { ...input, events: buckets.get(stepKey(p.part))! }, options, p.part, periods);
    const pr: PartReport = { part: p.part, summary: r.summary, yields: r.yields };
    if (periods) pr.periods = r.periods;
    reports.push(pr);
    findings.push(...r.findings);
  }
  for (const u of unknown.values()) {
    findings.push({
      kind: 'unknown-part',
      part: u.name,
      rows: u.rows,
      count: u.count,
      serials: u.serials.size,
      message: `part "${u.name}" has no route (${plural(u.serials.size, 'serial')}, ${plural(u.count, 'row')}, first row ${u.rows[0]}); add its steps to the route file`,
    });
  }
  for (const [serial, c] of conflicts) {
    const first = routes.get(serialPart.get(serial)!)?.part ?? unknown.get(serialPart.get(serial)!)!.name;
    findings.push({
      kind: 'part-conflict',
      serial,
      part: first,
      parts: [first, ...c.parts],
      rows: c.rows,
      count: c.count,
      message: `${serial} has records for part ${c.parts.join(', ')} (${plural(c.count, 'row')}, first row ${c.rows[0]}) but its first record is part ${first}; checked as ${first}`,
    });
  }
  const { ordered, counts } = byKind(findings);
  const sum = (f: (s: Summary) => number) => reports.reduce((a, r) => a + f(r.summary), 0);
  let unknownPartEvents = 0;
  let unknownPartSerials = 0;
  for (const u of unknown.values()) {
    unknownPartEvents += u.count;
    unknownPartSerials += u.serials.size;
  }
  const report: Report = {
    summary: {
      steps: sum((s) => s.steps),
      requiredSteps: sum((s) => s.requiredSteps),
      events: input.events.length,
      serials: serialPart.size,
      finished: sum((s) => s.finished),
      wip: sum((s) => s.wip),
      finishedFirstPass: sum((s) => s.finishedFirstPass),
      rty: null,
      reworkEvents: sum((s) => s.reworkEvents),
      unknownEvents: sum((s) => s.unknownEvents),
      timeOrdered: input.timeOrdered,
      hasResult: input.hasResult,
      parts: parts.length,
      unknownPartSerials,
      unknownPartEvents,
    },
    yields: [],
    findings: ordered,
    counts,
    parts: reports,
  };
  if (periods) {
    report.periodSettings = periods.info;
    report.periods = [];
  }
  return report;
}
