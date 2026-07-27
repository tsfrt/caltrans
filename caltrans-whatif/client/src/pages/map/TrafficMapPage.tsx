import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from '@databricks/appkit-ui/react';
import { ALL_CORRIDORS, bucketToLocalTime } from '../../lib/frames';
import { useAnimationClock } from '../../lib/useAnimationClock';
import { useAvailableDays, useCorridorOptions, useTrafficView } from '../../lib/useTrafficData';
import { TrafficMap, type MapScenarioMode } from '../../components/TrafficMap';
import { ScenarioBuilderPanel } from '../../components/ScenarioBuilderPanel';
import { ScenarioKpiPanel } from '../../components/ScenarioKpiPanel';
import { TimeControls } from '../../components/TimeControls';
import {
  applyMockScenario,
  computeScenarioKpis,
  computeWorstCorridorDeltas,
  createScenarioRequest,
  type ScenarioLever,
} from '../../lib/scenario';

/**
 * Default day: a Wednesday. Weekend profiles in this dataset are genuinely flatter
 * (avg 66.4 mph vs 63.5 mph on weekdays), so defaulting to a weekend would make the
 * animation look broken on first load. Verified to exist in gold_map_frames
 * (reading_date range 2026-06-01 .. 2026-06-30).
 */
const DEFAULT_DAY = '2026-06-10';

/** Start the playhead just before the AM peak so the first thing a viewer sees is the bloom. */
const DEFAULT_BUCKET = 24; // 06:00 PT

