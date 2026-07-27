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
import {
  ALL_CORRIDORS,
  bucketToLocalTime,
  computeFrameKpis,
  computeWorstCorridors,
} from '../../lib/frames';
import { useAnimationClock } from '../../lib/useAnimationClock';
import { useAvailableDays, useCorridorOptions, useTrafficView } from '../../lib/useTrafficData';
import { useAdvisor } from '../../lib/useAdvisor';
import { TrafficMap } from '../../components/TrafficMap';
import { KpiPanel } from '../../components/KpiPanel';
import { TimeControls } from '../../components/TimeControls';
import { AdvisorPanel } from '../../components/AdvisorPanel';

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
  /**
   * Advisor starts CLOSED so the M1 layout is byte-for-byte what it was on first load.
   * Opening it narrows the map (a flex sibling) rather than overlaying it, so the animation
   * and KPIs stay visible while reading the advice.
   */
  const [showAdvisor, setShowAdvisor] = useState(false);

  const clock = useAnimationClock(DEFAULT_BUCKET, 6);
  const advisor = useAdvisor();
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

  const freewayByStation = useMemo(
    () => (view.stations ? view.stations.map((s) => s.freeway) : []),
    [view.stations],
  );

  const kpis = useMemo(
    () => (view.matrix ? computeFrameKpis(view.matrix, clock.bucket) : null),
    [view.matrix, clock.bucket],
  );
  const worstCorridors = useMemo(
    () =>
      view.matrix ? computeWorstCorridors(view.matrix, clock.bucket, freewayByStation) : [],
    [view.matrix, clock.bucket, freewayByStation],
  );

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
            <p className="text-sm text-muted-foreground">
              Loading one Pacific-local day from DBSQL…
            </p>
          </div>
        ) : (
          <TrafficMap
            stations={view.stations!}
            matrix={view.matrix!}
            hexFrames={view.hexFrames}
            position={clock.position}
            showHexes={showHexes}
            showStations={showStations}
            showCorridors={showCorridors}
            useExternalBasemap={useExternalBasemap}
          />
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
            Hex height = congestion · red column = incident
          </div>
        </div>

        {/* Time controls overlay the map so the clock sits next to what it drives. */}
        <div className="absolute inset-x-3 bottom-16 rounded-lg bg-black/70 p-3 backdrop-blur">
          <TimeControls clock={clock} />
        </div>
      </div>

      {/* ── Side panel ──────────────────────────────────────────────────────── */}
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto lg:w-80">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Day (Pacific)
          </label>
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
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Corridor
          </label>
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

        {kpis ? (
          <KpiPanel
            kpis={kpis}
            worstCorridors={worstCorridors}
            localTime={bucketToLocalTime(clock.bucket)}
            stationCount={view.stations?.length ?? 0}
          />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}

        {!showAdvisor ? (
          <Button
            className="w-full"
            variant="secondary"
            size="sm"
            onClick={() => setShowAdvisor(true)}
            data-testid="advisor-open"
          >
            Ask the AI Congestion Advisor
          </Button>
        ) : null}

        <div className="space-y-2 rounded-lg border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Layers
          </h3>
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

      {/* ── Advisor ─────────────────────────────────────────────────────────────
          A flex SIBLING of the map, not an overlay: opening it narrows the map so the
          animation and KPIs stay visible while reading the advice. The anchor it seeds a
          session from is whatever the map shows right now — current day, current corridor
          filter, and the clock's current bucket. */}
      {showAdvisor ? (
        <AdvisorPanel
          advisor={advisor}
          current={{
            day,
            bucket: clock.bucket,
            localTime: bucketToLocalTime(clock.bucket),
            corridor: freeway,
          }}
          onClose={() => setShowAdvisor(false)}
        />
      ) : null}
    </div>
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
