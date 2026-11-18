import { parseCsv } from './csv.js';
import { InputError } from './errors.js';

/** One step of the production route, in order. */
export interface Step {
  name: string;
  optional: boolean;
  /** CSV record number (header = 1). */
  row: number;
}

/** One station pass / fail record for a unit. `row` is the CSV record number (header = 1). */
export interface Event {
  serial: string;
  step: string;
  pass: boolean;
  row: number;
  timestamp?: string;
  /** Part number (when the file has a part column and the cell is not empty). */
  part?: string;
  /** `timestamp` as milliseconds (zone-less stamps are compared as they are, like UTC). Set when the file has times. */
  time?: number;
}

export interface EventColumns {
  serialColumn?: string;
  stepColumn?: string;
  resultColumn?: string;
  timeColumn?: string;
  /** Part number column (default "part", optional unless given). */
  partColumn?: string;
}

export interface Events {
  events: Event[];
  /** True when the file had a result column (otherwise every row is a move / pass). */
  hasResult: boolean;
  /** True when rows were replayed by timestamp (otherwise file order). */
  timeOrdered: boolean;
  /** True when the file had a part column. */
  hasPart?: boolean;
}

/** The route of one part number (route.csv with a part column). */
export interface PartRoute {
  part: string;
  steps: Step[];
}

export interface RouteColumns {
  stepColumn?: string;
  optionalColumn?: string;
  /** Part number column (default "part", optional unless given); see parseRoutes. */
  partColumn?: string;
}

/** A route file: one route (`parts` undefined) or one route per part number. */
export interface Routes {
  /** Every step row of the file, in file order (the route itself when there is no part column). */
  steps: Step[];
  /** Routes per part number, in order of first appearance; set only when the file has a part column. */
  parts?: PartRoute[];
}

export const PASS_WORDS = new Set(['pass', 'passed', 'p', 'ok', 'good', 'g', 'y', 'yes', 'true', '1']);
export const FAIL_WORDS = new Set(['fail', 'failed', 'f', 'ng', 'nok', 'bad', 'n', 'no', 'false', '0']);
const YES_WORDS = new Set(['y', 'yes', 'true', '1', 'optional']);
const NO_WORDS = new Set(['', 'n', 'no', 'false', '0', 'required']);

interface Table {
  rows: { cells: string[]; row: number }[];
  index: (name: string, required: boolean, label: string) => number;
}

function table(text: string, what: string): Table {
  const records = parseCsv(text);
  if (records.length === 0) throw new InputError(`${what}: the file is empty.`);
  const header = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((cells, i) => ({ cells: cells.map((c) => c.trim()), row: i + 2 }));
  const index = (name: string, required: boolean, label: string) => {
    const i = header.indexOf(name.trim().toLowerCase());
    if (i < 0 && required) {
      throw new InputError(`${what}: no "${name}" column (${label}). Header: ${records[0].join(',')}`);
    }
    return i;
  };
  return { rows, index };
}

function cell(cells: string[], i: number): string {
  return i < 0 ? '' : (cells[i] ?? '');
}

/** Step names are matched without regard to case; this is the lookup key. */
export const stepKey = (name: string) => name.trim().toLowerCase();

function routeSteps(
  rows: { cells: string[]; row: number }[],
  s: number,
  o: number,
  label: string,
): Step[] {
  const steps: Step[] = [];
  const seen = new Map<string, number>();
  for (const { cells, row } of rows) {
    const name = cell(cells, s);
    if (!name) throw new InputError(`route row ${row}: step name is empty.`);
    const key = stepKey(name);
    if (seen.has(key)) throw new InputError(`route row ${row}: step "${name}" is already on the ${label} (row ${seen.get(key)}).`);
    seen.set(key, row);
    const flag = cell(cells, o).toLowerCase();
    if (!YES_WORDS.has(flag) && !NO_WORDS.has(flag)) {
      throw new InputError(`route row ${row}: optional must be y/yes/true/1 or n/no/false/0/empty, got "${cell(cells, o)}".`);
    }
    steps.push({ name, optional: YES_WORDS.has(flag), row });
  }
  return steps;
}

/** Parses a single route (a part column, if any, is ignored; use parseRoutes for routes per part number). */
export function parseRoute(text: string, columns: { stepColumn?: string; optionalColumn?: string } = {}): Step[] {
  const t = table(text, 'route');
  const s = t.index(columns.stepColumn ?? 'step', true, 'step name, one row per step in route order');
  const o = t.index(columns.optionalColumn ?? 'optional', columns.optionalColumn !== undefined, 'optional step y/n');
  const steps = routeSteps(t.rows, s, o, 'route');
  if (!steps.length) throw new InputError('route: no steps.');
  if (steps.every((st) => st.optional)) throw new InputError('route: every step is optional; mark at least one as required.');
  return steps;
}

/**
 * Parses a route file that may hold one route per part number. Without a part column (default "part") this is
 * parseRoute. With one, rows are grouped by part (matched without regard to case, first spelling kept; rows of a
 * part keep file order and may be interleaved with other parts); every row needs a part, and each part's route is
 * checked like a single route (no repeated step, at least one required step).
 */
