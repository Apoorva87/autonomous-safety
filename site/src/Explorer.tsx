import { KindCaveat } from './components/KindCaveat';
import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Crash, Data } from './data';
import { fmt, humanize } from './data';
import { SourceNote } from './EChart';
import { LENSES, LENS_BY_ID } from './lib/lens';
import { setQuery, useQuery } from './state/scenario';
import { useInvestigations } from './data/rates';
import {
  PROGRAMS,
  PROGRAM_BY_KEY,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  TAG_LABEL,
  colorOf,
  hexToRgb,
  ui,
  type Mode,
} from './theme';

// ------------------------------------------------------------------ axes
type AxisDef = {
  key: string;
  label: string;
  kind: 'num' | 'cat';
  value: (c: Crash) => number | string | null;
  order?: string[]; // fixed category order
  catLabel?: (v: string) => string;
  jitter?: number; // numeric axes: jitter in domain units
};

const monthIndex = (m: string) => parseInt(m.slice(0, 4), 10) * 12 + parseInt(m.slice(5), 10) - 1;

const AXES: AxisDef[] = [
  { key: 'month', label: 'Incident month', kind: 'num', value: (c) => (c.month ? monthIndex(c.month) : null), jitter: 0.9 },
  { key: 'speed_mph', label: 'Subject speed before crash (mph)', kind: 'num', value: (c) => c.speed_mph, jitter: 0.9 },
  { key: 'model_year', label: 'Vehicle model year', kind: 'num', value: (c) => c.model_year, jitter: 0.9 },
  { key: 'severity', label: 'Injury severity', kind: 'cat', value: (c) => c.severity, order: ['unknown', 'none', 'minor', 'moderate', 'serious', 'fatal'], catLabel: (v) => SEVERITY_LABEL[v] ?? v },
  { key: 'program', label: 'Program', kind: 'cat', value: (c) => c.program, order: PROGRAMS.map((p) => p.key), catLabel: (v) => PROGRAM_BY_KEY[v]?.short ?? v },
  { key: 'crash_with', label: 'Crash with', kind: 'cat', value: (c) => c.crash_with },
  { key: 'roadway_type', label: 'Roadway type', kind: 'cat', value: (c) => c.roadway_type },
  { key: 'lighting', label: 'Lighting (to 2025-06)', kind: 'cat', value: (c) => c.lighting },
  { key: 'sv_movement', label: 'Subject vehicle movement', kind: 'cat', value: (c) => c.sv_movement },
  { key: 'cp_movement', label: 'Partner movement', kind: 'cat', value: (c) => c.cp_movement },
  { key: 'speed_band', label: 'Speed band (mph)', kind: 'cat', value: (c) => c.speed_band, order: ['unknown', '0', '1-5', '6-15', '16-30', '31-50', '51+'] },
  { key: 'within_odd', label: 'Within design domain', kind: 'cat', value: (c) => c.within_odd },
  { key: 'era', label: 'Reporting era', kind: 'cat', value: (c) => c.era, order: ['archive', 'current'], catLabel: (v) => (v === 'archive' ? 'Through 2025-06-15' : 'From 2025-06-16') },
];
const AXIS_BY_KEY = Object.fromEntries(AXES.map((a) => [a.key, a]));

type Tick = { at: number; label: string }; // at is 0..1 inside the plot
type Scale = { pos: (c: Crash, j: number) => number; ticks: Tick[]; jitterSpan: number };

