import { setQuery } from '../state/scenario';

// The 2025-06-16 reporting-rule change, shown on every time chart, and the numerator switch shared by the
// Rates, Timeline, Learning and Cities tabs (URL parameter `num`, default: threshold-robust crashes).

export const REGIME_BADGE_TEXT = 'Reporting rules changed 2025-06-16: trends across the line are not comparable for all-crash counts';
export const ROBUST_LABEL = 'Injury, air bag, tow-away or VRU (comparable across the change)';
export const ALL_LABEL = 'All reportable crashes (reporting threshold changed 2025-06-16)';

export type Numerator = 'robust' | 'crashes';

/** The numerator in the URL: threshold-robust crashes unless `num=crashes`. */
export const numeratorFrom = (params: URLSearchParams): Numerator => (params.get('num') === 'crashes' ? 'crashes' : 'robust');

/** Compact, persistent badge for time charts. */
export function RegimeBadge({ robust }: { robust?: boolean }) {
  return (
    <span className={`regime-badge${robust ? ' ok' : ''}`} role="note">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M6 0.5v11" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 1.6" />
      </svg>
      {REGIME_BADGE_TEXT}
      {robust ? '. This chart counts threshold-robust crashes, which are comparable.' : '.'}
    </span>
  );
}

/** Segmented switch between the threshold-robust numerator (default) and all reportable crashes. */
export function NumeratorToggle({ value, label = 'Counting' }: { value: Numerator; label?: string }) {
  return (
    <div className="field">
      {label}
      <div className="seg" role="group" aria-label="Which crashes are counted">
        <button type="button" className={value === 'robust' ? 'on' : ''} aria-pressed={value === 'robust'} onClick={() => setQuery({ num: null })}>
          {ROBUST_LABEL}
        </button>
        <button type="button" className={value === 'crashes' ? 'on' : ''} aria-pressed={value === 'crashes'} onClick={() => setQuery({ num: 'crashes' })}>
          {ALL_LABEL}
        </button>
      </div>
    </div>
  );
}

/** One line under a chart that says what "robust" means, for the kind group shown. */
export function RobustNote({ kind }: { kind?: 'ads' | 'l2' | null }) {
  const ads = 'any injury or fatality, an air bag deployed, any vehicle towed, or a pedestrian, cyclist or other non-motorist partner';
  const l2 = 'any injury or fatality, an air bag deployed, or a pedestrian, cyclist or other non-motorist partner (a tow-away alone does not count for Level 2)';
  return (
    <p className="small">
      <b>Threshold-robust crashes</b> meet a criterion that was reportable both before and after 2025-06-16: {kind === 'l2' ? l2 : kind === 'ads' ? ads : `for ADS programs ${ads}; for Level 2 ${l2}`}.
      Unknown fields count as not met, so this is a lower bound. Definition and its uncertainty: Data &amp; sources.
    </p>
  );
}
