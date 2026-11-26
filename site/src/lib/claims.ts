import type { CompanyRow } from '../data/rates';

export type Forest = {
  metric: string;
  outcome: string;
  period: string;
  pct: number;
  lo: number | null;
  hi: number | null;
  crashes: number | null;
  predicted: number | null;
};

/** Waymo hub comparison rows from company_reported.json (latest period per outcome). The 95% interval and predicted count live in the row's note text. */
export function waymoBenchmark(rows: CompanyRow[]): Forest[] {
  const pct = rows.filter(
    (r) => r.program === 'waymo_ads' && r.metric.endsWith('_pct_diff_vs_benchmark') && !r.metric.startsWith('bi_') && !r.metric.startsWith('pd_'),
  );
  const out: Forest[] = [];
  for (const metric of [...new Set(pct.map((r) => r.metric))]) {
    const latest = pct.filter((r) => r.metric === metric).sort((a, b) => b.period.localeCompare(a.period))[0];
    const m = /Benchmark '([^']+)'; 95% CI (-?[\d.]+)% to (-?[\d.]+)%; Waymo ([\d.]+) crash(?:es)? vs ([\d.]+) predicted/.exec(latest.method_note);
    out.push({
      metric, period: latest.period, pct: latest.value,
      outcome: m ? m[1] : metric.replace(/_pct_diff_vs_benchmark$/, '').replace(/_/g, ' '),
      lo: m ? Number(m[2]) : null, hi: m ? Number(m[3]) : null,
      crashes: m ? Number(m[4]) : null, predicted: m ? Number(m[5]) : null,
    });
  }
  return out.sort((a, b) => (b.predicted ?? 0) - (a.predicted ?? 0));
}
