import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer, ColumnLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CARTO_DARK_STYLE, INITIAL_VIEW_STATE, OFFLINE_STYLE } from '../lib/mapStyle';
import { frameSlice, speedToColor, type FrameMatrix, type HexFrames } from '../lib/frames';
import type { StationRow } from '../lib/useTrafficData';

export type MapScenarioMode = 'baseline' | 'scenario' | 'diff';

interface HexCell {
  hexId: string;
  /** 0..1 congestion index for this hex in the current bucket */
  congestion: number;
  /** mph */
  speed: number;
}

export interface TrafficMapProps {
  stations: StationRow[];
  matrix: FrameMatrix;
  baselineMatrix?: FrameMatrix | null;
  hexFrames: HexFrames | null;
  /** Fractional bucket position from the animation clock. */
  position: number;
  showHexes: boolean;
  showStations: boolean;
  showCorridors: boolean;
  useExternalBasemap: boolean;
  scenarioMode: MapScenarioMode;
}

/**
 * MapLibre GL basemap with a deck.gl overlay, driven entirely from in-memory typed arrays.
 *
 * Rendering approach: the MapLibre map instance and the deck.gl overlay are created ONCE
 * and then mutated via `overlay.setProps({ layers })` on each animation tick. Recreating
 * either per frame would drop WebGL contexts and make playback stutter, so the map lives
 * in a ref outside React's render cycle and only the layer array is regenerated.
 */
