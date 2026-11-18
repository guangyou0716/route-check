import { InputError } from './errors.js';
import type { Events } from './input.js';

/** Settings for FPY per day / per shift (all opt-in; see check). */
export interface PeriodSettings {
  /** FPY per day. With `shifts` too: per day and shift (a shift counts on the day it starts). */
  byDay?: boolean;
  /** Time of day a day starts, HH:MM (default 00:00), e.g. 07:00 when the first shift starts at 7. Only for byDay without shifts. */
  dayStart?: string;
  /** Zone offset for day and shift boundaries when the timestamps carry one (default: the offset on the first row). */
  dayOffset?: string;
  /** Shift calendar "name=HH:MM,...": each shift starts at its time every day and lasts until the next one starts. */
  shifts?: string;
}

export interface ShiftDef {
  name: string;
  /** Wall-clock start and end (the next shift's start), HH:MM. */
  start: string;
  end: string;
}

/** How records were bucketed (Report.periodSettings). */
export interface PeriodInfo {
  /** day: per day; shift: per shift summed over every day; day-shift: per day and shift. */
  by: 'day' | 'shift' | 'day-shift';
  /** by day: the time of day a day starts (HH:MM); null otherwise (a shift counts on the day it starts). */
  dayStart: string | null;
  /** Offset used for day and shift boundaries; null for timestamps without a zone (taken as written). */
  offset: string | null;
  /** The shift calendar, in start order; null without shifts. */
  shifts: ShiftDef[] | null;
}

/** First-pass yield of one step in one period. */
export interface PeriodStepYield {
  step: string;
  optional: boolean;
  /** Units whose first record at the step falls in the period. */
  units: number;
  /** Of those, units whose first record at the step is a pass. */
  firstPass: number;
  /** firstPass / units (null when no units). */
  fpy: number | null;
}

/** One day / shift / day and shift. */
export interface PeriodYield {
  /** Label: "2026-11-10", "Night" or "2026-11-10 Night". */
  period: string;
  /** Date the period starts on (by day / day and shift). */
  day?: string;
  /** Shift name (by shift / day and shift). */
  shift?: string;
  /** Units with a first record at some route step in the period. */
  units: number;
  steps: PeriodStepYield[];
  /** Product of FPY over required steps that have units in the period (null when none). */
  rty: number | null;
}

/** Maps a record time (epoch ms) to a period. */
export interface Periods {
  info: PeriodInfo;
  /** Sort key (chronological / shift order) and label of the period holding `ms`. */
  bucket(ms: number): { key: number; period: string; day?: string; shift?: string };
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const clockText = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const dateText = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** "7:00" -> minutes after midnight. */
function clockMinutes(text: string, flag: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new InputError(`${flag} "${text}" is not a time of day like 07:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "+08:00" / "+0800" / "Z" -> minutes east of UTC. */
function offsetMinutes(text: string, flag: string): number {
  const m = /^(Z)$|^([+-])(\d{2}):?(\d{2})$/i.exec(text.trim());
  if (!m || (m[3] !== undefined && (Number(m[3]) > 14 || Number(m[4]) > 59))) {
    throw new InputError(`${flag} "${text}" is not a zone offset like +08:00.`);
  }
  return m[1] ? 0 : (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
}

/** "Day=07:00,Night=19:00" -> shifts sorted by start time (same syntax and checks as oee-log-check). */
export function parseShifts(text: string): { name: string; startMin: number }[] {
  const out: { name: string; startMin: number }[] = [];
  for (const part of text.split(',')) {
    const at = part.lastIndexOf('=');
    const name = at < 0 ? '' : part.slice(0, at).trim();
    if (name === '') throw new InputError(`--shifts: "${part.trim()}" is not name=HH:MM (for example Day=07:00,Night=19:00).`);
    const startMin = clockMinutes(part.slice(at + 1), `--shifts start of "${name}"`);
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new InputError(`--shifts names shift "${name}" twice.`);
    const same = out.find((x) => x.startMin === startMin);
    if (same) throw new InputError(`--shifts: "${same.name}" and "${name}" both start at ${clockText(startMin)}.`);
    out.push({ name, startMin });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Builds the day / shift bucketing from the settings, or undefined when neither byDay nor shifts is set (then
 * dayStart / dayOffset must not be set either). Needs timestamps on the events (input error otherwise).
 * Boundaries are wall-clock times: for zoned timestamps epoch ms + the offset (dayOffset or the first row's own
 * offset), otherwise the time as written. A record exactly on a boundary belongs to the period that starts there.
 */
export function makePeriods(s: PeriodSettings, input: Events): Periods | undefined {
  const byShift = s.shifts !== undefined;
  if (!s.byDay && !byShift) {
    if (s.dayStart !== undefined || s.dayOffset !== undefined) {
      throw new InputError('--day-start and --day-offset need --by-day (--day-offset also works with --shifts).');
    }
    return undefined;
  }
  if (s.dayStart !== undefined && (!s.byDay || byShift)) {
    throw new InputError(
      s.byDay ? '--day-start does not apply with --shifts: each shift counts on the day it starts.' : '--day-start needs --by-day.',
    );
  }
  if (!input.timeOrdered) {
    throw new InputError('--by-day / --shifts need a timestamp column in the events file (see --time-column).');
  }
  // The first row of the file (lowest row number), for its zone style and offset.
  let first = input.events[0];
  for (const e of input.events) if (e.row < first.row) first = e;
  const own = first ? ZONE.exec(first.timestamp!.trim()) : null;
  let offset: string | null = null;
  let offMin = 0;
  if (own) {
    offset = s.dayOffset?.trim() ?? own[1].toUpperCase();
    offMin = offsetMinutes(offset, '--day-offset');
  } else if (s.dayOffset !== undefined) {
    throw new InputError('--day-offset is only for timestamps that carry a zone offset.');
  }
  const offMs = offMin * 60_000;
  const defs = byShift ? parseShifts(s.shifts!) : [];
  const shiftsInfo = byShift ? defs.map((d, k) => ({ name: d.name, start: clockText(d.startMin), end: clockText(defs[(k + 1) % defs.length].startMin) })) : null;

  if (!byShift) {
    const startMs = clockMinutes(s.dayStart ?? '00:00', '--day-start') * 60_000;
    return {
      info: { by: 'day', dayStart: clockText(startMs / 60_000), offset, shifts: null },
      bucket(ms) {
        const day = Math.floor((ms + offMs - startMs) / DAY_MS);
        const label = dateText(day);
        return { key: day, period: label, day: label };
      },
    };
  }
  const byDay = s.byDay === true;
  const n = defs.length;
  return {
    info: { by: byDay ? 'day-shift' : 'shift', dayStart: null, offset, shifts: shiftsInfo },
    bucket(ms) {
      const wall = ms + offMs;
      let day = Math.floor(wall / DAY_MS);
      const tod = wall - day * DAY_MS;
      let k = n - 1;
      while (k >= 0 && defs[k].startMin * 60_000 > tod) k--;
      if (k < 0) {
        // Before the first shift of the day: still in the last shift, which started the day before.
        k = n - 1;
        day--;
      }
      const shift = defs[k].name;
      if (!byDay) return { key: k, period: shift, shift };
      const label = dateText(day);
      return { key: day * n + k, period: `${label} ${shift}`, day: label, shift };
    },
  };
}
