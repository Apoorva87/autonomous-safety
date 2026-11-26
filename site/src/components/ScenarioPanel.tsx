import { DEFAULT_MPV, MPV_RANGE, isNonDefault, mpvFor, type Scenario } from '../state/scenario';
import { PROGRAM_BY_KEY } from '../theme';
import { ScenarioBadge } from './SourceBadge';

/** Global assumptions. Every control here is an assumption or a view choice, not a measurement. */
export function ScenarioPanel({
  scenario, update, reset, mpvPrograms, teslaSelected,
}: {
  scenario: Scenario;
  update: (patch: Partial<Scenario>) => void;
  reset: () => void;
  /** Programs that use an assumed miles per vehicle (vehicles disclosed, miles not). */
  mpvPrograms: string[];
  teslaSelected: boolean;
}) {
  const nonDefault = isNonDefault(scenario) || mpvPrograms.some((p) => mpvFor(scenario, p) !== (DEFAULT_MPV[p] ?? 12000));
  return (
    <section className="scenario-panel" aria-labelledby="scenario-h">
      <div className="scenario-head">
        <h3 id="scenario-h">Scenario: your assumptions {nonDefault && <ScenarioBadge />}</h3>
        <button type="button" className="link" onClick={reset} disabled={!nonDefault}>
          Reset to defaults
        </button>
      </div>
      <p className="small">
        These controls change assumptions, not data. Any number computed from a changed assumption carries a{' '}
        <ScenarioBadge /> badge, and the settings are saved in the page address so a view can be shared.
      </p>
      <div className="scenario-grid">
        <div className="sc-field">
          <label htmlFor="sc-wf">
            SGO capture factor: <b>{scenario.windowFactor.toFixed(2)}</b> <em>(your assumption)</em>
          </label>
          <input
            id="sc-wf" type="range" min={0.1} max={2} step={0.05} value={scenario.windowFactor}
            onChange={(e) => update({ windowFactor: Number(e.target.value) })}
          />
          <p className="small">
            Tesla counts crashes within 5 seconds of disengagement; NHTSA SGO uses 30 seconds. 1.00 = SGO counts exactly as filed.
            The data have no engagement timing, so any other value is only an assumption about how many SGO crashes a 5-second rule would keep.
          </p>
        </div>

        <fieldset className="sc-field">
          <legend>Count unit</legend>
          <label className="check">
            <input type="radio" name="cb" checked={scenario.countBy === 'crashes'} onChange={() => update({ countBy: 'crashes' })} />
            Unique crashes (default)
          </label>
          <label className="check">
            <input type="radio" name="cb" checked={scenario.countBy === 'reports'} onChange={() => update({ countBy: 'reports' })} />
            All reports (a crash can have several)
          </label>
        </fieldset>

        <div className="sc-field">
          <label className="check">
            <input type="checkbox" checked={scenario.lagAdjust} onChange={(e) => update({ lagAdjust: e.target.checked })} />
            Adjust recent months for late reports
          </label>
          <label htmlFor="sc-lm">
            Lag multiplier: <b>{scenario.lagMultiplier.toFixed(2)}</b> <em>(1.00 = empirical lag curve)</em>
          </label>
          <input
            id="sc-lm" type="range" min={0} max={2} step={0.05} value={scenario.lagMultiplier} disabled={!scenario.lagAdjust}
            onChange={(e) => update({ lagMultiplier: Number(e.target.value) })}
          />
          <p className="small">
            Each month's count is divided by the share of that program's reports usually filed by now (lag.json). It only matters for the last few months.
          </p>
        </div>

        {teslaSelected && (
          <fieldset className="sc-field">
            <legend>Tesla L2 denominator</legend>
            <label className="check">
              <input type="radio" name="td" checked={scenario.teslaDenominator === 'fleet'} onChange={() => update({ teslaDenominator: 'fleet' })} />
              US active vehicles (default)
            </label>
            <label className="check">
              <input type="radio" name="td" checked={scenario.teslaDenominator === 'subscribers'} onChange={() => update({ teslaDenominator: 'subscribers' })} />
              Worldwide FSD subscribers x a US share
            </label>
            {scenario.teslaDenominator === 'subscribers' && (
              <>
                <label htmlFor="sc-us">
                  US share of subscribers: <b>{(scenario.subsUsShare * 100).toFixed(0)}%</b> <em>(your assumption)</em>
                </label>
                <input id="sc-us" type="range" min={0.05} max={1} step={0.01} value={scenario.subsUsShare} onChange={(e) => update({ subsUsShare: Number(e.target.value) })} />
                <p className="small">Worldwide subscribers are never a US denominator on their own. The default share is roughly the US share of Tesla's vehicle fleet.</p>
              </>
            )}
          </fieldset>
        )}

        {mpvPrograms.map((p) => (
          <div className="sc-field" key={p}>
            <label htmlFor={`mpv-${p}`}>
              {PROGRAM_BY_KEY[p]?.short ?? p}: miles per vehicle per year <b>{mpvFor(scenario, p).toLocaleString('en-US')}</b>{' '}
              <em>(your assumption)</em>
            </label>
            <input
              id={`mpv-${p}`} type="range" {...MPV_RANGE} value={mpvFor(scenario, p)}
              onChange={(e) => update({ estimates: { ...scenario.estimates, [p]: { milesPerVehicleYear: Number(e.target.value) } } })}
            />
            <p className="small">
              No miles are disclosed for this program, so miles are vehicles x this assumption. Default {(DEFAULT_MPV[p] ?? 12000).toLocaleString('en-US')} is an
              assumption, not a disclosure.
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
