import type { Metric, Point } from './metrics';

export const METRICS: { id: Metric; label: string; axis: string; short: string }[] = [
  { id: 'perM', label: 'Crashes per million miles', axis: 'crashes per million miles', short: 'per M miles' },
  { id: 'per1k', label: 'Crashes per 1,000 miles', axis: 'crashes per 1,000 miles', short: 'per 1k miles' },
  { id: 'per10kVeh', label: 'Crashes per 10,000 vehicles', axis: 'crashes per 10,000 active vehicles', short: 'per 10k vehicles' },
  { id: 'milesPerCrash', label: 'Miles per crash', axis: 'miles per crash', short: 'miles / crash' },
  { id: 'milesPerVehicle', label: 'Miles per vehicle', axis: 'miles per active vehicle', short: 'miles / vehicle' },
  { id: 'count', label: 'Crash count', axis: 'crashes', short: 'count' },
];
export const metricInfo = (m: Metric) => METRICS.find((x) => x.id === m)!;

/** Significant-digit formatting that stays readable for 0.0003 and 1,200,000 alike. */
export function fmtNum(x: number | null | undefined, sig = 3): string {
  if (x == null || !Number.isFinite(x)) return 'no data';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toPrecision(3) + ' B';
  if (a >= 1e6) return (x / 1e6).toPrecision(3) + ' M';
  if (a >= 1e4) return Math.round(x).toLocaleString('en-US');
  if (a >= 100) return x.toFixed(0);
  if (a >= 1) return x.toPrecision(sig);
  return x.toPrecision(Math.min(sig, 2));
}

export const fmtInt = (x: number | null | undefined) => (x == null ? 'no data' : Math.round(x).toLocaleString('en-US'));

export function fmtCI(p: Point): string {
  if (p.lo == null && p.hi == null) return 'n/a';
  return `${p.lo == null ? '?' : fmtNum(p.lo)} to ${p.hi == null ? 'no upper bound' : fmtNum(p.hi)}`;
}

export function fmtRateText(p: Point): string {
  if (p.lowerBound) return `> ${fmtNum(p.lo)} (0 crashes)`;
  return p.rate == null ? 'no data' : fmtNum(p.rate);
}

/** Escape text that goes into an ECharts tooltip (which renders HTML). */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A diagonal-hatch fill (canvas pattern) for low-sample bands. */
export function hatchPattern(color: string): { image: HTMLCanvasElement; repeat: 'repeat' } {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const g = c.getContext('2d')!;
  g.strokeStyle = color;
  g.globalAlpha = 0.85;
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(-2, 10);
  g.lineTo(10, -2);
  g.moveTo(-2, 2);
  g.lineTo(2, -2);
  g.moveTo(6, 10);
  g.lineTo(10, 6);
  g.stroke();
  return { image: c, repeat: 'repeat' };
}

/** CSV cell: quote when needed and neutralise spreadsheet formulas. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
