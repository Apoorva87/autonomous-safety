import type { Crash } from '../data';
import { wilson } from './stats';

// Time of day: when reported crashes happen. There is no exposure by hour, so this is a mix, not a risk.

export type Regime = 'all' | 'pre' | 'post';
export const inRegime = (month: string | null, r: Regime) =>
  !!month && (r === 'all' || (r === 'pre' ? month < '2025-06' : month > '2025-06'));

/** Clock window for the night share: 21:00 to 05:59 local time (fixed, no approximation). */
export const isNightClock = (h: number) => h >= 21 || h < 6;

export type HourStats = {
  n: number;
  /** Crashes per hour 0-23. */
  hours: number[];
  night: [number, number, number] | null;
  nightK: number;
  light: Record<'day' | 'twilight' | 'night', number>;
  lightN: number;
  /** Crashes whose time was converted from UTC (Tesla). */
  converted: number;
};

export function hourStats(crashes: Crash[], regime: Regime): HourStats {
  const cs = crashes.filter((c) => inRegime(c.month, regime));
  const timed = cs.filter((c) => c.hour != null);
  const hours = Array.from({ length: 24 }, () => 0);
  for (const c of timed) hours[c.hour as number]++;
  const nightK = timed.filter((c) => isNightClock(c.hour as number)).length;
  const light = { day: 0, twilight: 0, night: 0 };
  for (const c of cs) if (c.light_from_time !== 'unknown') light[c.light_from_time]++;
  return {
    n: timed.length, hours, nightK, night: wilson(nightK, timed.length), light,
    lightN: light.day + light.twilight + light.night, converted: timed.filter((c) => c.time_basis === 'utc').length,
  };
}
