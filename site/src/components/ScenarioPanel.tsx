import { DEFAULT_MPV, MPV_RANGE, isNonDefault, mpvAssumed, mpvFor, type Scenario } from '../state/scenario';
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
  const nonDefault = isNonDefault(scenario);
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
            Tesla's Vehicle Safety Report counts crashes with Autopilot active, or deactivated, within 5 seconds before impact; SGO reports (ADS and Level 2 alike) use a 30-second engagement window. 1.00 = SGO counts exactly as filed.
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
            Each month's count is divided by the share of that program's reports usually filed by now, in whole months, using the completeness curve of that month's own regime (before or after the 2025-06-16 rule change; filing got faster after it, so the curves are never pooled; lag.json). It only matters for the last few months.
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

        <div className="sc-field">
          <label className="check">
            <input type="checkbox" checked={scenario.riderOnly} onChange={(e) => update({ riderOnly: e.target.checked })} />
            Rider-only numerator (default on)
          </label>
          <p className="small">
            Waymo, Cruise, Zoox and Tesla Robotaxi miles are rider-only (no human driver on board). With this on, only crashes whose operator type is none or
            remote are counted for them; crashes with an in-vehicle operator are left out and their number is shown. Turn it off to count every filed crash against the same miles.
          </p>
        </div>

        {mpvPrograms.map((p) => {
          const set = mpvAssumed(scenario, p);
          const name = PROGRAM_BY_KEY[p]?.short ?? p;
          return (
            <div className="sc-field" key={p}>
              <label className="check">
                <input
                  type="checkbox" checked={set != null}
                  onChange={(e) => {
                    const next = { ...scenario.estimates };
                    if (e.target.checked) next[p] = { milesPerVehicleYear: mpvFor(scenario, p) };
                    else delete next[p];
                    update({ estimates: next });
                  }}
                />
                {name}: assume miles per vehicle (off by default)
              </label>
              {set != null ? (
                <>
                  <label htmlFor={`mpv-${p}`}>
                    Miles per vehicle per year <b>{set.toLocaleString('en-US')}</b> <em>(your assumption)</em> <ScenarioBadge />
                  </label>
                  <input
                    id={`mpv-${p}`} type="range" {...MPV_RANGE} value={set}
                    onChange={(e) => update({ estimates: { ...scenario.estimates, [p]: { milesPerVehicleYear: Number(e.target.value) } } })}
                  />
                  <p className="small">
                    Miles are vehicles x this assumption x the months covered. No miles are disclosed for {name}, so this is not a measurement; every number built on it
                    is badged and left out of the funnel plot.
                  </p>
                </>
              ) : (
                <p className="small">
                  No miles are disclosed for {name}, so there is no per-mile series. Switch this on to see one built from an assumption you choose (a suggested start is{' '}
                  {(DEFAULT_MPV[p] ?? 12000).toLocaleString('en-US')} miles per vehicle per year; that is not a disclosure).
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
