import { Badge, Card, CardContent } from '@databricks/appkit-ui/react';
import type { CorridorDeltaStat, ScenarioBucketKpis } from '../lib/scenario';
import { bucketLabel } from '../lib/scenario';
import type { ScenarioKpiRow } from '../lib/useScenarioRun';

interface ScenarioKpiPanelProps {
  baseline: ScenarioBucketKpis;
  scenario: ScenarioBucketKpis | null;
  worstCorridors: CorridorDeltaStat[];
  localTime: string;
  stationCount: number;
  warnings: string[];
  /** What the engine says it is. Rendered VERBATIM, never paraphrased. */
  model: { bprCoefficients: string; caveat: string } | null;
  /** The engine's whole-day NETWORK roll-up: the only closed system in the result. */
  networkRow: ScenarioKpiRow | null;
  /** Worst station-buckets by delta VHT, whole-day scope. */
  worstSegments: ScenarioKpiRow[];
}

interface MetricDef {
  label: string;
  unit: string;
  baseline: number;
  scenario: number;
  format: (value: number) => string;
  lowerIsBetter: boolean;
}

export function ScenarioKpiPanel({
  baseline,
  scenario,
  worstCorridors,
  localTime,
  stationCount,
  warnings,
  model,
  networkRow,
  worstSegments,
}: ScenarioKpiPanelProps) {
  const activeScenario = scenario ?? baseline;
  const metrics: MetricDef[] = [
    {
      label: 'Mean speed',
      unit: 'mph',
      baseline: baseline.meanSpeed,
      scenario: activeScenario.meanSpeed,
      format: (v) => v.toFixed(0),
      lowerIsBetter: false,
    },
    {
      label: 'Total flow',
      unit: 'veh/h',
      baseline: baseline.totalFlow,
      scenario: activeScenario.totalFlow,
      format: formatCompact,
      lowerIsBetter: false,
    },
    {
      label: 'Congested',
      unit: '% LOS E/F',
      baseline: baseline.pctCongested,
      scenario: activeScenario.pctCongested,
      format: (v) => v.toFixed(0),
      lowerIsBetter: true,
    },
    {
      label: 'v/c > 1',
      unit: 'stations',
      baseline: baseline.overCapacity,
      scenario: activeScenario.overCapacity,
      format: (v) => String(Math.round(v)),
      lowerIsBetter: true,
    },
    {
      label: 'VHT',
      unit: 'veh-hr/h',
      baseline: baseline.vht,
      scenario: activeScenario.vht,
      format: formatCompact,
      lowerIsBetter: true,
    },
    {
      label: 'VMT',
      unit: 'veh-mi/h',
      baseline: baseline.vmt,
      scenario: activeScenario.vmt,
      format: formatCompact,
      lowerIsBetter: false,
    },
  ];

  return (
    <div className="space-y-3" data-testid="before-after-kpis">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Baseline vs scenario</h3>
              <p className="text-xs text-muted-foreground">
                {stationCount} stations · {localTime} PT · rounded frame estimates
              </p>
            </div>
            <Badge variant={scenario ? 'default' : 'secondary'}>{scenario ? 'Scenario active' : 'Baseline'}</Badge>
          </div>

          <div className="grid grid-cols-[1.2fr_0.9fr_0.9fr_0.8fr] gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>Metric</span>
            <span className="text-right">Base</span>
            <span className="text-right">Scenario</span>
            <span className="text-right">Δ</span>
          </div>
          <div className="space-y-1">
            {metrics.map((metric) => (
              <MetricRow key={metric.label} metric={metric} muted={!scenario} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Worst corridors after scenario
          </h3>
          <ul className="space-y-1" data-testid="worst-corridors">
            {worstCorridors.map((corridor) => (
              <li key={corridor.freeway} className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{corridor.freeway}</span>
                <span className="tabular-nums text-muted-foreground">
                  {corridor.scenarioMeanSpeed.toFixed(0)} mph · Δ {formatDelta(corridor.speedDelta, false, ' mph')}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* ── The engine's own whole-day roll-up ──────────────────────────────────
          Labelled WHOLE DAY because it is not comparable to the per-bucket table
          above: those rows track the clock, these aggregate all 96 buckets. Mixing
          the two without saying so would read as one number contradicting another.

          Only the NETWORK row is a closed system, which is why it ignores the
          corridor filter — a corridor-scoped total makes diverted traffic look
          like it vanished. */}
      {networkRow ? (
        <Card>
          <CardContent className="space-y-2 pt-4" data-testid="engine-network-kpis">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Engine roll-up · whole day · all corridors
              </h3>
              <span className="text-[10px] text-muted-foreground">
                {Number(networkRow.msa_iterations_used)} MSA iters
              </span>
            </div>

            <EngineRow
              label="VHT"
              before={Number(networkRow.vht_before)}
              after={Number(networkRow.vht_after)}
              format={formatCompact}
              lowerIsBetter
            />
            <EngineRow
              label="Mean speed (VMT/VHT)"
              before={Number(networkRow.speed_before)}
              after={Number(networkRow.speed_after)}
              format={(v) => `${v.toFixed(2)} mph`}
              lowerIsBetter={false}
            />
            <EngineRow
              label="LOS E/F cells"
              before={Number(networkRow.los_ef_before)}
              after={Number(networkRow.los_ef_after)}
              format={(v) => String(Math.round(v))}
              lowerIsBetter
            />

            {/* ── Honesty block ────────────────────────────────────────────────
                These two numbers are why the reassignment is defensible at all,
                so they are shown next to the results rather than buried in a doc.

                • Off-network is an honest SINK, not a fudge: this data has 10
                  freeways and no arterials, so some diverted traffic genuinely has
                  nowhere in-model to go.
                • Conservation error is exactly 0 on this row when the model is
                  behaving (MSA damping is a convex combination of two demand
                  vectors). A non-zero value here is a BUG, so it is surfaced.
                • Only 27% of stations have any parallel alternative. Without this,
                  a scenario implies the whole network can re-route. */}
            <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
              <div className="flex justify-between gap-2">
                <span>Demand moved off-network</span>
                <span className="tabular-nums">{formatCompact(Number(networkRow.demand_offnetwork_veh))} veh</span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Conservation error</span>
                <span
                  className={`tabular-nums ${
                    Math.abs(Number(networkRow.conservation_error_veh)) > 1
                      ? 'font-semibold text-destructive'
                      : 'text-emerald-600'
                  }`}
                  data-testid="engine-conservation"
                >
                  {Number(networkRow.conservation_error_veh).toFixed(1)} veh
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Stations with a parallel alternative</span>
                <span className="tabular-nums">
                  {Number(networkRow.stations_with_alternative)} of {Number(networkRow.stations)}
                </span>
              </div>
              <p className="pt-1 leading-snug">
                Off-network traffic left the modelled freeways entirely (local streets, retiming, mode shift, trip
                suppression). It is tracked separately so conservation stays auditable rather than hidden in a residual.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Worst station-buckets. Whole-day scope, so these name the TIME as well as
          the place — unlike the corridor list above, which is at the clock. */}
      {worstSegments.length > 0 ? (
        <Card>
          <CardContent className="pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Worst station-buckets (engine, by Δ VHT)
            </h3>
            <ul className="space-y-1" data-testid="engine-worst-segments">
              {worstSegments.slice(0, 6).map((row) => (
                <li
                  key={`${row.freeway}-${row.direction}-${String(row.bucket_idx)}`}
                  className="flex items-baseline justify-between gap-2 text-sm"
                >
                  <span className="font-medium">
                    {row.freeway} {row.direction}{' '}
                    <span className="text-xs text-muted-foreground">
                      {row.bucket_idx === null ? '' : `${bucketLabel(Number(row.bucket_idx))} PT`}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {Number(row.speed_before).toFixed(0)}→{Number(row.speed_after).toFixed(0)} mph · v/c{' '}
                    {Number(row.vc_before).toFixed(2)}→{Number(row.vc_after).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* What the engine says it is, rendered verbatim. The old mock explicitly
          asked for this: it refused to pick between the two BPR coefficient pairs
          and required the engine to declare which it used. */}
      {model ? (
        <div className="space-y-1 rounded-md border bg-muted/25 p-3 text-xs" data-testid="scenario-model">
          <div className="font-semibold">Model</div>
          <p className="leading-snug text-muted-foreground">BPR volume-delay · {model.bprCoefficients}</p>
          <p className="leading-snug text-muted-foreground">{model.caveat}</p>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
          data-testid="scenario-caveat"
        >
          <div className="mb-1 font-semibold">Lever translation warnings</div>
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** One before/after row of the engine's whole-day roll-up. */
function EngineRow({
  label,
  before,
  after,
  format,
  lowerIsBetter,
}: {
  label: string;
  before: number;
  after: number;
  format: (value: number) => string;
  lowerIsBetter: boolean;
}) {
  const delta = after - before;
  const negligible = Math.abs(delta) < 1e-9;
  const tone = negligible
    ? 'text-muted-foreground'
    : (lowerIsBetter ? delta < 0 : delta > 0)
      ? 'text-emerald-600'
      : 'text-red-600';
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span>{label}</span>
      <span className="tabular-nums">
        <span className="text-muted-foreground">{format(before)}</span>
        <span className="text-muted-foreground"> → </span>
        <span className="font-medium">{format(after)}</span>{' '}
        <span className={`text-xs font-semibold ${tone}`}>
          {/* An exact 0 is meaningful, not a rounding artefact: it is the no-op
              proof holding. Shown as "±0" rather than blank. */}
          {negligible ? '±0' : `${delta > 0 ? '+' : ''}${format(delta)}`}
        </span>
      </span>
    </div>
  );
}

function MetricRow({ metric, muted }: { metric: MetricDef; muted: boolean }) {
  const delta = metric.scenario - metric.baseline;
  const good = metric.lowerIsBetter ? delta < 0 : delta > 0;
  const bad = metric.lowerIsBetter ? delta > 0 : delta < 0;
  const tone =
    muted || Math.abs(delta) < 0.05
      ? 'text-muted-foreground'
      : good
        ? 'text-emerald-600'
        : bad
          ? 'text-red-600'
          : 'text-muted-foreground';

  return (
    <div className="grid grid-cols-[1.2fr_0.9fr_0.9fr_0.8fr] gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-sm">
      <div>
        <div className="font-medium">{metric.label}</div>
        <div className="text-[10px] text-muted-foreground">{metric.unit}</div>
      </div>
      <div className="self-center text-right tabular-nums">{metric.format(metric.baseline)}</div>
      <div className="self-center text-right tabular-nums">{metric.format(metric.scenario)}</div>
      <div className={`self-center text-right font-semibold tabular-nums ${tone}`}>
        {muted ? '—' : formatDelta(delta, metric.lowerIsBetter)}
      </div>
    </div>
  );
}

function formatDelta(delta: number, lowerIsBetter: boolean, suffix = ''): string {
  if (Math.abs(delta) < 0.05) return `±0${suffix}`;
  const rounded =
    Math.abs(delta) >= 1000 ? formatCompact(Math.abs(delta)) : Math.abs(delta).toFixed(Math.abs(delta) >= 10 ? 0 : 1);
  const arrow = lowerIsBetter ? (delta < 0 ? '↓' : '↑') : delta > 0 ? '↑' : '↓';
  return `${delta > 0 ? '+' : '-'}${rounded}${suffix} ${arrow}`;
}

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
