export type ChipOption = { value: string; label: string; color?: string; count?: number };

/** A labelled group of toggle buttons (multi-select). Empty selection means "all". */
export function ChipGroup({
  legend,
  options,
  selected,
  onToggle,
  onClear,
}: {
  legend: string;
  options: ChipOption[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear?: () => void;
}) {
  return (
    <fieldset className="chipgroup">
      <legend>
        {legend}
        {selected.length > 0 && onClear && (
          <button type="button" className="link" onClick={onClear}>
            clear
          </button>
        )}
      </legend>
      <div className="chipgroup-row">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={selected.includes(o.value) ? 'fchip on' : 'fchip'}
            aria-pressed={selected.includes(o.value)}
            onClick={() => onToggle(o.value)}
          >
            {o.color && <i className="swatch" style={{ background: o.color }} />}
            {o.label}
            {o.count != null && <em>{o.count.toLocaleString('en-US')}</em>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
