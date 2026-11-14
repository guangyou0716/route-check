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
  /** `timestamp` as milliseconds (zone-less stamps are compared as they are, like UTC). Set when the file has times. */
  time?: number;
}

export interface EventColumns {
  serialColumn?: string;
  stepColumn?: string;
  resultColumn?: string;
  timeColumn?: string;
}

export interface Events {
  events: Event[];
  /** True when the file had a result column (otherwise every row is a move / pass). */
  hasResult: boolean;
  /** True when rows were replayed by timestamp (otherwise file order). */
  timeOrdered: boolean;
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

export function parseRoute(text: string, columns: { stepColumn?: string; optionalColumn?: string } = {}): Step[] {
  const t = table(text, 'route');
  const s = t.index(columns.stepColumn ?? 'step', true, 'step name, one row per step in route order');
  const o = t.index(columns.optionalColumn ?? 'optional', columns.optionalColumn !== undefined, 'optional step y/n');
  const steps: Step[] = [];
  const seen = new Map<string, number>();
  for (const { cells, row } of t.rows) {
    const name = cell(cells, s);
    if (!name) throw new InputError(`route row ${row}: step name is empty.`);
    const key = stepKey(name);
    if (seen.has(key)) throw new InputError(`route row ${row}: step "${name}" is already on the route (row ${seen.get(key)}).`);
    seen.set(key, row);
    const flag = cell(cells, o).toLowerCase();
    if (!YES_WORDS.has(flag) && !NO_WORDS.has(flag)) {
      throw new InputError(`route row ${row}: optional must be y/yes/true/1 or n/no/false/0/empty, got "${cell(cells, o)}".`);
    }
    steps.push({ name, optional: YES_WORDS.has(flag), row });
  }
  if (!steps.length) throw new InputError('route: no steps.');
  if (steps.every((st) => st.optional)) throw new InputError('route: every step is optional; mark at least one as required.');
  return steps;
}

export function parseEvents(text: string, columns: EventColumns = {}): Events {
  const t = table(text, 'events');
  const se = t.index(columns.serialColumn ?? 'serial', true, 'unit serial');
  const st = t.index(columns.stepColumn ?? 'step', true, 'station / step name');
  const re = t.index(columns.resultColumn ?? 'result', columns.resultColumn !== undefined, 'pass / fail');
  const ts = t.index(columns.timeColumn ?? 'timestamp', columns.timeColumn !== undefined, 'timestamp');
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
    return { events: order.map((x) => x.e), hasResult: re >= 0, timeOrdered: true };
  }
  return { events, hasResult: re >= 0, timeOrdered: false };
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
