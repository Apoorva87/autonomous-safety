// Layout helpers for the brushable timeline. Everything is pure so it can be tested without a DOM.

const DAY = 86_400_000;

/** "YYYY-MM-DD" or "YYYY-MM" -> UTC milliseconds (month-only dates fall on the 1st). */
export function dateMs(d: string): number {
  const y = Number(d.slice(0, 4));
  const m = d.length >= 7 ? Number(d.slice(5, 7)) - 1 : 0;
  const day = d.length >= 10 ? Number(d.slice(8, 10)) : 1;
  return Date.UTC(y, m, day);
}

export const msToDate = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const msToMonth = (t: number): string => new Date(t).toISOString().slice(0, 7);

/** Smallest "round" number (1, 2, 4, 5 or 10 times a power of ten) that is at least v, so axis ticks at 0, half and full read cleanly. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 5, 10]) if (m * p >= v - 1e-12) return m * p;
  return 10 * p;
}

export type Range = { t0: number; t1: number };

export function makeScale(r: Range, x0: number, x1: number) {
  const span = r.t1 - r.t0 || 1;
  return {
    x: (t: number) => x0 + ((t - r.t0) / span) * (x1 - x0),
    t: (x: number) => r.t0 + ((x - x0) / (x1 - x0 || 1)) * span,
  };
}

/** Keep a range inside bounds and at least minSpan wide (shifting rather than shrinking). */
export function clampRange(r: Range, bounds: Range, minSpan = 60 * DAY): Range {
  let span = Math.max(minSpan, r.t1 - r.t0);
  span = Math.min(span, bounds.t1 - bounds.t0);
  let t0 = r.t0;
  if (t0 < bounds.t0) t0 = bounds.t0;
  if (t0 + span > bounds.t1) t0 = bounds.t1 - span;
  return { t0, t1: t0 + span };
}

/** Zoom by `factor` (<1 zooms in) around the fraction `at` (0..1) of the range. */
export function zoomRange(r: Range, factor: number, at: number, bounds: Range, minSpan = 60 * DAY): Range {
  const span = r.t1 - r.t0;
  const next = span * factor;
  const t0 = r.t0 + (span - next) * at;
  return clampRange({ t0, t1: t0 + next }, bounds, minSpan);
}

export const panRange = (r: Range, fraction: number, bounds: Range): Range =>
  clampRange({ t0: r.t0 + (r.t1 - r.t0) * fraction, t1: r.t1 + (r.t1 - r.t0) * fraction }, bounds, r.t1 - r.t0);

export type Tick = { t: number; label: string; major: boolean };

/** Year ticks for long spans, quarter ticks for medium, month ticks for short. */
export function makeTicks(r: Range): Tick[] {
  const years = (r.t1 - r.t0) / (365.25 * DAY);
  const out: Tick[] = [];
  const startY = new Date(r.t0).getUTCFullYear();
  const endY = new Date(r.t1).getUTCFullYear();
  const step = years > 3 ? 1 : years > 0.9 ? 3 : 1; // months between ticks (years use 12)
  for (let y = startY; y <= endY; y++) {
    if (years > 3) {
      const t = Date.UTC(y, 0, 1);
      if (t >= r.t0 && t <= r.t1) out.push({ t, label: String(y), major: true });
      continue;
    }
    for (let m = 0; m < 12; m += step) {
      const t = Date.UTC(y, m, 1);
      if (t < r.t0 || t > r.t1) continue;
      out.push({ t, label: m === 0 ? String(y) : MONTHS[m], major: m === 0 });
    }
  }
  return out;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Span = { id: string; start: number; end: number };

/**
 * Greedy interval packing: each span goes on the first lane whose last span ended at least `gap` ms before it
 * starts. Returns lane per id and the lane count. Input order does not matter.
 */
export function packLanes(spans: Span[], gap = 0): { lane: Record<string, number>; lanes: number } {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const ends: number[] = [];
  const lane: Record<string, number> = {};
  for (const s of sorted) {
    let i = ends.findIndex((e) => e + gap <= s.start);
    if (i < 0) {
      i = ends.length;
      ends.push(s.end);
    } else ends[i] = s.end;
    lane[s.id] = i;
  }
  return { lane, lanes: ends.length };
}

/** Month window of an event for the explorer filter: its month through two months later (reports arrive late). */
export function periodForEvent(date: string, lastMonth: string): { from: string; to: string } {
  const from = date.slice(0, 7);
  const [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const t = y * 12 + (m - 1) + 2;
  const to = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  return { from, to: to > lastMonth ? lastMonth : to };
}

/** Month window of an investigation: opened through closed (or the last month with data while open). */
export function periodForInvestigation(opened: string, closed: string | null | undefined, lastMonth: string) {
  const to = closed ? closed.slice(0, 7) : lastMonth;
  return { from: opened.slice(0, 7), to: to > lastMonth ? lastMonth : to };
}

/** Programs an investigation's company maps to in the SGO data. */
export const COMPANY_PROGRAMS: Record<string, string[]> = {
  tesla: ['tesla_l2', 'tesla_robotaxi'],
  gm: ['gm_supercruise', 'gm_cruise_ads'],
  waymo: ['waymo_ads'],
  zoox: ['zoox_ads'],
};

/** Event lanes in display order. */
export const EVENT_LANES: { type: string; label: string }[] = [
  { type: 'launch', label: 'Launches' },
  { type: 'recall', label: 'Recalls' },
  { type: 'suspension', label: 'Suspensions' },
  { type: 'regulatory', label: 'Rules' },
  { type: 'reporting_change', label: 'Rules' },
  { type: 'other', label: 'Other' },
];

/** The lane an event type is drawn in (regulatory and reporting_change share "Rules"). */
export function laneOfEvent(type: string): string {
  return type === 'reporting_change' ? 'regulatory' : EVENT_LANES.some((l) => l.type === type) ? type : 'other';
}
