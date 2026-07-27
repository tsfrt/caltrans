-- Corridor filter options. Small, cacheable, fetched once to populate the dropdown.
--
-- Driven off gold_map_frames rather than silver_stations_geo so the dropdown can only
-- ever offer corridors that actually have animation frames behind them.
SELECT
  freeway,
  CAST(COUNT(DISTINCT station_id) AS INT) AS station_count
FROM lanl.caltrans_traffic.gold_map_frames
GROUP BY freeway
ORDER BY freeway
