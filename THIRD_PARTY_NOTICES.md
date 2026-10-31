# Third-party notices

SkyPulse's own code (everything outside `LiveWeather/vendor/`) was written for this project. This file lists what it
includes or uses from others, and under which terms.

## Bundled software and fonts (`LiveWeather/vendor/`)

Each file is the unmodified release published on npm, kept with its licence next to it.

| Component | Version | Licence | Copyright | Licence file |
|---|---|---|---|---|
| [Chart.js](https://www.chartjs.org/) | 4.4.1 (`dist/chart.umd.js`) | MIT | © 2014–2023 Chart.js Contributors | `vendor/chartjs/LICENSE.md` |
| [Leaflet](https://leafletjs.com/) | 1.9.4 (`dist/leaflet.js`, `leaflet.css`, layer/marker images) | BSD 2-Clause | © 2010–2023 Volodymyr Agafonkin, © 2010–2011 CloudMade | `vendor/leaflet/LICENSE` |
| [Inter](https://github.com/rsms/inter) variable font (Latin and Latin Extended subsets, from `@fontsource-variable/inter` 5.3.0) | 4.x | SIL Open Font License 1.1 | © 2016 The Inter Project Authors | `vendor/inter/LICENSE` |

They are served from the site itself rather than from public CDNs or Google Fonts, so a visitor's browser makes no
requests to those third parties.

## Data and map services (called at run time)

Used under each provider's own terms; the app footer and the cyclone card show the required attributions.

- **Open-Meteo**: forecast, 15-minute data, air quality, marine, elevation and geocoding. Data under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The free API is for **non-commercial** use; commercial
  use needs an [Open-Meteo API subscription](https://open-meteo.com/en/pricing).
- **BigDataCloud**: client-side reverse geocoding (place names).
- **Esri**: World Dark Gray Canvas basemap tiles, © Esri, HERE, Garmin and © OpenStreetMap contributors.
- **Tropical cyclones and warnings**:
  - NOAA National Hurricane Center and National Weather Service (U.S. Government works);
  - Japan Meteorological Agency;
  - Joint Typhoon Warning Center;
  - India Meteorological Department and NDMA SACHET;
  - GDACS (European Commission / UN);
  - Hong Kong Observatory open data.

  These are collected by `pipeline/fetch_tropical.py` or fetched live, and always credited to the issuing agency in the UI.

- **Research station positions** (`stations.js`): published coordinates of national Antarctic and Arctic programme
  stations (facts, not creative content), compiled for SkyPulse and rounded.

## Methods implemented from public descriptions

All of these were implemented independently for SkyPulse from published equations or standard textbook algorithms.

- **Sun position and sun events** (`sun.js`): the NOAA Solar Calculator equations (after Jean Meeus,
  *Astronomical Algorithms*), published by NOAA's Global Monitoring Laboratory.
- **Moon position, rise/set and phases** (`moon.js`): the main periodic terms of the lunar theory as published in Jean
  Meeus, *Astronomical Algorithms* (ch. 47), standard parallax and parallactic-angle formulas, and Bennett's refraction
  formula.
- **Cyclone geometry** (`hazards.js`):
  - great-circle distance (haversine), initial bearing and destination point;
  - point-in-polygon by ray casting;
  - convex hull by Andrew's monotone chain.
- **Intensity scales** and **forecast-cone radii**: the Saffir–Simpson scale, the regional agencies' published category
  thresholds, and NHC's published average track errors.
- **Typical intensity error band** (`storms.js`): approximate multi-year averages of official intensity-forecast errors.
  It is labelled in the app as a guide, not as an official product.
- **Sky colour** (`sky.js`): SkyPulse's own rules, based on textbook atmospheric optics: Rayleigh and aerosol (Mie)
  scattering, hygroscopic growth of aerosols, and the longer light path at low sun angles. The Saffir–Simpson colour
  ramp used for storm symbols is SkyPulse's own choice of colours.
