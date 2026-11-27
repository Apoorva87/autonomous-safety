import type { Crash } from '../data';

// Investigation lenses: approximations of the scenario an NHTSA probe describes, built only from structured
// fields and tags the pipeline already exports. They are NOT the probe's own case list.

export type Lens = {
  id: string;
  title: string;
  investigationId: string;
  /** Facet values the preset selects (program facet), so the chips show what is applied. */
  programs: string[];
  /** Plain-language definition shown next to the preset. */
  rule: string;
  test: (c: Crash) => boolean;
};

const hasTag = (c: Crash, name: string) => c.tags.some((t) => t.split(':')[0] === name);

// All dark lighting values (including street-lit darkness) plus dawn/dusk; the pipeline's own visibility tag
// leaves out lit darkness, but the probe's wording is broader, so the lens takes both.
export const DARK_LIGHTING = ['dark_unlit', 'dark_lighted', 'dark_unknown', 'dawn_dusk'];
export const LOW_VIS_WEATHER = ['fog', 'rain', 'snow', 'dust', 'dust_storm'];

export const LENSES: Lens[] = [
  {
    id: 'EA26002',
    title: 'Reduced roadway visibility',
    investigationId: 'EA26002',
    programs: ['tesla_l2'],
    rule:
      'Tesla Autopilot/FSD reports where the light condition is night or twilight, or weather is fog, rain, snow or dust, or the reduced-visibility / glare tag applies (a structured field or a narrative keyword). Through 2025-06-15 the light condition is the recorded Lighting field; after that NHTSA no longer collects Lighting, so it is derived from the incident time (converted from UTC for Tesla) and month: an approximation with a one-hour twilight band, not a measurement.',
    test: (c) =>
      c.program === 'tesla_l2' &&
      (hasTag(c, 'visibility_glare') ||
        (c.lighting != null && DARK_LIGHTING.includes(c.lighting)) ||
        ((c.lighting == null || c.lighting === 'unknown' || c.lighting === 'other') && (c.light_condition === 'night' || c.light_condition === 'twilight')) ||
        c.weather.some((w) => LOW_VIS_WEATHER.includes(w))),
  },
  {
    id: 'PE25012',
    title: 'Traffic-law violations',
    investigationId: 'PE25012',
    programs: ['tesla_l2'],
    rule:
      'Tesla Autopilot/FSD reports with an intersection / signal tag (roadway type or narrative keyword), or a subject-vehicle movement of wrong-way or lane departure. Red-light and wrong-way behaviour are not recorded as such in the SGO, so this over- and under-includes.',
    test: (c) =>
      c.program === 'tesla_l2' &&
      (hasTag(c, 'intersection_signal') || c.sv_movement === 'wrong_way' || c.sv_movement === 'lane_departure'),
  },
];
export const LENS_BY_ID: Record<string, Lens> = Object.fromEntries(LENSES.map((l) => [l.id, l]));
