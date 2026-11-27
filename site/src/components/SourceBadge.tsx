import { createContext, useContext, useEffect, useId, useState } from 'react';
import type { SourceRow } from '../data/rates';

export const SourcesCtx = createContext<Record<string, SourceRow>>({});

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

/** An (i) button that opens a dialog listing each source (publisher, URL, dates, methodology, caveats) and the exposure method. */
export function SourceBadge({
  sourceIds,
  kind,
  method,
  label = 'Sources',
}: {
  sourceIds: string[];
  kind?: string | null;
  method?: string;
  label?: string;
}) {
  const sources = useContext(SourcesCtx);
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [open]);

  const ids = [...new Set(sourceIds)];
  const none = ids.length === 0 && !method;
  return (
    <>
      <button
        type="button"
        className="src-badge"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${ids.length} source${ids.length === 1 ? '' : 's'}`}
        title={none ? 'No source: no exposure disclosed' : `${label} (${ids.length})`}
        disabled={none}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">i</span>
        {kind && <span className={`kind kind-${kind}`}>{kind}</span>}
      </button>
      {open && (
        <div className="popover-backdrop" onClick={() => setOpen(false)}>
          <div id={id} role="dialog" aria-modal="true" aria-label="Sources and method" className="popover" onClick={(e) => e.stopPropagation()}>
            <div className="popover-head">
              <h3>{label}</h3>
              <button type="button" onClick={() => setOpen(false)} autoFocus>
                Close
              </button>
            </div>
            {kind && (
              <p className="small">
                Exposure kind: <b>{kind}</b>
                {kind === 'estimate' && ' (an estimate, never shown as a reported number)'}
                {kind === 'derived' && ' (derived from reported figures by a stated calculation)'}
              </p>
            )}
            {method && (
              <p className="small">
                <b>Method.</b> {method}
              </p>
            )}
            {ids.map((sid) => {
              const s = sources[sid];
              if (!s) return <p key={sid} className="small">{sid}: not found in sources.json.</p>;
              const url = safeUrl(s.url);
              return (
                <div key={sid} className="src-item">
                  <b>{s.publisher}</b>: {s.title}
                  <dl>
                    <div><dt>Source id</dt><dd className="mono">{s.source_id}</dd></div>
                    {url && <div><dt>URL</dt><dd><a href={url} target="_blank" rel="noopener noreferrer">{s.url}</a></dd></div>}
                    <div><dt>Published</dt><dd>{s.published || 'n/a'}</dd></div>
                    <div><dt>Date range</dt><dd>{s.date_range || 'n/a'}</dd></div>
                    <div><dt>Methodology</dt><dd>{s.methodology || 'n/a'}</dd></div>
                    <div><dt>Caveats</dt><dd>{s.caveats || 'none recorded'}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export function ScenarioBadge({
  title = 'This number depends on an assumption you can change in the scenario panel',
  label = 'scenario',
}: { title?: string; label?: string }) {
  return (
    <span className="scenario-badge" title={title}>
      {label}
    </span>
  );
}

export function LowSampleMark({ reason }: { reason?: string }) {
  return (
    <span className="lowsample-mark" title={reason ?? 'Low sample (fewer than 10 expected crashes) or exposure is an estimate'}>
      low sample / estimate
    </span>
  );
}
