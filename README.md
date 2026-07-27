# caltrans — California Traffic What-If Modeling on Databricks

A Databricks App for **what-if traffic modeling** across California highways.

## Architecture

| Layer | Technology | Role |
|---|---|---|
| Data | Unity Catalog + DBSQL | Traffic time series, detector geometry, road network |
| Pipeline | Spark Declarative Pipelines (SDP) | Synthetic Caltrans/PeMS-style traffic generation |
| App config | Lakebase (managed Postgres) | Saved scenarios, user config, audit |
| Models | AI Gateway / Mosaic AI Model Serving | Scenario narration + explanation |
| UI | Databricks Apps | Animated geospatial visualization over DBSQL |

## Status

Under active development. See `.polly/registry.json` for the task ledger.
