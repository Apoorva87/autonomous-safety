import { useEffect, useState } from 'react';
import { useData, fmt } from './data';
import { useMode } from './theme';
import { Overview } from './Overview';
import { Rates } from './Rates';
import { Explorer } from './Explorer';
import { Patterns } from './Patterns';
import { TransparencyTab } from './TransparencyTab';
import { Sources } from './Sources';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rates', label: 'Rates' },
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

  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
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

      <nav className="tabs" aria-label="Sections">
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

      <main>
        {error && <p className="error">Could not load the data files ({error}).</p>}
        {!data && !error && <p className="loading">Loading about 8,700 crash records…</p>}
        {data && tab === 'overview' && <Overview data={data} mode={mode} />}
        {data && tab === 'rates' && <Rates data={data} mode={mode} />}
        {data && tab === 'explorer' && <Explorer data={data} mode={mode} />}
        {data && tab === 'patterns' && <Patterns data={data} mode={mode} />}
        {data && tab === 'transparency' && <TransparencyTab data={data} mode={mode} />}
        {data && tab === 'sources' && <Sources data={data} />}
      </main>
    </div>
  );
}
