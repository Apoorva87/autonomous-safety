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
const Learning = lazy(() => import('./Learning').then((m) => ({ default: m.Learning })));
const Claims = lazy(() => import('./Claims').then((m) => ({ default: m.Claims })));
const Responsibility = lazy(() => import('./Responsibility').then((m) => ({ default: m.Responsibility })));

// Tab order: overview and rates first, the compound views next, the raw explorer and reference tabs last.
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rates', label: 'Rates' },
  { id: 'impact', label: 'Impact map' },
  { id: 'cities', label: 'Cities' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'learning', label: 'Learning' },
  { id: 'claims', label: 'Claims vs filings' },
  { id: 'responsibility', label: 'Responsibility' },
  { id: 'explorer', label: 'Crash explorer' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'transparency', label: 'Transparency' },
  { id: 'sources', label: 'Data & sources' },
] as const;
type TabId = (typeof TABS)[number]['id'];

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
              {fmt(data.meta.total_incidents)} unique crashes from {fmt(data.meta.total_reports)} reports; NHTSA
              files last updated {data.meta.nhtsa_last_modified}.
            </>
          )}
        </p>
      </header>

      <div className="banner" role="note">
        <strong>Preview.</strong> Counts are as filed with NHTSA. Rates (Rates tab) are drawn only where a sourced denominator exists, always with a 95% interval; many denominators are estimates.
      </div>

      <div className={`tabs-wrap${edges.left ? ' fade-left' : ''}${edges.right ? ' fade-right' : ''}`}>
        <nav className="tabs" aria-label="Sections" ref={nav}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'tab active' : 'tab'}
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <main>
        {error && <p className="error">Could not load the data files ({error}).</p>}
        {!data && !error && <p className="loading">Loading about 8,700 crash records…</p>}
        {data && tab === 'overview' && <Overview data={data} mode={mode} />}
        {data && tab === 'rates' && <Rates data={data} mode={mode} />}
        <Suspense fallback={<p className="loading">Loading view…</p>}>
          {data && tab === 'impact' && <Impact data={data} mode={mode} />}
          {data && tab === 'cities' && <Cities data={data} mode={mode} />}
          {data && tab === 'timeline' && <Timeline data={data} mode={mode} />}
          {data && tab === 'learning' && <Learning data={data} mode={mode} />}
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
