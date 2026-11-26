import { fmtNum } from '../lib/format';

export type BarItem = {
  key: string;
  label: string;
  sub?: string;
  rate: number | null;
  lo: number | null;
  hi: number | null;
  lowSample: boolean;
  color: string;
  /** Shown instead of a bar when there is no rate. */
  reason?: string;
};

/** Sorted horizontal bars with a 95% interval whisker. Hatched = low sample or estimated exposure. Plain HTML so it wraps on phones. */
export function RateBars({ items, unit, ariaLabel }: { items: BarItem[]; unit: string; ariaLabel: string }) {
  const max = Math.max(0, ...items.map((i) => i.hi ?? i.rate ?? 0)) * 1.04 || 1;
  const sorted = [...items].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <ul className="ratebars" aria-label={ariaLabel}>
      {sorted.map((i) => (
        <li key={i.key} className={i.rate == null ? 'nodata' : ''}>
          <span className="rb-label">
            {i.label}
            {i.sub && <span className="small"> {i.sub}</span>}
          </span>
          <span
            className="rb-track"
            title={i.rate == null ? i.reason : `${fmtNum(i.rate)} ${unit}, 95% interval ${fmtNum(i.lo)} to ${fmtNum(i.hi)}${i.lowSample ? ' (low sample or estimated miles)' : ''}`}
          >
            {i.rate != null && (
              <>
                <i className={i.lowSample ? 'rb-bar hatched' : 'rb-bar'} style={{ width: pct(i.rate), color: i.color, background: i.lowSample ? undefined : i.color }} />
                {i.lo != null && i.hi != null && (
                  <i className="rb-ci" style={{ left: pct(i.lo), width: `calc(${pct(i.hi)} - ${pct(i.lo)})` }} />
                )}
              </>
            )}
          </span>
          <span className="rb-val num">
            {i.rate == null ? <span className="small">no data</span> : <b>{fmtNum(i.rate)}</b>}
            {i.rate != null && i.lo != null && i.hi != null && (
              <span className="small"> ({fmtNum(i.lo)} to {fmtNum(i.hi)})</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
