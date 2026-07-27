import type { StyleSpecification } from 'maplibre-gl';

/**
 * Basemap strategy.
 *
 * Databricks Apps egress to external tile CDNs is UNVERIFIED (see docs/ARCHITECTURE.md
 * risk R5). So the DEFAULT style below is fully self-contained: a solid background paint
 * layer with no `sources`, meaning MapLibre issues ZERO network requests. The map is
 * therefore guaranteed to render in the deployed app regardless of egress policy.
 *
 * Geographic legibility without tiles comes from the data itself -- a deck.gl PathLayer
 * traces each freeway through its own stations ordered by postmile, so the silhouette of
 * I-5, US-101, I-80 etc. draws the shape of California. That is why the demo is readable
 * on a blank background and does not *need* a basemap.
 *
 * `CARTO_DARK_STYLE` is an OPTIONAL enhancement the user can toggle on. If egress is
 * blocked the raster source simply fails and the background + data layers remain --
 * a degraded basemap, never a broken app.
 */

/** Self-contained style. No `sources` => no network requests at all. */
export const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  name: 'caltrans-offline',
  // MapLibre requires a glyphs URL only if a style uses text layers. Ours does not,
  // so omitting it keeps the zero-request guarantee intact.
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0B2026' }, // Databricks near-black
    },
  ],
};

/**
 * Optional external raster basemap (CARTO dark, no API key required).
 * Only fetched when the user explicitly enables it in the UI.
 */
export const CARTO_DARK_STYLE: StyleSpecification = {
  version: 8,
  name: 'carto-dark',
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0B2026' } },
    { id: 'carto-tiles', type: 'raster', source: 'carto', paint: { 'raster-opacity': 0.75 } },
  ],
};

/** Initial camera: framed on California. */
export const INITIAL_VIEW_STATE = {
  longitude: -119.4,
  latitude: 36.4,
  zoom: 5.1,
  pitch: 35,
  bearing: 0,
} as const;
