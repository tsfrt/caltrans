import { Badge, Card, CardContent } from '@databricks/appkit-ui/react';
import type { CorridorDeltaStat, ScenarioBucketKpis } from '../lib/scenario';

interface ScenarioKpiPanelProps {
  baseline: ScenarioBucketKpis;
  scenario: ScenarioBucketKpis | null;
  worstCorridors: CorridorDeltaStat[];
  localTime: string;
  stationCount: number;
  warnings: string[];
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

      {warnings.length > 0 ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
          data-testid="scenario-caveat"
        >
          <div className="mb-1 font-semibold">Model caveat</div>
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
