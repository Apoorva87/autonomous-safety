import { KIND_CAVEAT } from '../lib/kinds';

/** The standing caveat for any page where Level 2 and ADS programs can both appear. */
export function KindCaveat({ extra }: { extra?: string }) {
  return (
    <p className="kind-caveat callout small" role="note">
      <b>Not comparable.</b> {KIND_CAVEAT}{extra ? ' ' + extra : ''}
    </p>
  );
}
