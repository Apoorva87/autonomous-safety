import type { Crash } from '../data';

// Contact-area helpers for the impact map. Contact area is where a vehicle was struck. The SGO allows several
// areas per crash, so zone shares are "share of crashes with a known area that touched this zone" and can add up
// to more than 100%.

export const ZONES = [
  'front_left', 'front', 'front_right', 'left', 'top', 'right', 'rear_left', 'rear', 'rear_right', 'bottom',
] as const;
export type Zone = (typeof ZONES)[number];
export const ZONE_LABEL: Record<Zone, string> = {
  front_left: 'Front left', front: 'Front', front_right: 'Front right', left: 'Left side', top: 'Roof',
  right: 'Right side', rear_left: 'Rear left', rear: 'Rear', rear_right: 'Rear right', bottom: 'Underbody',
};

export type Side = 'sv' | 'cp';
const KEY: Record<Side, 'sv_contact_areas' | 'cp_contact_areas'> = { sv: 'sv_contact_areas', cp: 'cp_contact_areas' };

export type WithContact = Crash & { sv_contact_areas?: string[] | null; cp_contact_areas?: string[] | null };

/** True when records.json carries the contact-area columns (the pipeline export may not include them). */
export function hasContactData(crashes: WithContact[]): boolean {
  return crashes.some((c) => Array.isArray(c.sv_contact_areas) || Array.isArray(c.cp_contact_areas));
}
export function hasSide(crashes: WithContact[], side: Side): boolean {
  return crashes.some((c) => Array.isArray(c[KEY[side]]));
}

export const zonesOf = (c: WithContact, side: Side): Zone[] =>
  ((c[KEY[side]] ?? []) as string[]).filter((z): z is Zone => (ZONES as readonly string[]).includes(z));

export type ZoneStats = {
  counts: Record<Zone, number>;
  /** Crashes with at least one known zone on this side (the share denominator). */
  known: number;
  /** Crashes with no usable zone: not applicable (no partner), unknown, or not reported. */
  unknown: number;
  total: number;
};

export function zoneStats(crashes: WithContact[], side: Side): ZoneStats {
  const counts = Object.fromEntries(ZONES.map((z) => [z, 0])) as Record<Zone, number>;
  let known = 0;
  for (const c of crashes) {
    const zs = zonesOf(c, side);
    if (zs.length === 0) continue;
    known++;
    for (const z of new Set(zs)) counts[z]++;
  }
  return { counts, known, unknown: crashes.length - known, total: crashes.length };
}

export type ImpactFilters = {
  programs: string[];
  severities: string[];
  speedBands: string[];
  crashWith: string[];
  tags: string[]; // tag names; a crash passes if it has any selected tag (field or narrative basis)
  period?: { from?: string; to?: string };
};

const any = (sel: string[], v: string | null | undefined) => sel.length === 0 || (v != null && sel.includes(v));

export function passesImpact(c: Crash, f: ImpactFilters): boolean {
  if (!any(f.programs, c.program)) return false;
  if (!any(f.severities, c.severity)) return false;
  if (!any(f.speedBands, c.speed_band)) return false;
  if (f.crashWith.length > 0 && !(c.crash_with != null && f.crashWith.includes(c.crash_with))) return false;
  if (f.tags.length > 0 && !c.tags.some((t) => f.tags.includes(t.split(':')[0]))) return false;
  if (f.period?.from && (c.month ?? '') < f.period.from) return false;
  if (f.period?.to && (c.month ?? '9999') > f.period.to) return false;
  return true;
}

/** Crashes that touched `zone` on `side`. */
export const inZone = (crashes: WithContact[], side: Side, zone: Zone) => crashes.filter((c) => zonesOf(c, side).includes(zone));

/** Color-scale position (0..1) of a share, scaled to the largest share so the map uses its full range. */
export const shadeOf = (share: number, maxShare: number) => (maxShare > 0 ? Math.min(1, Math.max(0, share / maxShare)) : 0);