export function TrafficMap({
  stations,
  matrix,
  baselineMatrix,
  hexFrames,
  position,
  showHexes,
  showStations,
  showCorridors,
  useExternalBasemap,
  scenarioMode,
}: TrafficMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  // ── Create the map once ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OFFLINE_STYLE,
      center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
      zoom: INITIAL_VIEW_STATE.zoom,
      pitch: INITIAL_VIEW_STATE.pitch,
      bearing: INITIAL_VIEW_STATE.bearing,
      // No external font/sprite fetches -- keeps the offline guarantee.
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);

    mapRef.current = map;
    overlayRef.current = overlay;

    // The container can be laid out (or resized) after MapLibre measures it, which would
    // otherwise leave the canvas at a stale size. A ResizeObserver keeps the drawing buffer
    // in step with the element for the life of the map.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // ── Swap basemap style on toggle ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(useExternalBasemap ? CARTO_DARK_STYLE : OFFLINE_STYLE);
  }, [useExternalBasemap]);

  // ── Static geometry: freeway centrelines traced through their own stations ────
  // Built once per station set. This is what makes California legible with no basemap:
  // ordering each corridor's stations by postmile draws the actual highway shape.
  const corridorPaths = useMemo(() => {
    const byCorridor = new Map<string, StationRow[]>();
    for (const s of stations) {
      const key = `${s.freeway} ${s.direction}`;
      let list = byCorridor.get(key);
      if (!list) {
        list = [];
        byCorridor.set(key, list);
      }
      list.push(s);
    }
    return [...byCorridor.entries()].map(([name, rows]) => ({
      name,
      path: rows
        .slice()
        .sort((a, b) => a.postmile - b.postmile)
        .map((s) => [s.longitude, s.latitude] as [number, number]),
    }));
  }, [stations]);

  // Flat position array for the station layers -- allocated once, reused every frame.
  const positions = useMemo(() => {
    const arr = new Float64Array(stations.length * 2);
    for (let i = 0; i < stations.length; i++) {
      arr[i * 2] = stations[i].longitude;
      arr[i * 2 + 1] = stations[i].latitude;
    }
    return arr;
  }, [stations]);

  // ── Per-frame interpolated metrics ───────────────────────────────────────────
  // Interpolating between the two neighbouring 15-minute buckets is what makes playback
  // read as continuous motion instead of 96 visible steps.
  const frame = useMemo(() => {
    const { stationCount, bucketCount } = matrix;
    const b0 = Math.floor(position) % bucketCount;
    const b1 = (b0 + 1) % bucketCount;
    const t = position - Math.floor(position);

    const speed0 = frameSlice(matrix.speed, b0, stationCount);
    const speed1 = frameSlice(matrix.speed, b1, stationCount);
    const flow0 = frameSlice(matrix.flow, b0, stationCount);
    const flow1 = frameSlice(matrix.flow, b1, stationCount);
    const vc0 = frameSlice(matrix.vc, b0, stationCount);
    const vc1 = frameSlice(matrix.vc, b1, stationCount);
    // Incidents are discrete events -- interpolating them would invent half-incidents,
    // so the nearer bucket wins.
    const incident = frameSlice(matrix.incident, t < 0.5 ? b0 : b1, stationCount);

    const speed = new Float32Array(stationCount);
    const flow = new Float32Array(stationCount);
    const vc = new Float32Array(stationCount);
    for (let i = 0; i < stationCount; i++) {
      const s0 = speed0[i];
      const s1 = speed1[i];
      // NaN means "no reading"; blend only when both ends are real.
      speed[i] = Number.isNaN(s0) ? s1 : Number.isNaN(s1) ? s0 : s0 + (s1 - s0) * t;
      flow[i] = flow0[i] + (flow1[i] - flow0[i]) * t;
      vc[i] = vc0[i] + (vc1[i] - vc0[i]) * t;
    }
    return { speed, flow, vc, incident };
  }, [matrix, position]);

  const baselineFrame = useMemo(() => {
    if (!baselineMatrix || scenarioMode !== 'diff') return null;
    const { stationCount, bucketCount } = baselineMatrix;
    const bucket = Math.floor(position) % bucketCount;
    return {
      speed: frameSlice(baselineMatrix.speed, bucket, stationCount),
      vc: frameSlice(baselineMatrix.vc, bucket, stationCount),
    };
  }, [baselineMatrix, position, scenarioMode]);

  // Hex cells for the current frame, read out of the day-wide typed arrays. Cells with no
  // data in this bucket (NaN, the -1 SQL sentinel) are dropped rather than drawn as
  // free-flowing.
  const hexCells = useMemo(() => {
    if (!hexFrames) return [];
    const bucket = Math.floor(position) % matrix.bucketCount;
    const { hexCount, hexIds } = hexFrames;
    const base = bucket * hexCount;
    const cells: HexCell[] = [];
    for (let i = 0; i < hexCount; i++) {
      const congestion = hexFrames.congestion[base + i];
      if (Number.isNaN(congestion)) continue;
      cells.push({ hexId: hexIds[i], congestion, speed: hexFrames.speed[base + i] });
    }
    return cells;
  }, [hexFrames, position, matrix.bucketCount]);

  // Guard against a degenerate 0 max (e.g. an all-free-flow corridor) so elevation never
  // divides by zero.
  const elevationDenominator = Math.max(hexFrames?.maxCongestion ?? 0, 0.05);

  // ── Layers ───────────────────────────────────────────────────────────────────
  const layers = useMemo(() => {
    const out: Layer[] = [];

    if (showCorridors) {
      out.push(
        new PathLayer({
          id: 'corridors',
          data: corridorPaths,
          getPath: (d: { path: [number, number][] }) => d.path,
          getColor: [70, 98, 201, 140],
          getWidth: 2,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          pickable: false,
        })
      );
    }

    if (showHexes && hexCells.length > 0) {
      out.push(
        // The DBSQL H3 showcase: the cells and their congestion values are computed in the
        // warehouse by h3_congestion_hexes.sql (h3_h3tostring over h3_r7, grouped by
        // Pacific-local 15-min bucket). This layer only draws what came back.
        new H3HexagonLayer({
          id: 'h3-congestion',
          data: hexCells,
          getHexagon: (d: HexCell) => d.hexId,
          getFillColor: (d: HexCell) => {
            const [r, g, b] = speedToColor(d.speed);
            return [r, g, b, 165];
          },
          // Normalised against the day's observed max so the tallest hex is always legible.
          // congestion_index is heavily skewed (p50 0.008 vs max 0.884), so scaling by a
          // fixed factor left every hexagon flat.
          getElevation: (d: HexCell) => (d.congestion / elevationDenominator) * 45000,
          extruded: true,
          elevationScale: 1,
          filled: true,
          stroked: false,
          pickable: true,
          // Congestion changes every frame, so colour and elevation must be told to
          // recompute; without this deck.gl caches the first frame's attributes forever.
          updateTriggers: {
            getFillColor: hexCells,
            getElevation: [hexCells, elevationDenominator],
          },
        })
      );
    }

    if (showStations) {
      out.push(
        new ScatterplotLayer({
          id: 'stations',
          data: {
            length: stations.length,
            attributes: { getPosition: { value: positions, size: 2 } },
          },
          getFillColor: (_: unknown, { index }: { index: number }) => {
            if (scenarioMode === 'diff' && baselineFrame) {
              const delta = frame.speed[index] - baselineFrame.speed[index];
              const magnitude = Math.min(1, Math.abs(delta) / 18);
              if (delta < -0.25) return [235, 22, 0, Math.round(120 + magnitude * 120)];
              if (delta > 0.25) return [16, 185, 129, Math.round(120 + magnitude * 120)];
              return [148, 163, 184, 120];
            }
            const [r, g, b] = speedToColor(frame.speed[index]);
            return [r, g, b, 230];
          },
          // Radius by flow so rush hour visibly blooms, not just recolours.
          getRadius: (_: unknown, { index }: { index: number }) => 600 + Math.sqrt(Math.max(0, frame.flow[index])) * 55,
          radiusUnits: 'meters',
          radiusMinPixels: 1.5,
          radiusMaxPixels: 14,
          pickable: true,
          updateTriggers: { getFillColor: position, getRadius: position },
        })
      );

      if (scenarioMode === 'diff' && baselineFrame) {
        const regressionRows: Array<{ position: [number, number]; delta: number }> = [];
        for (let i = 0; i < stations.length; i++) {
          const delta = frame.speed[i] - baselineFrame.speed[i];
          if (delta < -8) {
            regressionRows.push({ position: [stations[i].longitude, stations[i].latitude], delta });
          }
        }
        if (regressionRows.length > 0) {
          out.push(
            new ColumnLayer({
              id: 'scenario-speed-regressions',
              data: regressionRows,
              getPosition: (d: { position: [number, number] }) => d.position,
              getFillColor: [235, 22, 0, 210],
              getElevation: (d: { delta: number }) => Math.min(30000, Math.abs(d.delta) * 1800),
              radius: 1700,
              extruded: true,
              diskResolution: 10,
              pickable: true,
              updateTriggers: { getElevation: position },
            })
          );
        }
      }

      // Incident stations: a distinct extruded column, so they read as events rather than
      // just another dot in the congestion ramp.
      const incidentRows: Array<{
        position: [number, number];
        severity: number;
        station: StationRow;
      }> = [];
      for (let i = 0; i < stations.length; i++) {
        if (frame.incident[i] > 0) {
          incidentRows.push({
            position: [stations[i].longitude, stations[i].latitude],
            severity: frame.incident[i],
            station: stations[i],
          });
        }
      }
      if (incidentRows.length > 0) {
        out.push(
          new ColumnLayer({
            id: 'incidents',
            data: incidentRows,
            getPosition: (d: { position: [number, number] }) => d.position,
            getFillColor: [235, 22, 0, 235],
            getElevation: (d: { severity: number }) => 8000 + d.severity * 9000,
            radius: 2600,
            extruded: true,
            diskResolution: 12,
            pickable: true,
            updateTriggers: { getElevation: position, getFillColor: position },
          })
        );
      }
    }

    return out;
  }, [
    corridorPaths,
    hexCells,
    stations,
    positions,
    frame,
    baselineFrame,
    position,
    showHexes,
    showStations,
    showCorridors,
    elevationDenominator,
    scenarioMode,
  ]);

  // Push layers to the existing overlay. This is the only per-frame work.
  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  // MapLibre's own stylesheet sets `.maplibregl-map { position: relative }`, which wins over
  // a Tailwind `absolute` utility class on the same element and collapsed `inset-0` to a
  // zero-height box -- the canvas then stuck at its 300x150 default and the map rendered
  // blank while every KPI looked correct. Inline styles beat the library stylesheet, and
  // h-full/w-full is belt-and-braces. The parent is `relative`, so overlays still position
  // against it.
  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ position: 'absolute', inset: 0 }}
      data-testid="traffic-map"
    />
  );
}
