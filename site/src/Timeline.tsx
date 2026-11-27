import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data } from './data';
import { PROGRAMS, PROGRAM_BY_KEY, colorOf, ui, type Mode } from './theme';
import { scopedCounts, useRatesData, type EventRow, type InvestigationRow, type RatesData, type SourceRow } from './data/rates';
import { defaultRegion } from './Rates';
import { monthlySeries } from './lib/learning';
import { BREAK_DATE, type Metric, type Point } from './lib/metrics';
import { fmtNum } from './lib/format';
import {
  COMPANY_PROGRAMS, dateMs, laneOfEvent, makeScale, makeTicks, niceCeil, msToDate, msToMonth, packLanes, panRange,
  periodForEvent, periodForInvestigation, zoomRange, type Range,
} from './lib/timeline';
import { setQuery, useQuery, useScenario } from './state/scenario';
import { getList, setList, toggleIn } from './state/viewstate';
import { ChipGroup } from './components/ChipGroup';
import { SourcesCtx } from './components/SourceBadge';
import { SourceNote } from './EChart';

const DAY = 86_400_000;
const METRICS: { id: Metric; label: string; axis: string }[] = [
  { id: 'perM', label: 'Crashes per million miles', axis: 'crashes per million miles' },
  { id: 'per10kVeh', label: 'Crashes per 10,000 vehicles', axis: 'crashes per 10,000 vehicles' },
  { id: 'count', label: 'Crash count', axis: 'unique crashes per month' },
];
const LANE_LABEL: Record<string, string> = { launch: 'Launch', recall: 'Recall', suspension: 'Suspend', regulatory: 'Rules', other: 'Other' };
const LANES = ['launch', 'recall', 'suspension', 'regulatory', 'other'];

