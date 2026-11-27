import type { ReactNode } from 'react';

// A forest plot of rate ratios on a log axis, built as HTML rows with one small SVG strip each, so labels wrap
// on phones and every strip shares the same x scale. 1 = no change (solid reference line).

export type ForestItem = {
  key: string;
  label: ReactNode;
  /** Short text for the row's screen-reader label. */
  aria: string;
  rr: number | null;
  lo: number | null;
  hi: number | null;
  color: string;
  /** Hollow marker and dashed whisker: a count the reporting change is known to affect. */
  affected?: boolean;
  /** Greyed row with this text instead of a marker (no denominator, too few crashes). */
  empty?: string;
  right?: ReactNode;
};

const TICKS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
const W = 300;
const H = 22;

export function Forest({ items, min = 0.25, max = 4, caption }: { items: ForestItem[]; min?: number; max?: number; caption: string }) {
  const lmin = Math.log(min);
  const lmax = Math.log(max);
  const x = (v: number) => 8 + ((Math.log(Math.min(max, Math.max(min, v))) - lmin) / (lmax - lmin)) * (W - 16);
  const ticks = TICKS.filter((t) => t >= min && t <= max);
  return (
    <figure className="forest-grid" aria-label={caption}>
      <ul>
        {items.map((it) => (
          <li key={it.key} className={it.empty ? 'empty' : ''}>
            <span className="fg-label">{it.label}</span>
            <span className="fg-strip">
              {it.empty ? (
                <span className="small">{it.empty}</span>
              ) : (
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={it.aria}>
                  {ticks.map((t) => (
                    <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={H} className={t === 1 ? 'fg-ref' : 'fg-grid'} />
                  ))}
                  {it.lo != null && (
                    <line x1={x(it.lo)} x2={x(it.hi ?? max)} y1={H / 2} y2={H / 2} stroke={it.color} strokeWidth={2.5}
                      strokeDasharray={it.affected ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
                  )}
                  {it.hi == null && it.lo != null && <path d={`M${W - 10},${H / 2 - 4} L${W - 4},${H / 2} L${W - 10},${H / 2 + 4}`} fill="none" stroke={it.color} strokeWidth={1.5} />}
                </svg>
              )}
              {!it.empty && it.rr != null && (
                <span
                  className={`fg-dot${it.affected ? ' hollow' : ''}`}
                  style={{ left: `${(x(it.rr) / W) * 100}%`, borderColor: it.color, background: it.affected ? 'var(--surface)' : it.color }}
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="fg-right">{it.right}</span>
          </li>
        ))}
        <li className="fg-axis" aria-hidden="true">
          <span className="fg-label" />
          <span className="fg-strip">
            {ticks.map((t) => (
              <span key={t} className="fg-tick" style={{ left: `${(x(t) / W) * 100}%` }}>{`${t}×`}</span>
            ))}
          </span>
          <span className="fg-right" />
        </li>
      </ul>
      <figcaption className="small">
        Rate after ÷ rate before, logarithmic axis; 1× (solid line) means no change. Whiskers: exact 95% interval (conditional binomial).
        Hollow markers with dashed whiskers are counts the reporting change itself affects.
      </figcaption>
    </figure>
  );
}
