import { useState } from 'react';
import { BREAK_DATE } from '../lib/metrics';
import { fmtNum } from '../lib/format';
import { dateMs } from '../lib/timeline';
import { ui, type Mode } from '../theme';

export type SparkPt = { period: string; t: number; rate: number; lo: number; hi: number; lowSample: boolean; k: number; recent?: boolean };

/** One small-multiple panel: a quarterly rate line with its 95% band on a y-axis shared across panels. */
export function Spark({
  title,
  sub,
  points,
  t0,
  t1,
  yMax,
  color,
  mode,
  unit,
}: {
  title: string;
  sub?: string;
  points: SparkPt[];
  t0: number;
  t1: number;
  yMax: number;
  color: string;
  mode: Mode;
  unit: string;
}) {
  const t = ui(mode);
  const [hover, setHover] = useState<SparkPt | null>(null);
  const W = 260;
  const H = 120;
  const m = { l: 34, r: 8, t: 8, b: 20 };
  const x = (ms: number) => m.l + ((ms - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v: number) => m.t + (1 - Math.min(v, yMax) / yMax) * (H - m.t - m.b);
  const years: number[] = [];
  for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) years.push(yr);
  const band =
    points.length > 1
      ? 'M' + points.map((p) => `${x(p.t)},${y(p.hi)}`).join('L') + 'L' + [...points].reverse().map((p) => `${x(p.t)},${y(p.lo)}`).join('L') + 'Z'
      : '';
  const line = points.length > 1 ? 'M' + points.map((p) => `${x(p.t)},${y(p.rate)}`).join('L') : '';
  const breakX = x(dateMs(BREAK_DATE));
  const showBreak = breakX >= m.l && breakX <= W - m.r;
  const last = points[points.length - 1];
  const hatchId = `sp-${title.replace(/\W/g, '')}`;
  return (
    <figure className="spark">
      <figcaption>
        <b>{title}</b>
        {sub && <span className="small"> {sub}</span>}
        <span className="small spark-read">
          {hover ? `${hover.period}: ${fmtNum(hover.rate)} (${fmtNum(hover.lo)} to ${fmtNum(hover.hi)}), ${hover.k} crashes` : last ? `latest ${last.period}: ${fmtNum(last.rate)}` : 'no quarter with miles'}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: quarterly ${unit}, ${points.length} quarters${last ? `, latest ${fmtNum(last.rate)}` : ''}`}>
        <defs>
          <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke={color} strokeWidth="1.5" />
          </pattern>
        </defs>
        {[0, yMax / 2, yMax].map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={t.grid} />
            <text x={m.l - 4} y={y(v) + 3} textAnchor="end" fontSize="9" fill={t.muted}>{fmtNum(v)}</text>
          </g>
        ))}
        {years.map((yr) => (
          <text key={yr} x={x(Date.UTC(yr, 0, 1))} y={H - 6} textAnchor="middle" fontSize="9" fill={t.muted}>{yr}</text>
        ))}
        {showBreak && <line x1={breakX} x2={breakX} y1={m.t} y2={H - m.b} stroke="#b3361a" strokeDasharray="3 3" />}
        {band && <path d={band} fill={color} opacity={0.18} />}
        {line && <path d={line} fill="none" stroke={color} strokeWidth={2} />}
        {points.map((p) => (
          <g key={p.period}>
            <circle
              cx={x(p.t)} cy={y(p.rate)} r={4}
              fill={p.lowSample ? t.surface : color} stroke={color} strokeWidth={2}
              onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)}
            >
              <title>{`${p.period}: ${fmtNum(p.rate)} ${unit} (95% ${fmtNum(p.lo)} to ${fmtNum(p.hi)}), ${p.k} crashes${p.lowSample ? ', low sample or estimated miles' : ''}${p.recent ? ', recent: reports still arriving' : ''}`}</title>
            </circle>
            {p.lowSample && <circle cx={x(p.t)} cy={y(p.rate)} r={2.2} fill={`url(#${hatchId})`} pointerEvents="none" />}
          </g>
        ))}
      </svg>
    </figure>
  );
}