const COMPANY_COLOR = (company: string, mode: Mode): string => {
  const p = COMPANY_PROGRAMS[company]?.[0];
  return p ? colorOf(PROGRAM_BY_KEY[p].color, mode) : ui(mode).muted;
};
const BRK = (mode: Mode) => (mode === 'dark' ? '#f08a72' : '#b3361a');
const safeUrl =(u: string) => (/^https?:\/\//i.test(u) ? u : '');

type Sel = { kind: 'event'; e: EventRow } | { kind: 'inv'; i: InvestigationRow } | null;
type Series = { prog: string; label: string; color: string; region: string; metric: Metric; pts: Point[] };

export function Timeline({ data, mode }: { data: Data; mode: Mode }) {
  const { rates, error } = useRatesData();
  if (error) return <p className="error">Could not load the timeline data files ({error}).</p>;
  if (!rates) return <p className="loading">Loading events, investigations and counts…</p>;
  return <TimelineLoaded data={data} rates={rates} mode={mode} />;
}

function TimelineLoaded({ data, rates, mode }: { data: Data; rates: RatesData; mode: Mode }) {
  const params = useQuery();
  const [scenario] = useScenario();
  const t = ui(mode);

  const bounds: Range = useMemo(() => {
    const [y, m] = rates.lastMonth.split('-').map(Number);
    return { t0: dateMs('2021-06-01'), t1: Date.UTC(y, m, 1) };
  }, [rates.lastMonth]);
  const parsed = (k: string, d: number) => {
    const v = params.get(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dateMs(v) : d;
  };
  const range: Range = { t0: parsed('tz0', bounds.t0), t1: parsed('tz1', bounds.t1) };
  const zoomed = range.t0 !== bounds.t0 || range.t1 !== bounds.t1;
  const setRange = (r: Range) => {
    const same = r.t0 <= bounds.t0 && r.t1 >= bounds.t1;
    setQuery({ tz0: same ? null : msToDate(r.t0), tz1: same ? null : msToDate(r.t1) });
  };

  const picked = getList(params, 'tpg').filter((p) => PROGRAM_BY_KEY[p]);
  const progs = picked.length ? picked : ['waymo_ads'];
  const metric = (METRICS.find((m) => m.id === params.get('tm'))?.id ?? 'perM') as Metric;
  const allCompanies = params.get('tall') === '1';

  const series: Series[] = useMemo(
    () =>
      progs.map((prog) => {
        const region = defaultRegion(rates, prog, metric);
        const counts = scopedCounts(rates.countRows, data.crashes, prog, region === 'global' ? 'us' : region);
        const pts = monthlySeries(counts, rates.exposure, scenario, { program: prog, region, metric, lastMonth: rates.lastMonth, lag: rates.lag[prog] });
        return { prog, label: PROGRAM_BY_KEY[prog].short, color: colorOf(PROGRAM_BY_KEY[prog].color, mode), region, metric, pts };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progs.join('|'), metric, rates, data.crashes, scenario, mode],
  );

  const events = useMemo(
    () => rates.events.filter((e) => allCompanies || e.company === 'all' || progs.includes(e.program) || (e.program === '' && e.company === 'all')),
    [rates.events, progs.join('|'), allCompanies], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const invs = useMemo(
    () => rates.investigations.filter((i) => allCompanies || progs.some((p) => (COMPANY_PROGRAMS[i.company] ?? []).includes(p))),
    [rates.investigations, progs.join('|'), allCompanies], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const invEnd = (i: InvestigationRow) => (i.closed ? dateMs(i.closed) : bounds.t1);
  const packed = useMemo(
    () => packLanes(invs.map((i) => ({ id: i.investigation_id, start: dateMs(i.opened), end: invEnd(i) })), 20 * DAY),
    [invs, bounds.t1], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- geometry ----
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setW(Math.max(320, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(320, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  const narrow = w < 560;
  const L = narrow ? 52 : 84;
  const R = 10;
  const rateH = 210;
  const laneH = 22;
  const invH = 20;
  const yRate0 = 8;
  const yAxis = yRate0 + rateH;
  const yEv0 = yAxis + 26;
  const yInv0 = yEv0 + LANES.length * laneH + 22;
  const H = yInv0 + Math.max(1, packed.lanes) * invH + 14;
  const sc = makeScale(range, L, w - R);
  const inView = (ms: number) => ms >= range.t0 && ms <= range.t1;

  const allVals = series.flatMap((s) => s.pts.filter((p) => p.rate != null).map((p) => p.rate as number));
  const yMax = niceCeil((allVals.length ? Math.max(...allVals) : 1) * 1.1);
  const yOf = (v: number) => yRate0 + (1 - Math.min(v, yMax) / yMax) * rateH;

  // ---- interaction ----
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const xIn = (e: { clientX: number }) => e.clientX - svg.current!.getBoundingClientRect().left;

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const x = xIn(e);
    if (x < L || x > w - R) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setBrush({ a: x, b: x });
  };
  const onMove = (e: React.PointerEvent) => {
    const x = xIn(e);
    if (brush) setBrush({ a: brush.a, b: Math.min(w - R, Math.max(L, x)) });
    setHoverX(x >= L && x <= w - R ? x : null);
  };
  const onUp = () => {
    if (brush && Math.abs(brush.b - brush.a) > 6) {
      const a = sc.t(Math.min(brush.a, brush.b));
      const b = sc.t(Math.max(brush.a, brush.b));
      setRange(zoomRange({ t0: a, t1: b }, 1, 0, bounds));
    }
    setBrush(null);
  };
  const zoomBy = (f: number) => setRange(zoomRange(range, f, 0.5, bounds));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setRange(panRange(range, -0.2, bounds));
    else if (e.key === 'ArrowRight') setRange(panRange(range, 0.2, bounds));
    else if (e.key === '+' || e.key === '=') zoomBy(0.6);
    else if (e.key === '-') zoomBy(1 / 0.6);
    else if (e.key === 'Escape') {
      setSel(null);
      setTip(null);
    } else return;
    e.preventDefault();
  };

  // nearest month under the cursor
  const hoverMonth = hoverX == null ? null : msToMonth(sc.t(hoverX));
  const hoverRows =
    hoverMonth == null
      ? []
      : series.map((s) => ({ s, p: s.pts.find((p) => p.period === hoverMonth) })).filter((r) => r.p);

  const goExplorer = (from: string, to: string, programs: string[]) => {
    setQuery({ xf: from, xt: to, xp: programs.length ? programs.join(',') : null, xl: null });
    window.location.hash = 'explorer';
  };

  const presets: { label: string; r: Range }[] = [
    { label: 'All', r: bounds },
    { label: '2025 on', r: { t0: dateMs('2025-01-01'), t1: bounds.t1 } },
    { label: 'Last 12 months', r: { t0: Math.max(bounds.t0, bounds.t1 - 365 * DAY), t1: bounds.t1 } },
    { label: 'Around the rule change', r: { t0: dateMs('2024-12-01'), t1: Math.min(bounds.t1, dateMs('2026-06-01')) } },
  ];

  const info = METRICS.find((m) => m.id === metric)!;
  const segments = (s: Series) => {
    const segs: Point[][] = [];
    let cur: Point[] = [];
    for (const p of s.pts) {
      if (p.rate == null || !inView(dateMs(p.period + '-15') + 40 * DAY) && !inView(dateMs(p.period + '-15') - 40 * DAY)) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length) segs.push(cur);
    return segs;
  };
  const px = (p: Point) => sc.x(dateMs(p.period + '-15'));
  const noRate = series.filter((s) => s.pts.every((p) => p.rate == null));
  const ticks = makeTicks(range);
  const breakX = sc.x(dateMs(BREAK_DATE));
  const showBreak = inView(dateMs(BREAK_DATE));

  const eventLabel = (e: EventRow) => `${e.date}${e.date_precision !== 'day' ? ' (' + e.date_precision + ' only)' : ''}: ${e.label}`;

  return (
    <SourcesCtx.Provider value={rates.sources}>
      <section className="timeline">
        <h2>Timeline: rates, events and investigations together</h2>
        <p className="prose">
          The curve is the monthly rate for the programs you pick. Underneath, one track per kind of event and one for NHTSA investigations (opened to closed).
          <b> Drag across the chart to zoom to a period</b>; click an event or investigation for its sources and to open that period in the crash explorer.
          Events are context, not causes: a launch or recall next to a change in rate proves nothing by itself.
        </p>

        <div className="rates-controls">
          <ChipGroup
            legend="Programs on the curve"
            options={PROGRAMS.map((p) => ({ value: p.key, label: p.short, color: colorOf(p.color, mode) }))}
            selected={progs}
            onToggle={(v) => setList('tpg', toggleIn(progs, v))}
          />
        </div>
        <div className="controls">
          <label className="field">
            Curve
            <select value={metric} onChange={(e) => setQuery({ tm: e.target.value === 'perM' ? null : e.target.value })}>
              {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={allCompanies} onChange={(e) => setQuery({ tall: e.target.checked ? '1' : null })} />
            Show events and investigations for every company
          </label>
          <div className="field">
            Zoom
            <div className="seg" role="group" aria-label="Zoom">
              <button type="button" onClick={() => zoomBy(0.6)}>In</button>
              <button type="button" onClick={() => zoomBy(1 / 0.6)}>Out</button>
              <button type="button" onClick={() => setRange(panRange(range, -0.3, bounds))} aria-label="Pan earlier">Earlier</button>
              <button type="button" onClick={() => setRange(panRange(range, 0.3, bounds))} aria-label="Pan later">Later</button>
            </div>
          </div>
          <div className="field">
            Jump to
            <div className="seg" role="group" aria-label="Preset ranges">
              {presets.map((p) => (
                <button key={p.label} type="button" onClick={() => setRange(p.r)}>{p.label}</button>
              ))}
            </div>
          </div>
        </div>
        <p className="small" aria-live="polite">
          Showing {msToDate(range.t0)} to {msToDate(range.t1)}
          {zoomed && ' (zoomed; "All" resets)'}. Keyboard: focus the chart, then arrow keys pan and + / - zoom.
        </p>

        <figure className="panel timeline-panel" ref={wrap}>
          <figcaption>
            <span className="panel-title">
              {info.label}, monthly
            </span>
            <span className="panel-total">
              Lines: monthly rate with its exact Poisson 95% band, gaps where no exposure is disclosed · hollow markers: low sample or estimated exposure
            </span>
          </figcaption>
          <svg
            ref={svg} width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="tl-svg" tabIndex={0} onKeyDown={onKey}
            role="group" aria-label={`Timeline from ${msToDate(range.t0)} to ${msToDate(range.t1)}: ${info.label} for ${series.map((s) => s.label).join(', ')}, with event and investigation tracks`}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHoverX(null)}
            style={{ touchAction: 'pan-y' }}
          >
            <defs>
              <clipPath id="tl-clip"><rect x={L} y={0} width={w - L - R} height={H} /></clipPath>
              <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke={t.surface} strokeWidth="2" opacity="0.7" />
              </pattern>
            </defs>
            {/* axes and grid */}
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={L} x2={w - R} y1={yRate0 + (1 - f) * rateH} y2={yRate0 + (1 - f) * rateH} stroke={t.grid} />
                <text x={L - 6} y={yRate0 + (1 - f) * rateH + 3.5} textAnchor="end" fontSize="10.5" fill={t.muted}>{fmtNum(yMax * f)}</text>
              </g>
            ))}
            <text x={L} y={yRate0 - 1} fontSize="10.5" fill={t.muted} dy="-0.1em" />
            <text transform={`translate(11 ${yRate0 + rateH / 2}) rotate(-90)`} textAnchor="middle" fontSize="10.5" fill={t.muted}>{narrow ? '' : info.axis}</text>
            {ticks.map((tk) => (
              <g key={tk.t}>
                <line x1={sc.x(tk.t)} x2={sc.x(tk.t)} y1={yRate0} y2={H - 8} stroke={t.grid} strokeOpacity={tk.major ? 1 : 0.5} />
                <text x={sc.x(tk.t) + 3} y={yAxis + 14} fontSize="10.5" fill={t.muted} fontWeight={tk.major ? 600 : 400}>{tk.label}</text>
              </g>
            ))}
            <line x1={L} x2={w - R} y1={yAxis} y2={yAxis} stroke={t.rule} />

            <g clipPath="url(#tl-clip)">
              {/* rate curves */}
              {series.map((s) => (
                <g key={s.prog}>
                  {segments(s).map((seg, i) => {
                    const band =
                      seg.length > 1
                        ? 'M' + seg.map((p) => `${px(p)},${yOf(p.hi ?? p.rate!)}`).join('L') + 'L' + [...seg].reverse().map((p) => `${px(p)},${yOf(p.lo ?? p.rate!)}`).join('L') + 'Z'
                        : '';
                    return (
                      <g key={i}>
                        {band && <path d={band} fill={s.color} opacity={0.16} />}
                        {seg.length > 1 && <path d={'M' + seg.map((p) => `${px(p)},${yOf(p.rate!)}`).join('L')} fill="none" stroke={s.color} strokeWidth={2} />}
                        {seg.map((p) => (
                          <circle key={p.period} cx={px(p)} cy={yOf(p.rate!)} r={seg.length > 24 ? 2.2 : 3.5} fill={p.lowSample ? t.surface : s.color} stroke={s.color} strokeWidth={1.6} />
                        ))}
                        {seg.filter((p) => p.flag).map((p) => (
                          <g key={'flag' + p.period} transform={`translate(${px(p) - 1},${yOf(p.rate!) - 22})`} style={{ color: BRK(mode) }} role="img" aria-label={`${p.period}: unreliable monthly exposure. ${p.flag}`}>
                            <title>{`${p.period}: ${p.flag}`}</title>
                            <rect x={-3} y={-2} width={18} height={20} fill="transparent" />
                            <path d="M0 0h1.4v13H0z M1.4 0.6H10L7.8 3.8L10 7H1.4z" fill="currentColor" />
                          </g>
                        ))}
                      </g>
                    );
                  })}
                </g>
              ))}
              {showBreak && (
                <g>
                  <line x1={breakX} x2={breakX} y1={yRate0} y2={H - 8} stroke={BRK(mode)} strokeDasharray="4 3" strokeWidth={1.5} />
                  <text x={breakX > w - 190 ? breakX - 4 : breakX + 4} y={yRate0 + 11} textAnchor={breakX > w - 190 ? 'end' : 'start'} fontSize="10.5" fill={BRK(mode)}>2025-06-16 NHTSA rule change</text>
                </g>
              )}

              {/* event tracks */}
              {LANES.map((lane, li) => (
                <line key={lane} x1={L} x2={w - R} y1={yEv0 + li * laneH + laneH / 2} y2={yEv0 + li * laneH + laneH / 2} stroke={t.grid} />
              ))}
              {events.map((e, idx) => {
                const ms = dateMs(e.date);
                if (!inView(ms)) return null;
                const li = LANES.indexOf(laneOfEvent(e.type));
                const cx = sc.x(ms);
                const cy = yEv0 + li * laneH + laneH / 2;
                const color = COMPANY_COLOR(e.company, mode);
                const on = sel?.kind === 'event' && sel.e === e;
                return (
                  <g
                    key={idx} role="button" tabIndex={0} aria-label={eventLabel(e)} style={{ cursor: 'pointer', outline: 'none' }}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={() => setSel({ kind: 'event', e })}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSel({ kind: 'event', e }); } }}
                    onMouseEnter={() => setTip({ x: cx, y: cy, lines: [e.date, e.label] })}
                    onMouseLeave={() => setTip(null)}
                    onFocus={() => setTip({ x: cx, y: cy, lines: [e.date, e.label] })}
                    onBlur={() => setTip(null)}
                  >
                    <rect x={cx - 11} y={cy - 11} width={22} height={22} fill="transparent" />
                    <path
                      d={`M${cx} ${cy - 7}L${cx + 7} ${cy}L${cx} ${cy + 7}L${cx - 7} ${cy}Z`}
                      fill={e.date_precision === 'day' ? color : t.surface} stroke={on ? t.ink : color} strokeWidth={on ? 3 : 2}
                    />
                  </g>
                );
              })}

              {/* investigation tracks */}
              {invs.map((i) => {
                const a = dateMs(i.opened);
                const b = invEnd(i);
                if (b < range.t0 || a > range.t1) return null;
                const x0 = Math.max(L, sc.x(a));
                const x1 = Math.min(w - R, sc.x(b));
                const lane = packed.lane[i.investigation_id] ?? 0;
                const y = yInv0 + lane * invH;
                const color = COMPANY_COLOR(i.company, mode);
                const on = sel?.kind === 'inv' && sel.i === i;
                const label = `${i.investigation_id}${x1 - x0 > 150 ? ' ' + i.subject : ''}`;
                return (
                  <g
                    key={i.investigation_id} role="button" tabIndex={0}
                    aria-label={`${i.investigation_id}, ${i.type}, ${i.subject}, opened ${i.opened}${i.closed ? ', closed ' + i.closed : ', still open'}`}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onClick={() => setSel({ kind: 'inv', i })}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSel({ kind: 'inv', i }); } }}
                    onMouseEnter={() => setTip({ x: (x0 + x1) / 2, y: y + invH / 2, lines: [`${i.investigation_id} (${i.type}) ${i.opened} to ${i.closed || 'open'}`, i.subject] })}
                    onMouseLeave={() => setTip(null)}
                    onFocus={() => setTip({ x: (x0 + x1) / 2, y: y + invH / 2, lines: [`${i.investigation_id} (${i.type}) ${i.opened} to ${i.closed || 'open'}`, i.subject] })}
                    onBlur={() => setTip(null)}
                  >
                    <rect x={x0} y={y + 2} width={Math.max(3, x1 - x0)} height={invH - 5} rx={3} fill={color} opacity={i.closed ? 0.9 : 0.55} stroke={on ? t.ink : color} strokeWidth={on ? 3 : 1} />
                    {!i.closed && <rect x={x0} y={y + 2} width={Math.max(3, x1 - x0)} height={invH - 5} rx={3} fill="url(#tl-hatch)" pointerEvents="none" />}
                    {x1 - x0 > 52 && (
                      <text x={x0 + 4} y={y + invH / 2 + 3.5} fontSize="10.5" fontWeight={600} fill="#fff" stroke="rgba(0,0,0,0.55)" strokeWidth={2.5} paintOrder="stroke" pointerEvents="none">
                        {label.length > (x1 - x0) / 6 ? label.slice(0, Math.floor((x1 - x0) / 6)) : label}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* hover crosshair */}
              {hoverX != null && !brush && <line x1={hoverX} x2={hoverX} y1={yRate0} y2={yAxis} stroke={t.ink} strokeOpacity={0.35} />}
              {brush && (
                <rect x={Math.min(brush.a, brush.b)} y={yRate0} width={Math.abs(brush.b - brush.a)} height={H - yRate0 - 8} fill={t.ink} opacity={0.12} stroke={t.ink} strokeOpacity={0.5} />
              )}
            </g>

            {/* lane labels */}
            {LANES.map((lane, li) => (
              <text key={lane} x={L - 6} y={yEv0 + li * laneH + laneH / 2 + 3.5} textAnchor="end" fontSize="10.5" fill={t.muted}>{LANE_LABEL[lane]}</text>
            ))}
            <text x={L - 6} y={yInv0 + invH / 2 + 3.5} textAnchor="end" fontSize="10.5" fill={t.muted}>NHTSA</text>
            <text x={L - 6} y={yInv0 + invH / 2 + 15} textAnchor="end" fontSize="10.5" fill={t.muted}>probes</text>
          </svg>
          {tip && (
            <div className="tip tl-tip" role="status" style={{ left: Math.min(Math.max(8, tip.x + 10), w - 230), top: tip.y + 40 }}>
              <b>{tip.lines[0]}</b>
              <span>{tip.lines[1]}</span>
            </div>
          )}
          {hoverRows.length > 0 && hoverX != null && !brush && (
            <div className="tip tl-tip" role="status" style={{ left: Math.min(hoverX + 12, w - 230), top: 60 }}>
              <b>{hoverMonth}</b>
              {hoverRows.map(({ s, p }) => (
                <span key={s.prog}>
                  {s.label}: {p!.rate == null ? 'no exposure' : fmtNum(p!.rate)}
                  {p!.rate != null && p!.lo != null && p!.hi != null && metric !== 'count' ? ` (${fmtNum(p!.lo)} to ${fmtNum(p!.hi)})` : ''}
                  {p!.rate != null ? `, ${p!.k} crashes` : ''}
                  {p!.flag ? ` \u2691 exposure for this month is unreliable (${p!.flag})` : ''}
                </span>
              ))}
            </div>
          )}
          <ul className="legend tl-legend">
            {series.map((s) => (
              <li key={s.prog}><span className="swatch" style={{ background: s.color }} /> {s.label}</li>
            ))}
            <li><span className="mk mk-break" /> 2025-06-16 rule change (not a safety change)</li>
            <li>◆ filled: dated to the day · ◇ hollow: month only</li>
            <li><span className="flag-icon">⚑</span> unreliable month: exposure split from very uneven disclosures (&gt;3×)</li>
            <li>Probe bars: solid = closed, hatched = open</li>
          </ul>
          <p className="small" style={{ padding: '0 6px' }}>
            The last two or three months always sit low: reports are still arriving (the Rates tab can adjust for late reports).
          </p>
          {noRate.length > 0 && (
            <p className="small">
              No exposure is disclosed for {noRate.map((s) => s.label).join(', ')} with this curve, so it shows no line rather than a zero. Choose "Crash count" to see their months.
            </p>
          )}
        </figure>

        <div className="tl-detail" aria-live="polite">
          {sel ? <Detail sel={sel} sources={rates.sources} lastMonth={rates.lastMonth} close={() => setSel(null)} go={goExplorer} /> : <p className="small">Select an event or an investigation for its details and sources.</p>}
        </div>
        <SourceNote date={data.meta.fetched_date} extra="Rates: see the Rates tab for denominators. Events: events.json; investigations: NHTSA ODI (investigations.json). Each item links to its sources." />
      </section>
    </SourcesCtx.Provider>
  );
}

function SourceLinks({ ids, sources }: { ids: string[]; sources: Record<string, SourceRow> }) {
  return (
    <ul className="small">
      {ids.map((id) => {
        const s = sources[id];
        const url = s ? safeUrl(s.url) : '';
        return (
          <li key={id}>
            {s ? (
              <>
                {s.publisher}: {url ? <a href={url} target="_blank" rel="noopener noreferrer">{s.title}</a> : s.title}
                {s.published ? ` (${s.published})` : ''}
              </>
            ) : (
              <span className="mono">{id}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Detail({
  sel, sources, lastMonth, close, go,
}: {
  sel: NonNullable<Sel>;
  sources: Record<string, SourceRow>;
  lastMonth: string;
  close: () => void;
  go: (from: string, to: string, programs: string[]) => void;
}) {
  if (sel.kind === 'event') {
    const e = sel.e;
    const per = periodForEvent(e.date, lastMonth);
    const programs = e.program ? [e.program] : [];
    return (
      <div className="callout" style={{ marginTop: 8 }}>
        <h3>{e.date}: {e.type.replace(/_/g, ' ')}</h3>
        <p>{e.label}</p>
        {e.date_precision !== 'day' && <p className="small">Dated to the {e.date_precision} only; the 1st is used for placement.</p>}
        <SourceLinks ids={e.source_ids} sources={sources} />
        <p>
          <button type="button" className="btn" onClick={() => go(per.from, per.to, programs)}>
            Open {per.from} to {per.to} in the crash explorer
          </button>{' '}
          <button type="button" className="link" onClick={close}>Close</button>
        </p>
      </div>
    );
  }
  const i = sel.i;
  const per = periodForInvestigation(i.opened, i.closed, lastMonth);
  const programs = COMPANY_PROGRAMS[i.company] ?? [];
  const url = safeUrl(i.url);
  return (
    <div className="callout" style={{ marginTop: 8 }}>
      <h3>{i.investigation_id}: {i.subject}</h3>
      <p className="small">
        NHTSA {i.type} for {i.company}, opened {i.opened}, {i.closed ? `closed ${i.closed}` : 'still open'}
        {i.vehicles_covered != null ? `; about ${i.vehicles_covered.toLocaleString('en-US')} vehicles covered` : ''}.
        {url && <> <a href={url} target="_blank" rel="noopener noreferrer">NHTSA document</a></>}
      </p>
      <SourceLinks ids={i.source_ids} sources={sources} />
      <p>
        <button type="button" className="btn" onClick={() => go(per.from, per.to, programs)}>
          Open {per.from} to {per.to} in the crash explorer
        </button>{' '}
        <button type="button" className="link" onClick={close}>Close</button>
      </p>
    </div>
  );
}
