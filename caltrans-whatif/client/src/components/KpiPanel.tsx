import { Badge, Card, CardContent } from '@databricks/appkit-ui/react';
import type { CorridorStat, FrameKpis } from '../lib/frames';

export interface KpiPanelProps {
  kpis: FrameKpis;
  worstCorridors: CorridorStat[];
  localTime: string;
  stationCount: number;
}

/**
 * Live KPIs for the CURRENT animation frame.
 *
 * Every number here is computed client-side from the in-memory matrix
 * (computeFrameKpis / computeWorstCorridors), not fetched. That is what allows them to
 * update in lockstep with the map while the animation runs.
 */
export function KpiPanel({ kpis, worstCorridors, localTime, stationCount }: KpiPanelProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Kpi
          label="Mean speed"
          value={kpis.meanSpeed.toFixed(1)}
          unit="mph"
          tone={kpis.meanSpeed < 40 ? 'bad' : kpis.meanSpeed < 55 ? 'warn' : 'good'}
        />
        <Kpi label="Total flow" value={formatCompact(kpis.totalFlow)} unit="veh/h" />
        <Kpi
          label="Congested"
          value={kpis.pctCongested.toFixed(1)}
          unit="% LOS E/F"
          tone={kpis.pctCongested > 20 ? 'bad' : kpis.pctCongested > 5 ? 'warn' : 'good'}
        />
        <Kpi
          label="Over capacity"
          value={String(kpis.overCapacity)}
          unit="v/c > 1"
          tone={kpis.overCapacity > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {stationCount} stations · {localTime} PT
        </span>
        {kpis.incidents > 0 ? (
          <Badge variant="destructive" data-testid="incident-badge">
            {kpis.incidents} active incident{kpis.incidents === 1 ? '' : 's'}
          </Badge>
        ) : (
          <Badge variant="secondary">No incidents</Badge>
        )}
      </div>

      <Card>
        <CardContent className="pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Worst corridors (slowest first)
          </h3>
          <ul className="space-y-1" data-testid="worst-corridors">
            {worstCorridors.map((c) => (
              <li key={c.freeway} className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{c.freeway}</span>
                <span className="tabular-nums text-muted-foreground">
                  {c.meanSpeed.toFixed(0)} mph · {c.congestedPct.toFixed(0)}% cong.
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  unit: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const toneClass =
    tone === 'bad'
      ? 'text-red-500'
      : tone === 'warn'
        ? 'text-amber-500'
        : tone === 'good'
          ? 'text-emerald-500'
          : 'text-foreground';
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
        <div className="text-xs text-muted-foreground">{unit}</div>
      </CardContent>
    </Card>
  );
}

/** 1234567 -> "1.23M". Total flow across ~2k stations is in the millions. */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
