/** Flag icon with a tooltip: marks an exposure month whose monthly split the pipeline flags as unreliable (>3x adjacent segments). */
export function FlagNote({ note, period }: { note: string; period?: string }) {
  const text = `${period ? period + ': ' : ''}${note}`;
  return (
    <span className="flag-note flag-icon" role="img" tabIndex={0} aria-label={`Unreliable monthly exposure. ${text}`} title={text}>
      <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true" focusable="false">
        <path d="M1 0.5h1.4v12H1z M2.4 1h8L8 4l2.4 3h-8z" fill="currentColor" />
      </svg>
    </span>
  );
}

export const FLAG_PATH = 'path://M0,0L1.6,0L1.6,13L0,13Z M1.6,0.6L11,0.6L8.6,3.8L11,7L1.6,7Z';

/** Marks a number that includes months whose reports are still arriving (lag.json: under 90% of reports usually filed). */
export function IncompleteMark({ months }: { months: string[] }) {
  const text = `Recent months are incomplete (late reports expected): ${months.join(', ')}. The count is probably too low.`;
  return (
    <span className="incomplete-mark" role="img" tabIndex={0} aria-label={text} title={text}>
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2" />
        <path d="M6 3v3.2l2 1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      late reports
    </span>
  );
}