function buildScale(axis: AxisDef, crashes: Crash[]): Scale {
  if (axis.kind === 'cat') {
    const counts = new Map<string, number>();
    let hasNull = false;
    for (const c of crashes) {
      const v = axis.value(c) as string | null;
      if (v == null) hasNull = true;
      else counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const cats = axis.order
      ? axis.order.filter((v) => counts.has(v))
      : [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).reverse();
    const NA = '\u0000na';
    const all = hasNull ? [NA, ...cats] : cats;
    const idx = new Map(all.map((v, i) => [v, i]));
    const n = all.length;
    const label = (v: string) => (v === NA ? 'Not reported' : axis.catLabel ? axis.catLabel(v) : humanize(v));
    return {
      pos: (c, j) => ((idx.get((axis.value(c) as string | null) ?? NA) ?? 0) + 0.5 + j * 0.8) / n,
      ticks: all.map((v, i) => ({ at: (i + 0.5) / n, label: label(v) })),
      jitterSpan: 1,
    };
  }
  let lo = Infinity;
  let hi = -Infinity;
  let hasNull = false;
  for (const c of crashes) {
    const v = axis.value(c) as number | null;
    if (v == null) hasNull = true;
    else {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const range = hi - lo || 1;
  const start = hasNull ? lo - range * 0.07 : lo;
  const norm = (v: number) => 0.02 + 0.96 * ((v - start) / (hi - start));
  const ticks: Tick[] = [];
  if (hasNull) ticks.push({ at: norm(start), label: 'n/a' });
  if (axis.key === 'month') {
    for (let y = Math.ceil(lo / 12); y * 12 <= hi; y++) ticks.push({ at: norm(y * 12), label: String(y) });
  } else {
    const step = range > 60 ? 10 : range > 25 ? 5 : 2;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push({ at: norm(v), label: String(v) });
  }
  return {
    pos: (c, j) => {
      const v = axis.value(c) as number | null;
      return v == null ? norm(start) : norm(v + j * (axis.jitter ?? 0.4));
    },
    ticks,
    jitterSpan: 1,
  };
}

// Deterministic jitter in [-0.5, 0.5], fixed per crash so points do not shuffle between axis changes.
function makeJitter(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s / 4294967296 - 0.5;
  }
  return out;
}

// ---------------------------------------------------------------- facets
type FacetDef = { key: string; label: string; get: (c: Crash) => string[]; text: (v: string) => string; order?: string[]; open?: boolean };
const NC = '(not reported)';
const FACETS: FacetDef[] = [
  { key: 'program', label: 'Program', get: (c) => [c.program], text: (v) => PROGRAM_BY_KEY[v]?.short ?? v, order: PROGRAMS.map((p) => p.key), open: true },
  { key: 'severity', label: 'Injury severity', get: (c) => [c.severity], text: (v) => SEVERITY_LABEL[v] ?? v, order: SEVERITY_ORDER, open: true },
  {
    key: 'tag',
    label: 'Failure-pattern tag',
    get: (c) => c.tags,
    text: (v) => {
      const [t, b] = v.split(':');
      return `${TAG_LABEL[t] ?? t} (${b === 'f' ? 'field' : 'narrative'})`;
    },
    open: true,
  },
  { key: 'roadway_type', label: 'Roadway type', get: (c) => [c.roadway_type ?? NC], text: (v) => (v === NC ? v : humanize(v)) },
  { key: 'lighting', label: 'Lighting (to 2025-06)', get: (c) => [c.lighting ?? NC], text: (v) => (v === NC ? v : humanize(v)) },
  { key: 'crash_with', label: 'Crash with', get: (c) => [c.crash_with ?? NC], text: (v) => (v === NC ? v : humanize(v)) },
];

type Filters = Record<string, Set<string>>;
const emptyFilters = (): Filters => Object.fromEntries(FACETS.map((f) => [f.key, new Set<string>()]));
const passes = (c: Crash, f: FacetDef, sel: Set<string>) => sel.size === 0 || f.get(c).some((v) => sel.has(v));

// ------------------------------------------------------------- component
type ColorBy = 'program' | 'severity';
type Pt = { i: number };

export function Explorer({ data, mode }: { data: Data; mode: Mode }) {
  const crashes = data.crashes;
  const t = ui(mode);
  const [xKey, setXKey] = useState('month');
  const [yKey, setYKey] = useState('severity');
  const [colorBy, setColorBy] = useState<ColorBy>('program');
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const params = useQuery();
  const lens = LENS_BY_ID[params.get('xl') ?? ''] ?? null;
  const periodFrom = params.get('xf') ?? '';
  const periodTo = params.get('xt') ?? '';
  const progParam = params.get('xp') ?? '';
  // Presets and the timeline set the program facet through the URL; apply it whenever those parameters change.
  useEffect(() => {
    const progs = lens ? lens.programs : progParam.split(',').filter((p) => PROGRAM_BY_KEY[p]);
    if (progs.length) setFilters((prev) => ({ ...prev, program: new Set(progs) }));
  }, [lens, progParam]);
  const basePass = (c: Crash) =>
    (!lens || lens.test(c)) && (!periodFrom || (c.month ?? '') >= periodFrom) && (!periodTo || (c.month ?? '9999') <= periodTo);
  const [hover, setHover] = useState<{ c: Crash; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<Crash | null>(null);

  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const narrow = size.w < 560;
  const m = { l: narrow ? 84 : 138, r: 14, t: 10, b: 44 };
  const pw = Math.max(50, size.w - m.l - m.r);
  const ph = Math.max(50, size.h - m.t - m.b);

  const jx = useMemo(() => makeJitter(crashes.length, 7), [crashes]);
  const jy = useMemo(() => makeJitter(crashes.length, 99991), [crashes]);
  const xScale = useMemo(() => buildScale(AXIS_BY_KEY[xKey], crashes), [xKey, crashes]);
  const yScale = useMemo(() => buildScale(AXIS_BY_KEY[yKey], crashes), [yKey, crashes]);

  const pos = useMemo(() => {
    const xs = new Float32Array(crashes.length);
    const ys = new Float32Array(crashes.length);
    crashes.forEach((c, i) => {
      xs[i] = m.l + xScale.pos(c, jx[i]) * pw;
      ys[i] = m.t + (1 - yScale.pos(c, jy[i])) * ph;
    });
    return { xs, ys };
  }, [crashes, xScale, yScale, jx, jy, m.l, m.t, pw, ph]);

  const visible = useMemo(() => {
    const v = new Uint8Array(crashes.length);
    crashes.forEach((c, i) => {
      v[i] = basePass(c) && FACETS.every((f) => passes(c, f, filters[f.key])) ? 1 : 0;
    });
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crashes, filters, lens, periodFrom, periodTo]);
  const shown = useMemo(() => visible.reduce((a, b) => a + b, 0), [visible]);
  const shownIncidents = useMemo(() => {
    const keys = new Set<string>();
    crashes.forEach((c, i) => {
      if (visible[i]) keys.add(c.incident_key);
    });
    return keys.size;
  }, [crashes, visible]);
  // The month axis carries the 2025-06-16 rule change as a dashed line (placed mid-June: halfway between the June and July positions).
  const breakAt = useMemo(() => {
    if (xKey !== 'month') return null;
    const at = (mo: string) => xScale.pos({ month: mo } as Crash, 0);
    const a = at('2025-06');
    const b = at('2025-07');
    return Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : null;
  }, [xKey, xScale]);

  // Facet value counts, with every other facet applied (standard cross-filter behavior).
  const facetCounts = useMemo(() => {
    const out: Record<string, Map<string, number>> = {};
    for (const f of FACETS) {
      const counts = new Map<string, number>();
      for (const c of crashes) {
        if (!basePass(c) || !FACETS.every((g) => g.key === f.key || passes(c, g, filters[g.key]))) continue;
        for (const v of f.get(c)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      out[f.key] = counts;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crashes, filters, lens, periodFrom, periodTo]);

  // Facet values present anywhere in the data, so a chip stays visible when its count drops to 0.
  const facetValues = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of FACETS) {
      const all = new Map<string, number>();
      for (const c of crashes) for (const v of f.get(c)) all.set(v, (all.get(v) ?? 0) + 1);
      out[f.key] = f.order
        ? f.order.filter((v) => all.has(v))
        : [...all.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    }
    return out;
  }, [crashes]);

  const colorFn = useMemo(() => {
    const table: Record<string, [number, number, number]> = {};
    if (colorBy === 'program') for (const p of PROGRAMS) table[p.key] = hexToRgb(colorOf(p.color, mode));
    else for (const s of SEVERITY_ORDER) table[s] = hexToRgb(colorOf(SEVERITY_COLOR[s], mode));
    return (c: Crash) => table[colorBy === 'program' ? c.program : c.severity] ?? [128, 128, 128];
  }, [colorBy, mode]);

  const layer = new ScatterplotLayer<Crash>({
    id: 'crashes',
    data: crashes,
    getPosition: (_d, { index }) => [pos.xs[index], pos.ys[index], 0],
    getRadius: (_d, { index }) => (visible[index] ? 3 : 0),
    getFillColor: (d) => [...colorFn(d), 190] as [number, number, number, number],
    radiusUnits: 'pixels',
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 255],
    transitions: { getPosition: 500 },
    updateTriggers: {
      getPosition: [pos],
      getRadius: [filters],
      getFillColor: [colorBy, mode],
    },
  });

  const toggle = (fk: string, v: string) =>
    setFilters((prev) => {
      const next = new Set(prev[fk]);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return { ...prev, [fk]: next };
    });
  const anyFilter = FACETS.some((f) => filters[f.key].size > 0) || !!lens || !!periodFrom || !!periodTo;
  const clearAll = () => {
    setFilters(emptyFilters());
    setQuery({ xl: null, xf: null, xt: null, xp: null });
  };
  const months = data.counts.months;
  const investigations = useInvestigations();
  const lensInv = lens ? investigations.find((i) => i.investigation_id === lens.investigationId) : undefined;
  const pickLens = (id: string | null) => {
    const l = id ? LENS_BY_ID[id] : null;
    setFilters(emptyFilters());
    setQuery({ xl: id, xp: null, xf: null, xt: null });
    if (l) setFilters({ ...emptyFilters(), program: new Set(l.programs) });
  };

  const legend =
    colorBy === 'program'
      ? PROGRAMS.map((p) => ({ k: p.key, label: p.short, color: colorOf(p.color, mode) }))
      : SEVERITY_ORDER.map((s) => ({ k: s, label: SEVERITY_LABEL[s], color: colorOf(SEVERITY_COLOR[s], mode) }));

  const axisSelect = (value: string, set: (v: string) => void, label: string) => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {AXES.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section>
      <h2>Crash explorer</h2>
      <KindCaveat extra="Dots of both kinds share the plot, so read stacks and clusters as where reports were filed, not as relative safety." />
      <p className="prose">
        Every dot is one crash filed by one program (a crash filed by two programs is two dots, one per program&rsquo;s own report). Choose what the two axes show, narrow the set with the filters, and hover or
        click a dot. Dots are nudged apart a little so stacks stay visible, so position within a category is not
        meaningful.
      </p>

      <div className="controls row">
        {axisSelect(xKey, setXKey, 'Horizontal')}
        {axisSelect(yKey, setYKey, 'Vertical')}
        <label className="field">
          <span>Color by</span>
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="program">Program</option>
            <option value="severity">Injury severity</option>
          </select>
        </label>
        <label className="field">
          <span>From month</span>
          <select value={periodFrom} onChange={(e) => setQuery({ xf: e.target.value || null })}>
            <option value="">Start</option>
            {months.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
          </select>
        </label>
        <label className="field">
          <span>To month</span>
          <select value={periodTo} onChange={(e) => setQuery({ xt: e.target.value || null })}>
            <option value="">Latest</option>
            {months.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
          </select>
        </label>
        <p className="count" aria-live="polite" data-testid="shown-count">
          <b>{fmt(shown)}</b> of {fmt(crashes.length)} crashes shown (program-level; {fmt(shownIncidents)} unique incidents)
          {anyFilter && (
            <button className="link" onClick={clearAll}>
              Clear filters
            </button>
          )}
        </p>
      </div>

      <div className="lens" role="group" aria-label="Investigation lens presets">
        <span className="lens-label">Investigation lens</span>
        {LENSES.map((l) => (
          <button
            key={l.id} type="button" className={lens?.id === l.id ? 'fchip on' : 'fchip'} aria-pressed={lens?.id === l.id}
            onClick={() => pickLens(lens?.id === l.id ? null : l.id)}
          >
            {l.investigationId}: {l.title}
          </button>
        ))}
      </div>
      {lens && (
        <div className="callout lens-note" role="note">
          <p className="small">
            <b>Approximation.</b> This is <em>not</em> the case list of NHTSA investigation {lens.investigationId}; it is the nearest set of crashes the SGO's structured fields
            can describe. {lens.rule}
          </p>
          {lensInv ? (
            <p className="small">
              {lensInv.investigation_id} ({lensInv.type}, {lensInv.company}): {lensInv.subject}. Opened {lensInv.opened}, {lensInv.closed ? `closed ${lensInv.closed}` : 'still open'}
              {lensInv.vehicles_covered != null ? `; about ${fmt(lensInv.vehicles_covered)} vehicles covered` : ''}.{' '}
              {/^https?:\/\//i.test(lensInv.url) && <a href={lensInv.url} target="_blank" rel="noopener noreferrer">NHTSA document</a>}{' '}
              <a href="#timeline">See it on the timeline</a>
            </p>
          ) : (
            <p className="small">Looking up {lens.investigationId} in investigations.json…</p>
          )}
        </div>
      )}
      {(periodFrom || periodTo) && (
        <p className="small" role="note">
          Period filter: {periodFrom || 'start'} to {periodTo || 'latest'}. Months are the incident month; reports for the latest months are still arriving.
        </p>
      )}

      <div className="explorer">
        <aside className="facets" aria-label="Filters">
          {FACETS.map((f) => (
            <details key={f.key} open={f.open}>
              <summary>
                {f.label}
                {filters[f.key].size > 0 && <span className="badge">{filters[f.key].size}</span>}
              </summary>
              <div className="chips">
                {facetValues[f.key].map((v) => {
                  const n = facetCounts[f.key].get(v) ?? 0;
                  const on = filters[f.key].has(v);
                  return (
                    <button
                      key={v}
                      className={on ? 'chip on' : 'chip'}
                      aria-pressed={on}
                      onClick={() => toggle(f.key, v)}
                      disabled={!on && n === 0}
                    >
                      <span>{f.text(v)}</span>
                      <em>{fmt(n)}</em>
                    </button>
                  );
                })}
              </div>
            </details>
          ))}
        </aside>

        <div className="stage">
          <div className="plot" ref={wrap} data-points={crashes.length} data-visible={shown}>
            <svg className="axes" width={size.w} height={size.h} aria-hidden="true">
              {xScale.ticks.map((tk, i) => (
                <g key={'x' + i}>
                  <line x1={m.l + tk.at * pw} x2={m.l + tk.at * pw} y1={m.t} y2={m.t + ph} stroke={t.grid} />
                  <text x={m.l + tk.at * pw} y={m.t + ph + 15} textAnchor="middle" fontSize="10.5" fill={t.muted}>
                    {tk.label.length > 14 && AXIS_BY_KEY[xKey].kind === 'cat' ? tk.label.slice(0, 13) + '…' : tk.label}
                  </text>
                </g>
              ))}
              {breakAt != null && breakAt >= 0 && breakAt <= 1 && (
                <g>
                  <line x1={m.l + breakAt * pw} x2={m.l + breakAt * pw} y1={m.t} y2={m.t + ph} stroke="#b3361a" strokeWidth={1.5} strokeDasharray="5 4" />
                  <text x={m.l + breakAt * pw - 4} y={m.t + 10} textAnchor="end" fontSize="10.5" fill={t.muted}>2025-06-16 rule change</text>
                </g>
              )}
              {yScale.ticks.map((tk, i) => (
                <g key={'y' + i}>
                  <line x1={m.l} x2={m.l + pw} y1={m.t + (1 - tk.at) * ph} y2={m.t + (1 - tk.at) * ph} stroke={t.grid} />
                  <text x={m.l - 8} y={m.t + (1 - tk.at) * ph + 3.5} textAnchor="end" fontSize="10.5" fill={t.muted}>
                    {tk.label.length > (narrow ? 12 : 20) ? tk.label.slice(0, narrow ? 11 : 19) + '…' : tk.label}
                  </text>
                </g>
              ))}
              <text x={m.l + pw / 2} y={size.h - 6} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={t.ink}>
                {AXIS_BY_KEY[xKey].label}
              </text>
              <text transform={`translate(12 ${m.t + ph / 2}) rotate(-90)`} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={t.ink}>
                {narrow ? '' : AXIS_BY_KEY[yKey].label}
              </text>
            </svg>
            <DeckGL
              views={new OrthographicView({ flipY: true })}
              viewState={{ target: [size.w / 2, size.h / 2, 0], zoom: 0 }}
              controller={false}
              layers={[layer]}
              style={{ position: 'absolute', inset: '0' }}
              onHover={(info) => {
                if (info.index >= 0 && info.object) setHover({ c: info.object as Crash, x: info.x, y: info.y });
                else setHover(null);
              }}
              onClick={(info) => {
                if (info.index >= 0 && info.object) setPicked(info.object as Crash);
              }}
              getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'default')}
            />
            {hover && (
              <div
                className="tip"
                style={{ left: Math.min(hover.x + 12, size.w - 190), top: Math.max(4, hover.y - 8) }}
                role="status"
              >
                <b>{PROGRAM_BY_KEY[hover.c.program]?.short}</b>
                <span>
                  {hover.c.month ?? 'no date'} · {SEVERITY_LABEL[hover.c.severity]}
                </span>
                <span>
                  {humanize(hover.c.crash_with)}
                  {hover.c.speed_mph != null ? `, ${hover.c.speed_mph} mph` : ''}
                </span>
              </div>
            )}
          </div>
          <ul className="legend" aria-label="Color key">
            {legend.map((l) => (
              <li key={l.k}>
                <i className="swatch" style={{ background: l.color }} /> {l.label}
              </li>
            ))}
          </ul>
          <SourceNote date={data.meta.fetched_date} extra="One dot per program-level crash record (the program's own report of the incident; the header counts the unique incidents). Rendered with WebGL." />
        </div>

        {picked && <Drawer c={picked} onClose={() => setPicked(null)} />}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- drawer
function yesNo(v: boolean | null) {
  return v == null ? 'Unknown' : v ? 'Yes' : 'No';
}

function Drawer({ c, onClose }: { c: Crash; onClose: () => void }) {
  const rows: [string, string][] = [
    ['NHTSA Report ID', c.id],
    ['Incident ID', c.incident_key.startsWith('solo:') ? 'None (single report)' : c.incident_key],
    ['Reports by this program for this crash', String(c.n_reports)],
    ['Programs that filed this incident', String(c.n_programs_in_incident)],
    ['Reporting entity', c.entity],
    ['Program', PROGRAM_BY_KEY[c.program]?.label ?? c.program],
    ['Incident month', c.month ?? 'Not reported'],
    ['Reporting lag (months, approx.)', c.lag_days == null ? 'Not available' : String(Math.round(c.lag_days / 30))],
    ['Vehicle', [c.make, c.model, c.model_year].filter((x) => x != null).join(' ') || 'Not reported'],
    ['Location', [c.city, c.state].filter(Boolean).join(', ') || 'Not reported'],
    ['Injury severity', SEVERITY_LABEL[c.severity] ?? c.severity],
    ['Hospitalized', yesNo(c.hospitalized)],
    ['Crash with', humanize(c.crash_with)],
    ['Subject movement', humanize(c.sv_movement)],
    ['Partner movement', humanize(c.cp_movement)],
    ['Subject speed (mph)', c.speed_mph == null ? 'Not reported' : String(c.speed_mph)],
    ['Posted speed limit (mph)', c.speed_limit == null ? 'Not collected after 2025-06' : String(c.speed_limit)],
    ['Roadway type', humanize(c.roadway_type)],
    ['Road surface', c.surface ? humanize(c.surface) : 'Not collected after 2025-06'],
    ['Lighting', c.lighting ? humanize(c.lighting) : 'Not collected after 2025-06'],
    ['Weather', c.weather.length ? c.weather.map(humanize).join(', ') : 'Not reported'],
    ['Airbag deployed', yesNo(c.airbag)],
    ['Towed', yesNo(c.towed)],
    ['Within design domain', c.within_odd ? humanize(c.within_odd) : 'Not reported'],
    ['Narrative redacted by filer', c.narrative_redacted ? 'Yes (or blank)' : 'No'],
    ['Software version redacted', c.version_redacted ? 'Yes' : 'No'],
    ['Tags', c.tags.length ? c.tags.map((x) => { const [tg, b] = x.split(':'); return `${TAG_LABEL[tg] ?? tg} (${b === 'f' ? 'field' : 'narrative'})`; }).join('; ') : 'None'],
  ];
  return (
    <aside className="drawer" aria-label="Crash details">
      <div className="drawer-head">
        <h3>Crash details</h3>
        <button onClick={onClose} aria-label="Close details">
          Close
        </button>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="small">Narratives are not loaded in this view (open a report on the Responsibility tab to read one). The record shown is this program&rsquo;s own report of the crash (the one with the highest injury level if it filed several).</p>
    </aside>
  );
}
