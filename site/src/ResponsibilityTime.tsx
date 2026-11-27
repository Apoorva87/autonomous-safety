import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { Data } from './data';
import { fmt } from './data';
import { EChart } from './EChart';
import { PROGRAMS, PROGRAM_BY_KEY, LABEL_COLOR, colorOf, ui, type Mode } from './theme';
import { esc, fmtNum } from './lib/format';
import { CANNOT_NAME, OTHER_NAME, isL2, type RespRow } from './lib/responsibility';
import { OWN_KINDS, OWN_KIND_NAME, byHalfYear, crashLabels, ownKindCounts, type CrashLabel, type HalfPoint, MIN_LABELLED } from './lib/respTime';
import { countedCrashes, forestRows, quarterSeries, usableMonths, type QuarterPoint } from './lib/improve';
import { scopedCounts, useRatesData } from './data/rates';
import { monthlySeries } from './lib/learning';
import { useScenario } from './state/scenario';
import { RegimeBadge } from './components/Regime';

const pctText = (x: number, d = 0) => (x * 100).toFixed(d) + '%';
const ownName = (program: string) => (isL2(program) ? 'Own motion (driver or system)' : 'Own motion (ADS)');

/** Crash-level counts next to report-level labels, and what own motion consists of. */
export function CrashLevelSummary({ rows, mode }: { rows: RespRow[]; mode: Mode }) {
  const crashes = useMemo(() => crashLabels(rows), [rows]);
  const programs = PROGRAMS.map((p) => p.key).filter((k) => crashes.some((c) => c.program === k));
  return (
    <div>
      <h3>Per crash, not per report</h3>
      <p className="prose small">
        A crash can have several reports under one program (GM Cruise filed two for most of its crashes), so report counts overstate how many crashes there are.
        Here each crash counts once per program: it takes the label its labelled reports agree on, and is &ldquo;{CANNOT_NAME}&rdquo; when none is labelled or they disagree.
        &ldquo;Own motion&rdquo; is split by what was hit, because most of it is single-vehicle contact (curbs, poles, gates, debris) or animals, not striking another road user.
      </p>
      <div className="table-wrap">
        <table className="strip-table crash-level-table">
          <caption className="sr-only">Report labels and crash-level labels per program, with own-motion sub-kinds</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>Program</th>
              <th scope="col" rowSpan={2} className="num">Report labels</th>
              <th scope="col" rowSpan={2} className="num">Crashes</th>
              <th scope="col" rowSpan={2} className="num">{OTHER_NAME}</th>
              <th scope="col" rowSpan={2} className="num">Own motion</th>
              <th scope="col" rowSpan={2} className="num">{CANNOT_NAME}</th>
              <th scope="colgroup" colSpan={OWN_KINDS.length} className="own-group">Own motion, by what was hit (share of own motion)</th>
            </tr>
            <tr>
              {OWN_KINDS.map((k) => <th key={k} scope="col" className="num">{OWN_KIND_NAME[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => {
              const cs = crashes.filter((c) => c.program === p);
              const n = cs.length;
              const by = (l: CrashLabel['label']) => cs.filter((c) => c.label === l).length;
              const own = by('subject_vehicle_initiated');
              const kinds = ownKindCounts(cs);
              return (
                <tr key={p}>
                  <th scope="row"><i className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[p].color, mode) }} /> {PROGRAM_BY_KEY[p].short}</th>
                  <td className="num">{fmt(rows.filter((r) => r.program === p).length)}</td>
                  <td className="num"><b>{fmt(n)}</b></td>
                  <td className="num">{fmt(by('other_party'))} <span className="small">({pctText(by('other_party') / n)})</span></td>
                  <td className="num">{fmt(own)} <span className="small">({pctText(own / n)})</span></td>
                  <td className="num">{fmt(by('indeterminate'))} <span className="small">({pctText(by('indeterminate') / n)})</span></td>
                  {OWN_KINDS.map((k) => <td key={k} className="num">{own ? <>{fmt(kinds[k])} <span className="small">({pctText(kinds[k] / own)})</span></> : '0'}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        Own-motion sub-kinds are shares of that program&rsquo;s own-motion crashes. For Level 2 programs own motion means the driver or the system; NHTSA data cannot separate them. No total row: programs overlap for crashes reported by more than one company.
      </p>
    </div>
  );
}

/** Responsibility over time with a missingness guard (replaces the plain monthly label bars). */
export function TimeGuarded({ rows, data, mode }: { rows: RespRow[]; data: Data; mode: Mode }) {
  const crashes = useMemo(() => crashLabels(rows), [rows]);
  const programs = PROGRAMS.map((p) => p.key).filter((k) => crashes.some((c) => c.program === k));
  const t = ui(mode);
  return (
    <div>
      <p className="prose small">
        Is the inferred split changing, or only the share of crashes that can be labelled? Each row is one program, by half-year, one crash per program and incident.
        <b> Top:</b> the share of crashes that cannot be labelled because the pre-crash movement or contact area is missing (rule RESP-IND-1), grey.
        <b> Bottom:</b> own motion as a share of the crashes that <em>can</em> be labelled, with a Wilson 95% band, and a pale envelope: the own-motion share of all crashes if every
        &ldquo;{CANNOT_NAME}&rdquo; crash were other party (bottom edge) or own motion (top edge). Half-years with fewer than {MIN_LABELLED} labelled crashes are not drawn.
        A <b>⚠</b> marks a half-year whose missing share moved more than 10 points from the one before: it is not comparable with it.
      </p>
      <ul className="legend resp-legend" aria-label="Legend">
        <li><span className="seg-key" style={{ background: t.faint }} /> cannot be labelled: fields missing</li>
        <li><span className="seg-key" style={{ background: colorOf(LABEL_COLOR.subject_vehicle_initiated, mode) }} /> own motion among labelled, 95% band</li>
        <li><span className="seg-key" style={{ background: colorOf(LABEL_COLOR.subject_vehicle_initiated, mode), opacity: 0.25 }} /> envelope if every cannot-tell crash went one way</li>
        <li><span className="mk mk-break" /> 2025-06-16 rule change; the period after it is shaded</li>
      </ul>
      <div className="grid-panels resp-time-grid">
        {programs.map((p) => (
          <ProgramTime key={p} program={p} series={byHalfYear(crashes.filter((c) => c.program === p))} mode={mode} />
        ))}
      </div>
      <p className="small">
        Tesla Level 2&rsquo;s first filings are telematics stubs: in reports that were later revised, the first version has the pre-crash movement unknown about 9 times in 10 and the latest version about 2 in 10.
        Revisions largely stopped for incidents from 2024 on, so its cannot-tell share grew with how many follow-ups Tesla filed, not with how its vehicles crashed (see Transparency: reporting completeness).
        Own motion among the crashes that can be labelled stays close to flat. ADS crashes are reportable at almost any contact, Level 2 crashes only with an air bag, injury or similar, so the reporting thresholds shape the mix: these shares describe what gets reported, not fault.
      </p>
      {crashes.some((c) => c.program === 'waymo_ads') && <WaymoPerMile crashes={crashes} data={data} mode={mode} />}
    </div>
  );
}

function ProgramTime({ program, series, mode }: { program: string; series: HalfPoint[]; mode: Mode }) {
  const t = ui(mode);
  const own = colorOf(LABEL_COLOR.subject_vehicle_initiated, mode);
  const option = useMemo((): EChartsCoreOption => {
    const cats = series.map((s) => s.period);
    const breakIdx = cats.indexOf('2025H1');
    const postFrom = cats.indexOf('2025H2');
    const pct = (v: number | null | undefined) => (v == null ? null : v * 100);
    const shade = postFrom >= 0 ? { silent: true, itemStyle: { color: t.faint, opacity: 0.14 }, data: [[{ xAxis: postFrom - 0.5 }, { xAxis: cats.length - 0.5 }]] } : undefined;
    const breakLine = breakIdx >= 0 ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 1.5 }, data: [{ xAxis: breakIdx + 0.5 }] } : undefined;
    return {
      animation: false, textStyle: { color: t.muted },
      grid: [{ left: 40, right: 8, top: 6, height: 44 }, { left: 40, right: 8, top: 66, bottom: 24 }],
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
        formatter: (ps: any) => {
          const s = series[ps[0].dataIndex as number];
          if (!s) return '';
          const lines = [`<b>${esc(PROGRAM_BY_KEY[program].short)}, ${esc(s.period)}</b>`, `${fmt(s.n)} crashes, ${fmt(s.labelled)} labelled`];
          if (s.missingShare != null) lines.push(`Cannot be labelled (fields missing): ${pctText(s.missingShare)}`);
          if (s.ownShare) lines.push(`${esc(ownName(program))} among labelled: <b>${pctText(s.ownShare[0])}</b> (95% ${pctText(s.ownShare[1])} to ${pctText(s.ownShare[2])})`);
          else if (s.n) lines.push(`Fewer than ${MIN_LABELLED} labelled crashes: share not drawn`);
          if (s.envelope && s.n) lines.push(`Envelope over all crashes: ${pctText(s.envelope[0])} to ${pctText(s.envelope[1])}`);
          if (s.comparabilityBreak) lines.push('⚠ Comparability break: the missing share moved more than 10 points');
          return `<div style="font-size:12.5px;max-width:280px;white-space:normal">${lines.join('<br>')}</div>`;
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [
        { type: 'category', gridIndex: 0, data: cats, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } } },
        { type: 'category', gridIndex: 1, data: cats, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } },
          axisLabel: { color: t.muted, fontSize: 10, interval: 0, formatter: (v: string) => (v.endsWith('H1') ? v.slice(2, 4) + 'H1' : '') } },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, min: 0, max: 100, interval: 50, axisLabel: { color: t.muted, fontSize: 9, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.grid } } },
        { type: 'value', gridIndex: 1, min: 0, max: 100, interval: 25, axisLabel: { color: t.muted, fontSize: 9, formatter: '{value}%' }, splitLine: { lineStyle: { color: t.grid } } },
      ],
      series: [
        { name: 'missing', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: series.map((s) => (s.n ? pct(s.missingShare) : null)), symbol: 'none', connectNulls: false,
          lineStyle: { color: t.faint, width: 1 }, areaStyle: { color: t.faint, opacity: 0.55 }, markArea: shade, markLine: breakLine },
        { name: 'env-lo', type: 'line', xAxisIndex: 1, yAxisIndex: 1, stack: 'env', data: series.map((s) => (s.n && s.envelope ? pct(s.envelope[0]) : null)), symbol: 'none', lineStyle: { opacity: 0 }, connectNulls: false, silent: true, markArea: shade },
        { name: 'env', type: 'line', xAxisIndex: 1, yAxisIndex: 1, stack: 'env', data: series.map((s) => (s.n && s.envelope ? (s.envelope[1] - s.envelope[0]) * 100 : null)), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: own, opacity: 0.14 }, connectNulls: false, silent: true },
        { name: 'band-lo', type: 'line', xAxisIndex: 1, yAxisIndex: 1, stack: 'wil', data: series.map((s) => pct(s.ownShare?.[1])), symbol: 'none', lineStyle: { opacity: 0 }, connectNulls: false, silent: true },
        { name: 'band', type: 'line', xAxisIndex: 1, yAxisIndex: 1, stack: 'wil', data: series.map((s) => (s.ownShare ? (s.ownShare[2] - s.ownShare[1]) * 100 : null)), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: own, opacity: 0.32 }, connectNulls: false, silent: true },
        { name: 'own', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: series.map((s) => pct(s.ownShare?.[0])), symbol: 'circle', symbolSize: 6, connectNulls: false,
          lineStyle: { color: own, width: 2 }, itemStyle: { color: own, borderColor: t.surface, borderWidth: 1 }, markLine: breakLine,
          markPoint: { silent: true, symbol: 'circle', symbolSize: 1, label: { show: true, formatter: '⚠', color: t.ink, fontSize: 12, offset: [0, -2] },
            data: series.map((s, i) => (s.comparabilityBreak && s.ownShare ? { coord: [i, s.ownShare[0] * 100 + 12] } : null)).filter(Boolean) } },
      ],
    } as EChartsCoreOption;
  }, [series, program, mode, t, own]);
  const total = series.reduce((a, s) => a + s.n, 0);
  const breaks = series.filter((s) => s.comparabilityBreak).map((s) => s.period);
  return (
    <figure className="panel">
      <figcaption>
        <span className="panel-title"><i className="swatch" style={{ background: colorOf(PROGRAM_BY_KEY[program].color, mode) }} /> {PROGRAM_BY_KEY[program].short}</span>
        <span className="panel-total">{fmt(total)} dated crashes{breaks.length ? ` · comparability breaks: ${breaks.join(', ')}` : ''}</span>
      </figcaption>
      <EChart option={option} height={210} label={`${PROGRAM_BY_KEY[program].label}: share of crashes that cannot be labelled, and own motion among labelled crashes with a 95% band, by half-year`} />
    </figure>
  );
}

