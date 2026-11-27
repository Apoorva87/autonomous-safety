import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useData, fmt } from './data';
import { useMode } from './theme';
import { Overview } from './Overview';
import { Rates } from './Rates';
import { Explorer } from './Explorer';
import { Patterns } from './Patterns';
import { TransparencyTab } from './TransparencyTab';
import { Sources } from './Sources';

// The compound views are loaded on demand so the first paint does not wait for them.
const Impact = lazy(() => import('./Impact').then((m) => ({ default: m.Impact })));
const Cities = lazy(() => import('./Cities').then((m) => ({ default: m.Cities })));
const Timeline = lazy(() => import('./Timeline').then((m) => ({ default: m.Timeline })));
const Claims = lazy(() => import('./Claims').then((m) => ({ default: m.Claims })));
const Responsibility = lazy(() => import('./Responsibility').then((m) => ({ default: m.Responsibility })));
const Improvement = lazy(() => import('./Improvement').then((m) => ({ default: m.Improvement })));

// Five groups keep the top bar short; each group's views sit in a second row. View ids are the URL hash, unchanged from
// the flat tab bar, so old links still open the same view.
type View = { id: string; label: string };
const GROUPS: { id: string; label: string; views: View[] }[] = [
  { id: 'overview', label: 'Overview', views: [{ id: 'overview', label: 'Overview' }] },
  {
    id: 'rates', label: 'Rates', views: [
      { id: 'rates', label: 'Rate explorer' },
      { id: 'improving', label: 'Before / after 2025-06' },
      { id: 'cities', label: 'By city' },
      { id: 'timeline', label: 'Timeline and events' },
      { id: 'claims', label: 'Claims vs filings' },
    ],
  },
  {
    id: 'crashes', label: 'Crashes', views: [
      { id: 'explorer', label: 'Crash explorer' },
      { id: 'patterns', label: 'Patterns' },
      { id: 'impact', label: 'Impact map' },
    ],
  },
  { id: 'responsibility', label: 'Responsibility', views: [{ id: 'responsibility', label: 'Responsibility' }] },
  {
    id: 'data', label: 'Data', views: [
      { id: 'sources', label: 'Data & sources' },
      { id: 'transparency', label: 'Transparency' },
    ],
  },
];
const TABS = GROUPS.flatMap((g) => g.views);
type TabId = string;
const groupOf = (id: TabId) => GROUPS.find((g) => g.views.some((v) => v.id === id))!;

function tabFromHash(): TabId {
  const h = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === h)?.id ?? 'overview') as TabId;
}

export function App() {
  const { data, error } = useData();
  const mode = useMode();
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const nav = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: true });

  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Keep the active tab visible in the scrolling tab bar and show a fade where more tabs are hidden.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [tab]);
  useEffect(() => {
    const el = nav.current;
    if (!el) return;
    const update = () => setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const select = (id: TabId) => {
    window.location.hash = id;
    setTab(id);
  };

  return (
    <div className="shell">
      <header className="masthead">
        <h1>Autonomous Safety</h1>
        <p className="lede">
          Crash reports from autonomous-driving and driver-assist programs, as filed with NHTSA and
          shown without editing.
          {data && (
            <>
              {' '}
              {fmt(data.meta.total_incidents)} unique incidents ({fmt(data.crashes.length)} program-level crashes) from {fmt(data.meta.total_reports)} reports; NHTSA
              files last updated {data.meta.nhtsa_last_modified}.
            </>
          )}
        </p>
      </header>

      <div className="banner" role="note">
        <strong>NHTSA reporting rules changed on 2025-06-16.</strong> Minor crashes stopped being reportable, so counts of all reported crashes drop at that date
        whatever happened on the road. Time charts therefore count <b>threshold-robust crashes</b> by default (reportable under both rules); see <a href="#improving">Rates → Before / after</a>.
      </div>

      <div className={`tabs-wrap${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}>
        <nav className="tabs" aria-label="Sections" ref={nav}>
          {GROUPS.map((g) => {
            const on = groupOf(tab).id === g.id;
            return (
              <button key={g.id} className={on ? 'tab active' : 'tab'} aria-current={on ? 'page' : undefined} onClick={() => select(g.views[0].id)}>
                {g.label}
              </button>
            );
          })}
        </nav>
      </div>
      {groupOf(tab).views.length > 1 && (
        <nav className="subtabs" aria-label={`${groupOf(tab).label} views`}>
          {groupOf(tab).views.map((v) => (
            <button key={v.id} type="button" className={v.id === tab ? 'subtab on' : 'subtab'} aria-current={v.id === tab ? 'page' : undefined} onClick={() => select(v.id)}>
              {v.label}
            </button>
          ))}
        </nav>
      )}

      <main>
        {error && <p className="error">Could not load the data files ({error}).</p>}
        {!data && !error && <p className="loading">Loading about 8,700 crash records…</p>}
        {data && tab === 'overview' && <Overview data={data} mode={mode} />}
        {data && tab === 'rates' && <Rates data={data} mode={mode} />}
        <Suspense fallback={<p className="loading">Loading view…</p>}>
          {data && tab === 'improving' && <Improvement data={data} mode={mode} />}
          {data && tab === 'impact' && <Impact data={data} mode={mode} />}
          {data && tab === 'cities' && <Cities data={data} mode={mode} />}
          {data && tab === 'timeline' && <Timeline data={data} mode={mode} />}
          {data && tab === 'claims' && <Claims data={data} mode={mode} />}
          {data && tab === 'responsibility' && <Responsibility data={data} mode={mode} />}
        </Suspense>
        {data && tab === 'explorer' && <Explorer data={data} mode={mode} />}
        {data && tab === 'patterns' && <Patterns data={data} mode={mode} />}
        {data && tab === 'transparency' && <TransparencyTab data={data} mode={mode} />}
        {data && tab === 'sources' && <Sources data={data} />}
      </main>
    </div>
  );
}
