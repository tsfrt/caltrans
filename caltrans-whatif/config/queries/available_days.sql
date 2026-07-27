-- Selectable days for the animation. Tiny result; drives the date picker.
--
-- reading_date IS the Pacific local date (verified against all 5,742,720 rows), so these
-- values can be handed straight back as the :day parameter with no timezone arithmetic.
-- day_of_week / is_weekend come along so the UI can label weekends -- weekend profiles
-- are genuinely flatter in this data (avg speed 66.4 vs 63.5 mph on weekdays), so a demo
-- that lands on a Saturday would otherwise look like the animation is broken.
-- is_weekend is returned as an INT, not a BOOLEAN, on purpose. The SQL Statement API
-- serialises every JSON_ARRAY value as a STRING, so a BOOLEAN column arrives at the client
-- as the string "false" -- which is TRUTHY in JavaScript and silently labelled every
-- weekday as a weekend. An INT 0/1 survives the round trip unambiguously.
-- Verified: raw data_array for 2026-06-10 was ['2026-06-10', 'false'].
SELECT
  reading_date AS day,
  CAST(MAX(day_of_week) AS INT) AS day_of_week,
  CAST(MAX(CASE WHEN is_weekend THEN 1 ELSE 0 END) AS INT) AS is_weekend,
  date_format(reading_date, 'EEE') AS day_name,
  CAST(COUNT(DISTINCT station_id) AS INT) AS station_count
FROM lanl.caltrans_traffic.gold_map_frames
GROUP BY reading_date
ORDER BY reading_date