export function TrafficMapPage() {
  const [day, setDay] = useState(DEFAULT_DAY);
  const [freeway, setFreeway] = useState<string>(ALL_CORRIDORS);
  const [showHexes, setShowHexes] = useState(true);
  const [showStations, setShowStations] = useState(true);
  const [showCorridors, setShowCorridors] = useState(true);
  const [useExternalBasemap, setUseExternalBasemap] = useState(false);
  const [scenarioLevers, setScenarioLevers] = useState<ScenarioLever[]>([]);
  const [scenarioMode, setScenarioMode] = useState<MapScenarioMode>('baseline');

  const clock = useAnimationClock(DEFAULT_BUCKET, 6);
  const daysQ = useAvailableDays();
  const corridorsQ = useCorridorOptions();
  const view = useTrafficView(day, freeway);

  // Autoplay once the data is in memory, so the animation is self-evident on load.
  const ready = !!view.matrix && !!view.stations;
  useEffect(() => {
    if (ready) clock.play();
    // Only re-trigger when readiness flips, not on every clock identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const scenarioRequest = useMemo(
    () => createScenarioRequest(day, freeway, scenarioLevers),
    [day, freeway, scenarioLevers]
  );

  const scenario = useMemo(
    () =>
      view.matrix && view.stations && scenarioLevers.length > 0
        ? applyMockScenario(view.matrix, view.stations, scenarioRequest)
        : null,
    [view.matrix, view.stations, scenarioRequest, scenarioLevers.length]
  );

  const displayMatrix = scenarioMode === 'baseline' || !scenario ? view.matrix : scenario.matrix;

  const baselineKpis = useMemo(
    () => (view.matrix && view.stations ? computeScenarioKpis(view.matrix, view.stations, clock.bucket) : null),
    [view.matrix, view.stations, clock.bucket]
  );
  const scenarioKpis = useMemo(
    () => (scenario && view.stations ? computeScenarioKpis(scenario.matrix, view.stations, clock.bucket) : null),
    [scenario, view.stations, clock.bucket]
  );
  const worstCorridors = useMemo(
    () =>
      view.matrix && view.stations
        ? computeWorstCorridorDeltas(view.matrix, scenario?.matrix ?? view.matrix, view.stations, clock.bucket)
        : [],
    [view.matrix, scenario, view.stations, clock.bucket]
  );

  useEffect(() => {
    if (scenarioLevers.length === 0 && scenarioMode !== 'baseline') setScenarioMode('baseline');
  }, [scenarioLevers.length, scenarioMode]);

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-3 lg:flex-row">
      {/* ── Map ─────────────────────────────────────────────────────────────── */}
      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border bg-[#0B2026]">
        {view.error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-destructive">
            Query failed: {view.error}
          </div>
        ) : !ready ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6">
            <Skeleton className="h-4 w-64" />
            <p className="text-sm text-muted-foreground">Loading one Pacific-local day from DBSQL…</p>
          </div>
        ) : displayMatrix ? (
          <TrafficMap
            stations={view.stations!}
            matrix={displayMatrix}
            baselineMatrix={view.matrix}
            hexFrames={view.hexFrames}
            position={clock.position}
            showHexes={showHexes}
            showStations={showStations}
            showCorridors={showCorridors}
            useExternalBasemap={useExternalBasemap}
            scenarioMode={scenarioMode}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-amber-500">
            Waiting for aligned scenario frame data…
          </div>
        )}

        {/* Legend */}
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/60 px-3 py-2 text-xs text-white backdrop-blur">
          <div className="mb-1 font-semibold">Speed (mph)</div>
          <div className="flex items-center gap-1">
            <span className="h-2 w-20 rounded bg-gradient-to-r from-emerald-500 via-amber-400 to-red-600" />
          </div>
          <div className="flex justify-between text-[10px] text-white/70">
            <span>20</span>
            <span>65+</span>
          </div>
          <div className="mt-1 text-[10px] text-white/70">
            {scenarioMode === 'diff'
              ? 'Diff: red slower · green faster · columns ≥8 mph worse'
              : 'Hex height = congestion · red column = incident'}
          </div>
        </div>

        {/* Time controls overlay the map so the clock sits next to what it drives. */}
        <div className="absolute inset-x-3 bottom-16 rounded-lg bg-black/70 p-3 backdrop-blur">
          <TimeControls clock={clock} />
        </div>
      </div>

      {/* ── Side panel ──────────────────────────────────────────────────────── */}
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto lg:w-[27rem]">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Day (Pacific)</label>
          <Select value={day} onValueChange={setDay}>
            <SelectTrigger data-testid="day-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(daysQ.data ?? []).map((d) => (
                <SelectItem key={d.day} value={d.day}>
                  {/* is_weekend is an INT 0/1, not a BOOLEAN: the Statement API returns
                      every JSON value as a string, and the string "false" is truthy in JS,
                      which previously labelled every weekday a weekend. */}
                  {d.day} · {d.day_name}
                  {Number(d.is_weekend) === 1 ? ' (weekend)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Corridor</label>
          <Select value={freeway} onValueChange={setFreeway}>
            <SelectTrigger data-testid="corridor-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* SelectItem value cannot be "", hence the ALL sentinel that also matches
                  the `:freeway = 'ALL'` predicate in SQL. */}
              <SelectItem value={ALL_CORRIDORS}>All corridors</SelectItem>
              {(corridorsQ.data ?? []).map((c) => (
                <SelectItem key={c.freeway} value={c.freeway}>
                  {c.freeway} ({c.station_count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {baselineKpis ? (
          <ScenarioKpiPanel
            baseline={baselineKpis}
            scenario={scenarioKpis}
            worstCorridors={worstCorridors}
            localTime={bucketToLocalTime(clock.bucket)}
            stationCount={view.stations?.length ?? 0}
            warnings={scenario?.warnings ?? []}
          />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}

        {view.stations ? (
          <ScenarioBuilderPanel
            stations={view.stations}
            levers={scenarioLevers}
            onChange={(next) => {
              setScenarioLevers(next);
              if (next.length > 0 && scenarioMode === 'baseline') setScenarioMode('scenario');
            }}
          />
        ) : null}

        <div className="space-y-2 rounded-lg border p-3" data-testid="scenario-map-mode">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Map treatment</h3>
          <div className="grid grid-cols-3 gap-2">
            <ModeButton label="Baseline" value="baseline" mode={scenarioMode} onChange={setScenarioMode} />
            <ModeButton
              label="Scenario"
              value="scenario"
              mode={scenarioMode}
              onChange={setScenarioMode}
              disabled={!scenario}
            />
            <ModeButton label="Diff" value="diff" mode={scenarioMode} onChange={setScenarioMode} disabled={!scenario} />
          </div>
          <p className="text-xs text-muted-foreground">
            All three modes reuse the in-memory 24h matrix; scrubbing and playback do not query DBSQL.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Layers</h3>
          <ToggleRow
            label="H3 hexagons (res 5)"
            checked={showHexes}
            onChange={setShowHexes}
            hint="h3_toparent(r7→r5) in DBSQL"
          />
          <ToggleRow label="Stations" checked={showStations} onChange={setShowStations} />
          <ToggleRow label="Corridor lines" checked={showCorridors} onChange={setShowCorridors} />
          <ToggleRow
            label="External basemap"
            checked={useExternalBasemap}
            onChange={setUseExternalBasemap}
            hint="CARTO tiles; egress not guaranteed"
          />
        </div>
      </aside>
    </div>
  );
}

function ModeButton({
  label,
  value,
  mode,
  onChange,
  disabled = false,
}: {
  label: string;
  value: MapScenarioMode;
  mode: MapScenarioMode;
  onChange: (mode: MapScenarioMode) => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={mode === value ? 'default' : 'secondary'}
      size="sm"
      disabled={disabled}
      onClick={() => onChange(value)}
    >
      {label}
    </Button>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate text-sm">{label}</div>
        {hint ? <div className="truncate text-[10px] text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}
