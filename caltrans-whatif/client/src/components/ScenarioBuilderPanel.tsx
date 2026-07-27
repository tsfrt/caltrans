import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';
import {
  bucketLabel,
  leverSummary,
  scenarioTargetFromStation,
  type CapacityChangeLever,
  type ClosureLever,
  type DemandDeltaLever,
  type IncidentLever,
  type ScenarioLever,
} from '../lib/scenario';
import type { StationRow } from '../lib/useTrafficData';

interface ScenarioBuilderPanelProps {
  stations: StationRow[];
  levers: ScenarioLever[];
  onChange: (levers: ScenarioLever[]) => void;
}

const DIRECTIONS = ['N', 'S', 'E', 'W'] as const;

export function ScenarioBuilderPanel({ stations, levers, onChange }: ScenarioBuilderPanelProps) {
  const [targetId, setTargetId] = useState(stations[0]?.station_id ?? '');
  const [search, setSearch] = useState('');
  const [lanesClosed, setLanesClosed] = useState(1);
  const [demandFreeway, setDemandFreeway] = useState(stations[0]?.freeway ?? 'I-5');
  const [demandDirection, setDemandDirection] = useState(stations[0]?.direction ?? 'N');
  const [demandPercent, setDemandPercent] = useState(-10);
  const [incidentStart, setIncidentStart] = useState(28);
  const [incidentDuration, setIncidentDuration] = useState(4);
  const [incidentSeverity, setIncidentSeverity] = useState<1 | 2 | 3 | 4>(3);
  const [incidentLanes, setIncidentLanes] = useState(1);
  const [capacityVph, setCapacityVph] = useState(1600);

  const stationById = useMemo(() => new Map(stations.map((station) => [station.station_id, station])), [stations]);
  const selectedStation = stationById.get(targetId) ?? stations[0];
  const freeways = useMemo(() => [...new Set(stations.map((station) => station.freeway))].sort(), [stations]);
  const filteredStations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = needle
      ? stations.filter((station) =>
          `${station.station_id} ${station.freeway} ${station.direction} ${station.city} ${station.county} ${station.postmile}`
            .toLowerCase()
            .includes(needle)
        )
      : stations;
    return rows.slice(0, 80);
  }, [search, stations]);

  function append(lever: ScenarioLever): void {
    onChange([...levers, lever]);
  }

  function target() {
    return scenarioTargetFromStation(selectedStation);
  }

  return (
    <Card data-testid="scenario-builder">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Scenario levers</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Client mock boundary: compose levers now; engine route swaps in later.
            </p>
          </div>
          <Badge variant={levers.length > 0 ? 'default' : 'secondary'}>{levers.length} active</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            htmlFor="station-search"
          >
            Target station / segment
          </label>
          <input
            id="station-search"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Search freeway, city, postmile…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={selectedStation?.station_id ?? ''}
            onChange={(event) => setTargetId(event.target.value)}
            aria-label="Scenario target"
            data-testid="scenario-target-select"
          >
            {filteredStations.map((station) => (
              <option key={station.station_id} value={station.station_id}>
                {station.freeway} {station.direction} · PM {formatPostmile(station.postmile)} · {station.city} ·{' '}
                {station.station_id}
              </option>
            ))}
          </select>
        </div>

        <LeverSection title="1. Segment / station closure">
          <NumberField label="Lanes closed" value={lanesClosed} min={1} max={8} onChange={setLanesClosed} />
          <Button
            type="button"
            size="sm"
            onClick={() =>
              append({
                id: crypto.randomUUID(),
                type: 'closure',
                target: target(),
                lanesClosed,
              } satisfies ClosureLever)
            }
          >
            Add closure
          </Button>
        </LeverSection>

        <LeverSection title="2. Corridor demand delta">
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="Freeway" value={demandFreeway} values={freeways} onChange={setDemandFreeway} />
            <SelectField
              label="Direction"
              value={demandDirection}
              values={[...DIRECTIONS]}
              onChange={setDemandDirection}
            />
          </div>
          <NumberField label="Demand change (%)" value={demandPercent} min={-80} max={80} onChange={setDemandPercent} />
          <Button
            type="button"
            size="sm"
            onClick={() =>
              append({
                id: crypto.randomUUID(),
                type: 'demand_delta',
                freeway: demandFreeway,
                direction: demandDirection,
                percent: demandPercent,
              } satisfies DemandDeltaLever)
            }
          >
            Add demand delta
          </Button>
        </LeverSection>

        <LeverSection title="3. Incident injection">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label={`Start hour (${bucketLabel(incidentStart)} PT)`}
              value={Math.floor(incidentStart / 4)}
              min={0}
              max={23}
              onChange={(hour) => setIncidentStart(hour * 4)}
            />
            <NumberField
              label="Duration (15-min buckets)"
              value={incidentDuration}
              min={1}
              max={24}
              onChange={setIncidentDuration}
            />
            <NumberField
              label="Severity"
              value={incidentSeverity}
              min={1}
              max={4}
              onChange={(value) => setIncidentSeverity(clampSeverity(value))}
            />
            <NumberField label="Lanes blocked" value={incidentLanes} min={1} max={8} onChange={setIncidentLanes} />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() =>
              append({
                id: crypto.randomUUID(),
                type: 'incident',
                target: target(),
                startBucket: incidentStart,
                durationBuckets: incidentDuration,
                severity: incidentSeverity,
                lanesBlocked: incidentLanes,
              } satisfies IncidentLever)
            }
          >
            Add incident
          </Button>
        </LeverSection>

        <LeverSection title="4. Capacity change">
          <NumberField
            label="Override capacity (veh/h)"
            value={capacityVph}
            min={250}
            max={12000}
            step={100}
            onChange={setCapacityVph}
          />
          <Button
            type="button"
            size="sm"
            onClick={() =>
              append({
                id: crypto.randomUUID(),
                type: 'capacity_change',
                target: target(),
                capacityVph,
              } satisfies CapacityChangeLever)
            }
          >
            Add capacity change
          </Button>
        </LeverSection>

        <div className="space-y-2 rounded-md border bg-muted/25 p-3" data-testid="scenario-summary">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active scenario</h3>
            <Button type="button" variant="secondary" size="sm" onClick={() => onChange([])}>
              Reset baseline
            </Button>
          </div>
          {levers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Baseline only. Add levers to compare a scenario.</p>
          ) : (
            <ol className="list-decimal space-y-1 pl-4 text-sm">
              {levers.map((lever) => (
                <li key={lever.id}>
                  <span>{leverSummary(lever)}</span>{' '}
                  <button
                    className="text-xs text-muted-foreground underline"
                    type="button"
                    onClick={() => onChange(levers.filter((item) => item.id !== lever.id))}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LeverSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-md border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      <input
        className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm text-foreground"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value), min, max))}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      <select
        className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {values.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampSeverity(value: number): 1 | 2 | 3 | 4 {
  return clamp(value, 1, 4) as 1 | 2 | 3 | 4;
}

function formatPostmile(postmile: number): string {
  return Number(postmile).toFixed(1);
}
