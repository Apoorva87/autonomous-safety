import { useMemo } from 'react';
import type { Data } from './data';
import { fmt, humanize } from './data';
import { SourceNote } from './EChart';
import { PROGRAMS, PROGRAM_BY_KEY, SEVERITY_LABEL, SEVERITY_ORDER, TAG_LABEL, TAG_ORDER, colorOf, ui, type Mode } from './theme';
import { CarOutline } from './components/CarOutline';
import { ChipGroup } from './components/ChipGroup';
import {
  ZONES, ZONE_LABEL, hasSide, inZone, passesImpact, zoneStats, zonesOf, type ImpactFilters, type Side, type WithContact, type Zone,
} from './lib/impact';
import { SEQ_BLUE, rampColor } from './lib/ramp';
import { setQuery, useQuery } from './state/scenario';
import { getList, setList, toggleIn } from './state/viewstate';

const SPEED_BANDS = ['0', '1-5', '6-15', '16-30', '31-50', '51+', 'unknown'];
const MAX_LIST = 60;

const parseZone = (s: string | null): { side: Side; zone: Zone } | null => {
  const [side, zone] = (s ?? '').split(':');
  return (side === 'sv' || side === 'cp') && (ZONES as readonly string[]).includes(zone) ? { side, zone: zone as Zone } : null;
};