/** Waymo only: own-motion and other-party crashes per million miles by quarter, split at the rule change. */
function WaymoPerMile({ crashes, data, mode }: { crashes: CrashLabel[]; data: Data; mode: Mode }) {
  const { rates } = useRatesData();
  const [scenario] = useScenario();
  const t = ui(mode);
  const result = useMemo(() => {
    if (!rates) return null;
    const label = new Map(crashes.filter((c) => c.program === 'waymo_ads').map((c) => [c.incident_key, c.label]));
    const counts = scopedCounts(rates.countRows, data.crashes, 'waymo_ads', 'us', { riderOnly: scenario.riderOnly });
    const plain = { ...scenario, windowFactor: 1, lagAdjust: false, estimates: {}, countBy: 'crashes' as const };
    const pts = monthlySeries(counts, rates.exposure, plain, { program: 'waymo_ads', region: 'us', metric: 'perM', lastMonth: rates.lastMonth, lag: rates.lag.waymo_ads });
    const months = usableMonths(pts, rates.lag.waymo_ads, rates.lastMonth);
    const cs = countedCrashes(data.crashes, 'waymo_ads', scenario.riderOnly);
    const is = (l: string) => ({ id: 'robust' as const, label: l, threshold: l === 'other_party', test: (c: { incident_key: string }) => label.get(c.incident_key) === l });
    const own = is('subject_vehicle_initiated');
    const other = is('other_party');
    return {
      own: quarterSeries(cs, months, own.test, 1e6),
      other: quarterSeries(cs, months, other.test, 1e6),
      rr: forestRows(cs, months, 1e6, [own, other]),
    };
  }, [rates, crashes, data.crashes, scenario]);
  if (!result) return <p className="loading">Loading Waymo miles…</p>;
  const pre = result.own.filter((q) => q.regime === 'pre').map((q) => q.label);
  const order = [...pre, 'rule change', ...result.own.filter((q) => q.regime === 'post').map((q) => q.label)];
  const line = (qs: QuarterPoint[], key: 'rate' | 'lo' | 'hi'): (number | null)[] =>
    order.map((c) => (c === 'rule change' ? null : qs.find((q) => q.label === c)?.[key] ?? null));
  const ownC = colorOf(LABEL_COLOR.subject_vehicle_initiated, mode);
  const othC = colorOf(LABEL_COLOR.other_party, mode);
  const band = (qs: QuarterPoint[], color: string, id: string) => {
    const lo = line(qs, 'lo');
    return [
      { name: id + '-lo', type: 'line', stack: id, data: lo, symbol: 'none', lineStyle: { opacity: 0 }, connectNulls: false, silent: true },
      { name: id + '-band', type: 'line', stack: id, data: line(qs, 'hi').map((h, i) => (h == null ? null : h - (lo[i] ?? 0))), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.16 }, connectNulls: false, silent: true },
    ];
  };
  const option: EChartsCoreOption = {
    animation: false, textStyle: { color: t.muted },
    grid: { left: 40, right: 10, top: 14, bottom: 56 },
    tooltip: {
      trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.rule, textStyle: { color: t.ink },
      formatter: (ps: any) => {
        const c = order[ps[0].dataIndex as number];
        if (c === 'rule change') return '2025-06: mixed month, left out';
        const o = result.own.find((q) => q.label === c);
        const p = result.other.find((q) => q.label === c);
        return `<b>${esc(c)}</b><br>Own motion (ADS): ${o ? `<b>${fmtNum(o.rate)}</b> per M miles [${fmtNum(o.lo)}, ${fmtNum(o.hi)}], ${o.k} crashes` : 'n/a'}<br>${esc(OTHER_NAME)}: ${p ? `<b>${fmtNum(p.rate)}</b> [${fmtNum(p.lo)}, ${fmtNum(p.hi)}], ${p.k}` : 'n/a'}`;
      },
    },
    xAxis: { type: 'category', data: order, axisTick: { show: false }, axisLine: { lineStyle: { color: t.rule } }, axisLabel: { color: t.muted, fontSize: 10, interval: 0, rotate: 35 } },
    yAxis: { type: 'value', min: 0, name: 'crashes per million miles', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left' }, axisLabel: { color: t.muted, fontSize: 10 }, splitLine: { lineStyle: { color: t.grid } } },
    series: [
      ...band(result.other, othC, 'oth'),
      ...band(result.own, ownC, 'own'),
      { name: OTHER_NAME, type: 'line', data: line(result.other, 'rate'), connectNulls: false, symbol: 'circle', symbolSize: 7, lineStyle: { color: othC, width: 2 }, itemStyle: { color: othC } },
      { name: 'Own motion', type: 'line', data: line(result.own, 'rate'), connectNulls: false, symbol: 'circle', symbolSize: 7, lineStyle: { color: ownC, width: 2 }, itemStyle: { color: ownC },
        markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: mode === 'dark' ? '#e0693a' : '#b3361a', type: 'dashed', width: 1.5 }, data: [{ xAxis: pre.length }] } },
    ],
  };
  const [ownRow, otherRow] = result.rr;
  return (
    <figure className="panel" style={{ marginTop: 12 }}>
      <figcaption>
        <span className="panel-title">Waymo: inferred labels per million miles, by quarter (one crash per incident)</span>
        <span className="panel-total"><RegimeBadge /></span>
      </figcaption>
      <EChart option={option} height={260} label="Waymo own-motion and other-party crashes per million miles by quarter, with 95% bands, split at the 2025-06-16 rule change" />
      <ul className="legend rates-legend">
        <li><span className="swatch" style={{ background: othC }} /> {OTHER_NAME}</li>
        <li><span className="swatch" style={{ background: ownC }} /> Own motion (ADS)</li>
      </ul>
      <p className="small">
        Own motion per million miles, after ÷ before: <b>{ownRow.verdict.text}</b> Other party: {otherRow.verdict.text}
        {' '}Most of the other-party drop is struck-while-stopped contacts, exactly the minor crashes the rule change removed; so a rising own-motion <em>share</em> after 2025-06 comes from a shrinking denominator, not from more own-motion crashes per mile.
      </p>
    </figure>
  );
}
