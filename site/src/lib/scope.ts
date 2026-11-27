import { CITY_REGION_BY_KEY } from './cities';

// What a rate's numerator and denominator must have in common.

/**
 * Programs whose disclosed miles are rider-only (no human driver on board). A crash with an in-vehicle operator
 * (a supervised or testing drive) is not part of those miles, so the numerator leaves it out (scenario toggle, on by default).
 */
export const RIDER_ONLY_PROGRAMS = ['waymo_ads', 'gm_cruise_ads', 'zoox_ads', 'tesla_robotaxi'];
export const isRiderOnlyProgram = (program: string) => RIDER_ONLY_PROGRAMS.includes(program);

/** SGO "Driver / Operator Type" values (golden vocabulary) that mean nobody sat in the vehicle's driver seat. */
export const NO_IN_VEHICLE_OPERATOR = ['none', 'remote'];

export type OperatorClass = 'driverless' | 'in_vehicle' | 'other';

/** driverless: none or remote. in_vehicle: an in-vehicle operator (alone or with remote). other: unknown, consumer, other or not exported. */
export function operatorClass(operator: string | null | undefined): OperatorClass {
  if (operator != null && NO_IN_VEHICLE_OPERATOR.includes(operator)) return 'driverless';
  if (operator === 'in_vehicle' || operator === 'in_vehicle_and_remote') return 'in_vehicle';
  return 'other';
}

/**
 * Exposure regions that are informational only. California DMV autonomous-testing miles (reporting years run Dec-Nov and
 * include testing with safety drivers) are not a denominator for SGO crashes, which cover calendar months and all operations.
 */
export const MILES_ONLY_REGIONS = ['ca'];
export const MILES_ONLY_LABEL = 'CA DMV testing miles, Dec–Nov, not comparable with SGO crashes';
export const MILES_ONLY_REASON =
  'No comparable denominator: California DMV testing miles (Dec–Nov reporting years, including testing with safety drivers) cannot be matched to SGO crashes (calendar months, all operations). Shown for information only.';

export const isMilesOnlyRegion = (region: string) => MILES_ONLY_REGIONS.includes(region);

export type Scope = { all: true } | { state: string; cities?: string[] };

/** The crash scope that matches an exposure region. null = the region has no crash scope (it is not mapped). */
export function scopeOf(region: string): Scope | null {
  switch (region) {
    case 'us':
    case 'north_america':
      return { all: true };
    case 'ca':
      return { state: 'CA' };
    default: {
      const r = CITY_REGION_BY_KEY[region];
      return r ? { state: r.state, cities: r.cities } : null;
    }
  }
}

export type RegionBlock = 'miles-only' | 'global' | 'unmapped';

/** Why a region can never give a rate, or null when it can. A rate needs an exposure whose region maps to a crash scope. */
export function regionRateBlock(region: string): RegionBlock | null {
  if (isMilesOnlyRegion(region)) return 'miles-only';
  if (region === 'global') return 'global';
  if (scopeOf(region) == null) return 'unmapped';
  return null;
}

export const unmappedReason = (region: string) => `No rate: region not mapped (no crash scope is defined for ${region}).`;