export function parseRoutes(text: string, columns: RouteColumns = {}): Routes {
  const t = table(text, 'route');
  const p = t.index(columns.partColumn ?? 'part', columns.partColumn !== undefined, 'part number of each route row');
  if (p < 0) return { steps: parseRoute(text, columns) };
  const s = t.index(columns.stepColumn ?? 'step', true, 'step name, one row per step in route order');
  const o = t.index(columns.optionalColumn ?? 'optional', columns.optionalColumn !== undefined, 'optional step y/n');
  const groups = new Map<string, { part: string; rows: { cells: string[]; row: number }[] }>();
  for (const r of t.rows) {
    const part = cell(r.cells, p);
    if (!part) throw new InputError(`route row ${r.row}: part is empty (the route file has a part column, so every row needs one).`);
    const key = stepKey(part);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { part, rows: [] }));
    g.rows.push(r);
  }
  if (!groups.size) throw new InputError('route: no steps.');
  const parts: PartRoute[] = [];
  for (const g of groups.values()) {
    const steps = routeSteps(g.rows, s, o, `route of part "${g.part}"`);
    if (steps.every((st) => st.optional)) {
      throw new InputError(`route: every step of part "${g.part}" is optional; mark at least one as required.`);
    }
    parts.push({ part: g.part, steps });
  }
  return { steps: parts.flatMap((x) => x.steps).sort((a, b) => a.row - b.row), parts };
}

export function parseEvents(text: string, columns: EventColumns = {}): Events {
  const t = table(text, 'events');
  const se = t.index(columns.serialColumn ?? 'serial', true, 'unit serial');
  const st = t.index(columns.stepColumn ?? 'step', true, 'station / step name');
  const re = t.index(columns.resultColumn ?? 'result', columns.resultColumn !== undefined, 'pass / fail');
  const ts = t.index(columns.timeColumn ?? 'timestamp', columns.timeColumn !== undefined, 'timestamp');
  const pa = t.index(columns.partColumn ?? 'part', columns.partColumn !== undefined, 'part number');
  const events: Event[] = [];
  let zonedFirst: { zoned: boolean; row: number } | undefined;
  for (const { cells, row } of t.rows) {
    const serial = cell(cells, se);
    const step = cell(cells, st);
    if (!serial) throw new InputError(`events row ${row}: serial is empty.`);
    if (!step) throw new InputError(`events row ${row}: step is empty.`);
    let pass = true;
    if (re >= 0) {
      const word = cell(cells, re).toLowerCase();
      if (PASS_WORDS.has(word)) pass = true;
      else if (FAIL_WORDS.has(word)) pass = false;
      else {
        throw new InputError(
          `events row ${row}: result "${cell(cells, re)}" is not a pass word (pass, ok, p, good, 1, ...) or fail word (fail, ng, f, nok, 0, ...).`,
        );
      }
    }
    const ev: Event = { serial, step, pass, row };
    if (pa >= 0) {
      const part = cell(cells, pa);
      if (part) ev.part = part;
    }
    if (ts >= 0) {
      const stamp = cell(cells, ts);
      if (!stamp) throw new InputError(`events row ${row}: no timestamp (the file has a timestamp column, so every row needs one).`);
      const parsed = parseStamp(stamp);
      if (!parsed) {
        throw new InputError(`events row ${row}: timestamp "${stamp}" is not a date and time like 2026-11-10 08:01:00 (optional seconds, T, Z or +08:00).`);
      }
      if (!zonedFirst) zonedFirst = { zoned: parsed.zoned, row };
      else if (zonedFirst.zoned !== parsed.zoned) {
        throw new InputError(
          `events row ${row}: timestamp "${stamp}" ${parsed.zoned ? 'has' : 'has no'} time zone, but row ${zonedFirst.row} ${zonedFirst.zoned ? 'has one' : 'has none'}; use one style.`,
        );
      }
      ev.timestamp = stamp;
      ev.time = parsed.ms;
    }
    events.push(ev);
  }
  if (ts >= 0) {
    // Stable: equal times keep file order.
    const order = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.time! - b.e.time! || a.i - b.i);
    return { events: order.map((x) => x.e), hasResult: re >= 0, timeOrdered: true, hasPart: pa >= 0 };
  }
  return { events, hasResult: re >= 0, timeOrdered: false, hasPart: pa >= 0 };
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/i;

/**
 * Parses an ISO-like timestamp `YYYY-MM-DD HH:MM[:SS[.fff]]` (T or space, optional Z / +08:00 / +0800).
 * Returns milliseconds and whether a zone was given, or undefined when it is not a valid date and time.
 */
export function parseStamp(text: string): { ms: number; zoned: boolean } | undefined {
  const m = STAMP.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return undefined;
  const base = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (new Date(base).getUTCDate() !== d) return undefined; // e.g. 2026-02-30
  let ms = base + Math.floor(frac);
  const zone = m[8];
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    if (Number(z[2]) > 14 || Number(z[3]) > 59) return undefined;
    const off = Number(z[2]) * 60 + Number(z[3]);
    ms -= (z[1] === '-' ? -1 : 1) * off * 60_000;
  }
  return { ms, zoned: zone !== undefined };
}

/** A comma-separated list flag (e.g. --rework-steps repair,debug); empty entries dropped. */
export function listFlag(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
