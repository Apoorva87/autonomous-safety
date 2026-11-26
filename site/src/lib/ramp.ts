import type { Mode } from '../theme';

// One-hue sequential ramps (low share -> high share). Dark mode has its own steps against the dark surface:
// magnitude reads as brighter, not as an inverted light ramp.
export const SEQ_BLUE: Record<Mode, string[]> = {
  light: ['#e9f1fc', '#c3d9f5', '#86b4ee', '#2a78d6', '#173f78'],
  dark: ['#1c2836', '#26466f', '#3b72b3', '#6aa2e6', '#b3d3f8'],
};

const hex = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Colour at position t (0..1) along the stops, interpolated in sRGB. */
export function rampColor(stops: string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  return toHex(a.map((v, k) => v + (b[k] - v) * f));
}

/** WCAG relative luminance. */
export function luminance(h: string): number {
  const [r, g, b] = hex(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Black or white text, whichever has the higher contrast on the fill. */
export function textOn(fill: string): string {
  const L = luminance(fill);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#10151a' : '#ffffff';
}
