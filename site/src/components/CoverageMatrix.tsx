import { useMemo } from 'react';
import type { ExposureRow, Kind } from '../lib/metrics';
import { PROGRAMS } from '../theme';

type Cell = { kind: Kind | 'none' | 'regional' | 'pre'; note: string };
const RANK: Record<Kind, number> = { reported: 0, derived: 1, estimate: 2 };
const NATIONAL = new Set(['us', 'north_america']);

function cellFor(rows: ExposureRow[], program: string, metric: string, year: number): Cell {
  if (year < 2021) return { kind: 'pre', note: 'SGO reporting began 2021-07' };
  const mine = rows.filter((r) => r.program === program && r.metric === metric && (r.period === String(year) || r.period.startsWith(year + '-')));
  const nat = mine.filter((r) => NATIONAL.has(r.region));
  if (nat.length) {
    const annual = nat.find((r) => r.period === String(year));
    const kind = annual ? annual.kind : nat.reduce((k, r) => (RANK[r.kind] > RANK[k] ? r.kind : k), 'reported' as Kind);
    const months = nat.filter((r) => r.period.length === 7).length;
    return { kind, note: annual ? `annual ${kind}` : `${months} monthly row(s), ${kind}` };
  }
  if (mine.length) {
    const regions = [...new Set(mine.map((r) => r.region))].join(', ');
    return { kind: 'regional', note: `only ${regions}: not a US denominator` };
  }
  return { kind: 'none', note: 'no disclosure' };
}

const SHORT: Record<string, string> = { reported: 'rep', derived: 'der', estimate: 'est', none: 'none', regional: 'region', pre: '' };

/** Program x year: which exposure disclosures exist, and of what kind. */
export function CoverageMatrix({ exposure, lastYear }: { exposure: ExposureRow[]; lastYear: number }) {
  const years = useMemo(() => Array.from({ length: lastYear - 2019 + 1 }, (_, i) => 2019 + i), [lastYear]);
  const rows = useMemo(
    () =>
      PROGRAMS.flatMap((p) =>
        (['miles', 'active_vehicles'] as const).map((m) => ({
          key: `${p.key}:${m}`, program: p.short, metric: m === 'miles' ? 'miles' : 'vehicles',
          cells: years.map((y) => cellFor(exposure, p.key, m, y)),
        })),
      ),
    [exposure, years],
  );
  return (
    <div className="table-wrap">
      <table className="coverage">
        <caption className="sr-only">Exposure coverage by program and year</caption>
        <thead>
          <tr>
            <th scope="col">Program</th>
            <th scope="col">Exposure</th>
            {years.map((y) => (
              <th scope="col" key={y} className="num">{y}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.metric === 'miles' ? r.program : ''}</th>
              <td className="small">{r.metric}</td>
              {r.cells.map((c, i) => (
                <td key={i} className={`cov cov-${c.kind}`} title={`${r.program} ${r.metric} ${years[i]}: ${c.note}`}>
                  {SHORT[c.kind]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
