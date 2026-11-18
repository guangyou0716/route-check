import { InputError } from './errors.js';
import { type Step, listFlag, stepKey } from './input.js';

/** A maximum dwell time between two route steps (FROM must come before TO on the route). */
export interface DwellLimit {
  /** Step the unit leaves (as written in the flag). */
  from: string;
  /** Later step the unit arrives at (as written in the flag). */
  to: string;
  /** Maximum dwell in milliseconds; a dwell equal to the limit is not a finding. */
  limitMs: number;
}

/** Dwell statistics of one step pair (route-check --max-dwell). */
export interface DwellStat {
  /** Route step names (route spelling). */
  from: string;
  to: string;
  limitMs: number;
  /** Units with a measured dwell (a pass at FROM before their first record at TO). */
  units: number;
  /** Of those, units whose dwell is over the limit (dwell-exceeded findings). */
  exceeded: number;
  /** Median and longest dwell in milliseconds (null when no unit was measured). */
  medianMs: number | null;
  maxMs: number | null;
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * Parses a duration like 90s, 30m, 2h, 1h30m, 1.5h or 2d (units d, h, m, s, largest first, each at most once; a
 * bare number is not accepted). Returns milliseconds, or undefined when the text is not a duration or is zero.
 */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!/^(\d+(\.\d+)?[dhms])+$/.test(t)) return undefined;
  let ms = 0;
  const seen = new Set<string>();
  let lastRank = -1;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    const rank = 'dhms'.indexOf(m[2]);
    if (seen.has(m[2]) || rank < lastRank) return undefined; // 1h1h or 30m1h
    seen.add(m[2]);
    lastRank = rank;
    ms += Number(m[1]) * UNIT_MS[m[2]];
  }
  ms = Math.round(ms);
  return ms > 0 ? ms : undefined;
}

/** Formats milliseconds as e.g. 45s, 1m30s, 2h05m, 1d03h00m, 0.25s (largest unit first; seconds left out when zero). */
export function formatDuration(ms: number): string {
  if (ms < 0) return `-${formatDuration(-ms)}`;
  const whole = Math.floor(ms / 1000);
  const sec = Number(((whole % 60) + (ms - whole * 1000) / 1000).toFixed(3));
  const d = Math.floor(whole / 86_400);
  const h = Math.floor((whole % 86_400) / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const two = (v: number) => (v < 10 ? `0${v}` : String(v));
  const tail = sec ? `${two(sec)}s` : '';
  if (d) return `${d}d${two(h)}h${two(m)}m${tail}`;
  if (h) return `${h}h${two(m)}m${tail}`;
  if (m) return `${m}m${tail}`;
  return `${sec}s`;
}

/**
 * Parses --max-dwell values: each `FROM>TO=DURATION`, several per value separated by commas, e.g.
 * `FCT>PACK=2h,SMT>AOI=30m`. Step names are checked against the route later (checkDwellLimits).
 * A pair given twice is an input error.
 */
export function parseDwellLimits(values: string | string[]): DwellLimit[] {
  const list = (Array.isArray(values) ? values : [values]).flatMap((v) => {
    const items = listFlag(v);
    if (!items.length) throw new InputError('--max-dwell is empty; give FROM>TO=DURATION, e.g. FCT>PACK=2h.');
    return items;
  });
  const out: DwellLimit[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const m = /^([^>=]+)>([^>=]+)=([^>=]+)$/.exec(item);
    const from = m?.[1].trim();
    const to = m?.[2].trim();
    if (!m || !from || !to) throw new InputError(`--max-dwell "${item}": expected FROM>TO=DURATION, e.g. FCT>PACK=2h.`);
    const limitMs = parseDuration(m[3]);
    if (limitMs === undefined) {
      throw new InputError(`--max-dwell "${item}": duration "${m[3].trim()}" is not a positive time like 90s, 30m, 2h, 1h30m or 1d.`);
    }
    if (stepKey(from) === stepKey(to)) throw new InputError(`--max-dwell "${item}": FROM and TO are the same step.`);
    const key = `${stepKey(from)}>${stepKey(to)}`;
    if (seen.has(key)) throw new InputError(`--max-dwell: the pair ${from}>${to} is given more than once.`);
    seen.add(key);
    out.push({ from, to, limitMs });
  }
  return out;
}

/** A dwell limit resolved against one route: step indexes. */
export interface RouteDwell {
  limit: DwellLimit;
  from: number;
  to: number;
}

/**
 * Resolves dwell limits against a route. Both steps must be on the route with FROM before TO (input error
 * otherwise). With `skipMissing` (routes per part) a pair whose steps are not both on this route is left out.
 */
export function resolveDwell(route: Step[], limits: DwellLimit[], label: string, skipMissing = false): RouteDwell[] {
  const index = new Map(route.map((s, i) => [stepKey(s.name), i]));
  const out: RouteDwell[] = [];
  for (const limit of limits) {
    const from = index.get(stepKey(limit.from));
    const to = index.get(stepKey(limit.to));
    if (from === undefined || to === undefined) {
      if (skipMissing) continue;
      const missing = from === undefined ? limit.from : limit.to;
      throw new InputError(`--max-dwell ${limit.from}>${limit.to}: step "${missing}" is not on the ${label}.`);
    }
    if (from > to) {
      throw new InputError(`--max-dwell ${limit.from}>${limit.to}: ${route[to].name} comes before ${route[from].name} on the ${label}; give FROM>TO in route order.`);
    }
    out.push({ limit, from, to });
  }
  return out;
}

/** Median of a non-empty list (sorted in place); mean of the two middle values for an even count. */
export function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
