import { useEffect, useState } from 'react';

export type Mode = 'light' | 'dark';

function currentMode(): Mode {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'light' || forced === 'dark') return forced;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useMode(): Mode {
  const [mode, setMode] = useState<Mode>(currentMode);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setMode(currentMode());
    mq.addEventListener('change', update);
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', update);
      obs.disconnect();
    };
  }, []);
  return mode;
}

type Pair = { light: string; dark: string };

export type ProgramInfo = { key: string; label: string; short: string; company: string; color: Pair };

// Categorical hues follow the validated dataviz palette order. A company keeps one hue family;
// its second program is a lighter tint of that hue.
export const PROGRAMS: ProgramInfo[] = [
  { key: 'tesla_l2', label: 'Tesla Autopilot / FSD Supervised (L2)', short: 'Tesla L2', company: 'tesla', color: { light: '#2a78d6', dark: '#3987e5' } },
  { key: 'tesla_robotaxi', label: 'Tesla Robotaxi (ADS)', short: 'Tesla Robotaxi', company: 'tesla', color: { light: '#7fb0ee', dark: '#9ec5f4' } },
  { key: 'gm_supercruise', label: 'GM Super Cruise (L2)', short: 'GM Super Cruise', company: 'gm', color: { light: '#eb6834', dark: '#d95926' } },
  { key: 'gm_cruise_ads', label: 'GM Cruise (ADS)', short: 'GM Cruise', company: 'gm', color: { light: '#f2a47f', dark: '#f0a07c' } },
  { key: 'waymo_ads', label: 'Waymo (ADS)', short: 'Waymo', company: 'waymo', color: { light: '#1baf7a', dark: '#199e70' } },
  { key: 'zoox_ads', label: 'Zoox (ADS)', short: 'Zoox', company: 'zoox', color: { light: '#6250d6', dark: '#9085e9' } },
  { key: 'other_ads', label: 'Other reporters (ADS)', short: 'Other ADS', company: 'other', color: { light: '#e87ba4', dark: '#d55181' } },
  { key: 'other_l2', label: 'Other reporters (L2)', short: 'Other L2', company: 'other', color: { light: '#eda100', dark: '#c98500' } },
];
export const PROGRAM_BY_KEY: Record<string, ProgramInfo> = Object.fromEntries(PROGRAMS.map((p) => [p.key, p]));

// Inferred-label colours (nominal): other party = blue, own motion = orange, cannot tell = neutral gray (deliberately not a hue).
export const LABEL_COLOR: Record<'other_party' | 'subject_vehicle_initiated' | 'indeterminate', Pair> = {
  other_party: { light: '#2a78d6', dark: '#3987e5' },
  subject_vehicle_initiated: { light: '#eb6834', dark: '#d95926' },
  indeterminate: { light: '#8a929a', dark: '#7b838b' },
};

export const SEVERITY_ORDER = ['none', 'minor', 'moderate', 'serious', 'fatal', 'unknown'];
export const SEVERITY_LABEL: Record<string, string> = {
  none: 'No injury',
  minor: 'Minor',
  moderate: 'Moderate',
  serious: 'Serious',
  fatal: 'Fatal',
  unknown: 'Unknown',
};
// Amber to dark red for increasing severity; unknown is a neutral gray, never on the ramp.
export const SEVERITY_COLOR: Record<string, Pair> = {
  none: { light: '#f2d58a', dark: '#f2d58a' },
  minor: { light: '#eca24a', dark: '#eca24a' },
  moderate: { light: '#d9622b', dark: '#e0693a' },
  serious: { light: '#a8281f', dark: '#c63a2c' },
  fatal: { light: '#5c0f1a', dark: '#9c2236' },
  unknown: { light: '#b4bac3', dark: '#5d6570' },
};

export const TAG_LABEL: Record<string, string> = {
  intersection_signal: 'Intersection / signal',
  visibility_glare: 'Reduced visibility / glare',
  roadway_departure: 'Roadway departure',
  stationary_hazard: 'Stationary hazard',
  low_speed: 'Low speed contact',
  vru: 'Pedestrian / cyclist',
};
export const TAG_ORDER = Object.keys(TAG_LABEL);

export const FIELD_LABEL: Record<string, string> = {
  month: 'Incident month',
  state: 'State',
  city: 'City',
  roadway_type: 'Roadway type',
  weather: 'Weather',
  crash_with: 'Crash with',
  sv_movement: 'Subject movement',
  cp_movement: 'Partner movement',
  speed_mph: 'Subject speed',
  severity: 'Injury severity',
  within_odd: 'Within domain',
  airbag: 'Airbag deployed',
  towed: 'Vehicle towed',
  narrative: 'Narrative',
  version: 'Software version',
  make: 'Vehicle make',
  model: 'Vehicle model',
  model_year: 'Model year',
  lighting: 'Lighting*',
  surface: 'Road surface*',
  speed_limit: 'Speed limit*',
};

export function ui(mode: Mode) {
  return mode === 'dark'
    ? { ink: '#ecebe8', muted: '#a4a8ad', faint: '#6c7279', grid: '#2b3036', surface: '#15181b', rule: '#3a4047', brand: '#7fb0ee' }
    : { ink: '#15191d', muted: '#566069', faint: '#8a929a', grid: '#e4e7ea', surface: '#ffffff', rule: '#c9ced3', brand: '#2a78d6' };
}

export const colorOf = (p: Pair, mode: Mode) => p[mode];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
