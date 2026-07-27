-- Station geometry + immutable attributes. Fetched ONCE per session.
--
-- This is the "geometry once" half of the architecture rule in docs/ARCHITECTURE.md §3:
-- nothing queries the warehouse during animation, so every per-station attribute that
-- does NOT vary with time lives here and is joined to the time matrix client-side by
-- the shared station_idx ordering (ORDER BY station_id, identical to traffic_time_matrix).
--
-- `baseline_capacity_vph` / `baseline_lanes` are carried deliberately: the M2 what-if
-- engine perturbs exactly these fields, so the client already holds the denominator it
-- needs to recompute v/c under a scenario without a new geometry fetch.
--
-- Restricted to stations that actually appear in gold_map_frames (1,994 of the 2,022 in
-- silver_stations_geo) so the client's station_idx arrays line up exactly with the
-- time matrix. Without this, 28 stations would render as permanent holes on the map.
SELECT
  s.station_id,
  s.freeway,
  s.direction,
  s.district,
  s.county,
  s.city,
  s.postmile,
  s.latitude,
  s.longitude,
  s.num_lanes,
  s.station_type,
  -- deck.gl H3HexagonLayer requires the canonical hex string form, not the BIGINT.
  -- h3_h3tostring is the correct builtin on this channel (h3_h3celltostring does NOT exist).
  h3_h3tostring(s.h3_r7) AS h3_r7,
  h3_h3tostring(s.h3_r8) AS h3_r8,
  s.baseline_capacity_vph,
  s.baseline_lanes
FROM lanl.caltrans_traffic.silver_stations_geo s
WHERE EXISTS (
  SELECT 1 FROM lanl.caltrans_traffic.gold_map_frames g
  WHERE g.station_id = s.station_id
)
ORDER BY s.station_id