export function Impact({ data, mode }: { data: Data; mode: Mode }) {
  const params = useQuery();
  const t = ui(mode);
  const crashes = data.crashes as WithContact[];
  const hasSv = hasSide(crashes, 'sv');
  const hasCp = hasSide(crashes, 'cp');

  const f: ImpactFilters = {
    programs: getList(params, 'ip'),
    severities: getList(params, 'isv'),
    speedBands: getList(params, 'isp'),
    crashWith: getList(params, 'icw'),
    tags: getList(params, 'itg'),
  };
  const picked = parseZone(params.get('iz'));

  const crashWithOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of crashes) if (c.crash_with) m.set(c.crash_with, (m.get(c.crash_with) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [crashes]);

  const filtered = useMemo(
    () => crashes.filter((c) => passesImpact(c, f)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [crashes, params.get('ip'), params.get('isv'), params.get('isp'), params.get('icw'), params.get('itg')],
  );
  const sv = useMemo(() => zoneStats(filtered, 'sv'), [filtered]);
  const cp = useMemo(() => zoneStats(filtered, 'cp'), [filtered]);
  // One colour scale per outline pair so the two cars are comparable.
  const maxShare = useMemo(() => {
    let m = 0;
    for (const [s, ok] of [[sv, hasSv], [cp, hasCp]] as const) {
      if (!ok || s.known === 0) continue;
      for (const z of ZONES) m = Math.max(m, s.counts[z] / s.known);
    }
    return m;
  }, [sv, cp, hasSv, hasCp]);

  const listed = useMemo(() => (picked ? inZone(filtered, picked.side, picked.zone) : []), [filtered, picked]);
  const anyFilter = [f.programs, f.severities, f.speedBands, f.crashWith, f.tags].some((l) => l.length > 0);
  const clearAll = () => setQuery({ ip: null, isv: null, isp: null, icw: null, itg: null, iz: null });

  const setF = (key: string, list: string[]) => {
    setList(key, list);
    setQuery({ iz: null });
  };

  return (
    <section className="impact">
      <h2>Impact map: where on the car crashes land</h2>
      <p className="prose">
        Each outline shades the ten contact zones by the share of crashes that touched them. <b>Contact area is where the vehicle was hit</b>, as
        the reporter filed it: the left outline is the subject vehicle (the automated or driver-assist car), the right one is the other party when it
        is a vehicle. A crash can touch several zones, so shares can add to more than 100%. Zones with fewer than 10 crashes are hatched: read them as rough.
      </p>

      <div className="rates-controls impact-controls">
        <ChipGroup
          legend="Program"
          options={PROGRAMS.map((p) => ({ value: p.key, label: p.short, color: colorOf(p.color, mode) }))}
          selected={f.programs}
          onToggle={(v) => setF('ip', toggleIn(f.programs, v))}
          onClear={() => setF('ip', [])}
        />
        <ChipGroup
          legend="Injury severity"
          options={SEVERITY_ORDER.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))}
          selected={f.severities}
          onToggle={(v) => setF('isv', toggleIn(f.severities, v))}
          onClear={() => setF('isv', [])}
        />
        <ChipGroup
          legend="Subject speed (mph)"
          options={SPEED_BANDS.map((s) => ({ value: s, label: s === 'unknown' ? 'Unknown' : s }))}
          selected={f.speedBands}
          onToggle={(v) => setF('isp', toggleIn(f.speedBands, v))}
          onClear={() => setF('isp', [])}
        />
        <ChipGroup
          legend="Crash with"
          options={crashWithOptions.map((v) => ({ value: v, label: humanize(v) }))}
          selected={f.crashWith}
          onToggle={(v) => setF('icw', toggleIn(f.crashWith, v))}
          onClear={() => setF('icw', [])}
        />
        <ChipGroup
          legend="Inferred pattern tags (field or narrative)"
          options={TAG_ORDER.map((v) => ({ value: v, label: TAG_LABEL[v] }))}
          selected={f.tags}
          onToggle={(v) => setF('itg', toggleIn(f.tags, v))}
          onClear={() => setF('itg', [])}
        />
      </div>
      <p className="count" aria-live="polite" data-testid="impact-count">
        <b>{fmt(filtered.length)}</b> of {fmt(crashes.length)} unique crashes match
        {anyFilter && (
          <button type="button" className="link" onClick={clearAll}>
            Clear filters
          </button>
        )}
      </p>

      {!hasSv && !hasCp ? (
        <NoContact filtered={filtered} t={t} mode={mode} />
      ) : (
        <>
          <div className="car-pair">
            {hasSv && (
              <CarOutline
                title="Subject vehicle: where it was hit"
                stats={sv}
                mode={mode}
                maxShare={maxShare}
                selected={picked?.side === 'sv' ? picked.zone : null}
                onSelect={(z) => setQuery({ iz: z ? `sv:${z}` : null })}
              />
            )}
            {hasCp && (
              <CarOutline
                title="Other party: where it was hit"
                stats={cp}
                mode={mode}
                maxShare={maxShare}
                selected={picked?.side === 'cp' ? picked.zone : null}
                onSelect={(z) => setQuery({ iz: z ? `cp:${z}` : null })}
              />
            )}
          </div>
          <div className="ramp-legend" aria-label="Colour scale">
            <span className="small">0%</span>
            <i style={{ background: `linear-gradient(90deg, ${SEQ_BLUE[mode].join(',')})` }} />
            <span className="small">{(maxShare * 100).toFixed(0)}% of crashes with a known area</span>
            <span className="small">
              <i className="mk-hatch" /> fewer than 10 crashes
            </span>
          </div>
          {!hasCp && <p className="small">The other party's contact areas are not in the published data, so only the subject vehicle is drawn.</p>}
          <p className="small">
            Not drawn: crashes with no usable area (no vehicle partner, "unknown" or not reported). The count is shown above each outline; shares divide by crashes that do have one.
          </p>

          <details className="table-view">
            <summary>Show the numbers as a table</summary>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Crashes by contact zone</caption>
                <thead>
                  <tr>
                    <th scope="col">Zone</th>
                    {hasSv && <th scope="col" className="num">Subject: crashes</th>}
                    {hasSv && <th scope="col" className="num">share</th>}
                    {hasCp && <th scope="col" className="num">Other party: crashes</th>}
                    {hasCp && <th scope="col" className="num">share</th>}
                  </tr>
                </thead>
                <tbody>
                  {ZONES.map((z) => (
                    <tr key={z}>
                      <th scope="row">{ZONE_LABEL[z]}</th>
                      {hasSv && <td className="num">{fmt(sv.counts[z])}</td>}
                      {hasSv && <td className="num">{sv.known ? ((sv.counts[z] / sv.known) * 100).toFixed(1) + '%' : 'no data'}</td>}
                      {hasCp && <td className="num">{fmt(cp.counts[z])}</td>}
                      {hasCp && <td className="num">{cp.known ? ((cp.counts[z] / cp.known) * 100).toFixed(1) + '%' : 'no data'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <h3>{picked ? `Crashes where the ${picked.side === 'sv' ? 'subject vehicle' : 'other party'} was hit at: ${ZONE_LABEL[picked.zone]}` : 'Click a zone to list its crashes'}</h3>
          {picked && (
            <>
              <p className="small">
                {fmt(listed.length)} crashes match the filters above and this zone
                <button type="button" className="link" onClick={() => setQuery({ iz: null })}>
                  Clear zone
                </button>
                {listed.length > MAX_LIST && ` (showing the latest ${MAX_LIST})`}
              </p>
              <div className="table-wrap">
                <table className="rates-table">
                  <caption className="sr-only">Matching crashes</caption>
                  <thead>
                    <tr>
                      <th scope="col">NHTSA report</th>
                      <th scope="col">Program</th>
                      <th scope="col">Month</th>
                      <th scope="col">Severity</th>
                      <th scope="col">Crash with</th>
                      <th scope="col" className="num">Speed</th>
                      <th scope="col">Place</th>
                      <th scope="col">Subject hit</th>
                      <th scope="col">Other hit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...listed]
                      .sort((a, b) => (b.month ?? '').localeCompare(a.month ?? ''))
                      .slice(0, MAX_LIST)
                      .map((c) => (
                        <tr key={c.id}>
                          <td className="mono">{c.id}</td>
                          <td>{PROGRAM_BY_KEY[c.program]?.short ?? c.program}</td>
                          <td>{c.month ?? 'n/a'}</td>
                          <td>{SEVERITY_LABEL[c.severity] ?? c.severity}</td>
                          <td>{humanize(c.crash_with)}</td>
                          <td className="num">{c.speed_mph == null ? 'n/a' : `${c.speed_mph} mph`}</td>
                          <td>{[c.city, c.state].filter(Boolean).join(', ') || 'n/a'}</td>
                          <td>{zonesOf(c, 'sv').map((z) => ZONE_LABEL[z]).join(', ') || 'n/a'}</td>
                          <td>{zonesOf(c, 'cp').map((z) => ZONE_LABEL[z]).join(', ') || 'n/a'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      <SourceNote
        date={data.meta.fetched_date}
        extra="Unique crashes (one report per incident, the one with the highest injury level). Contact areas are as filed and can be unknown. Narratives are not used."
      />
    </section>
  );
}

/** Shown when records.json has no contact-area columns: say so, and show the closest structured fields. */
function NoContact({ filtered, t, mode }: { filtered: WithContact[]; t: ReturnType<typeof ui>; mode: Mode }) {
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of filtered) m.set(c.crash_with ?? 'not reported', (m.get(c.crash_with ?? 'not reported') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [filtered]);
  const max = rows[0]?.[1] ?? 1;
  return (
    <div className="callout why-no-data" role="status">
      <h3>Contact areas are not in the published data yet</h3>
      <p className="small">
        The pipeline keeps each report's contact areas (<span className="mono">sv_contact_areas</span>, <span className="mono">cp_contact_areas</span>) but
        does not export them to <span className="mono">records.json</span>, so the car outlines cannot be drawn. Once those two columns are exported
        (lists of zone names such as <span className="mono">rear_left</span>), this tab fills in with no further change. In the meantime this is what the
        filtered crashes hit, from the fields that do exist:
      </p>
      <ul className="bars" aria-label="Crash with, filtered crashes">
        {rows.map(([k, n]) => (
          <li key={k}>
            <span className="bar-label">{humanize(k)}</span>
            <span className="bar-track">
              <i style={{ width: `${(n / max) * 100}%`, background: rampColor(SEQ_BLUE[mode], 0.6) }} />
            </span>
            <span className="num">{fmt(n)}</span>
          </li>
        ))}
      </ul>
      <p className="small" style={{ color: t.muted }}>Counts of unique crashes by what the subject vehicle struck or was struck by (SGO "crash with").</p>
    </div>
  );
}
