import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

const TOKEN_PLACEHOLDER = 'YOUR_MAPBOX_PUBLIC_TOKEN';

async function resolveMapboxAccessToken() {
  try {
    const mod = await import('./mapbox-token.local.js');
    const token = typeof mod.default === 'string' ? mod.default.trim() : '';
    if (token && token !== TOKEN_PLACEHOLDER) return token;
  } catch {

  }
  return '';
}

const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function departureRatioForStation(d) {
  if (!d.totalTraffic) return 0.5;
  return stationFlow(d.departures / d.totalTraffic);
}

function tooltipLines(d) {
  return `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;
}

const lanePaint = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.5,
};

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Prefix sums over 1440 minutes: pref[i] = sum(hist[0..i-1]), pref[1440] = total */
function minuteHistogramToPrefix(hist) {
  const pref = new Uint32Array(1441);
  for (let i = 0; i < 1440; i++) {
    pref[i + 1] = pref[i] + hist[i];
  }
  return pref;
}

/**
 * Trip counts in the same time window as Lab 7 filterByMinute (half-open minute ranges).
 */
function countTripsInTimeWindow(pref, centerMinute) {
  if (!pref) return 0;
  const minM = (centerMinute - 60 + 1440) % 1440;
  const maxM = (centerMinute + 60) % 1440;
  if (minM > maxM) {
    return pref[1440] - pref[minM] + pref[maxM];
  }
  return pref[maxM] - pref[minM];
}

async function bootstrap() {
  const accessToken = await resolveMapboxAccessToken();

  mapboxgl.accessToken = accessToken;

  const missingToken =
    !accessToken || accessToken === TOKEN_PLACEHOLDER;

  if (missingToken) {
    console.warn(
      'Mapbox token missing. Create mapbox-token.local.js exporting your pk… token (see .github/workflows/pages.yml).',
    );
    const bar = document.createElement('div');
    bar.role = 'alert';
    bar.textContent =
      'Missing Mapbox public token — add mapbox-token.local.js locally, or MAPBOX_PUBLIC_TOKEN in GitHub repo secrets + Pages workflow.';
    Object.assign(bar.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '10000',
      background: '#7f1d1d',
      color: '#fff',
      padding: '12px 16px',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      textAlign: 'center',
    });
    document.body.prepend(bar);
    return;
  }

  const map = new mapboxgl.Map({
    container: 'map-canvas-root',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18,
  });

  function getCoords(station) {
    const point = new mapboxgl.LngLat(+station.lon, +station.lat);
    const { x, y } = map.project(point);
    return { cx: x, cy: y };
  }

  const svg = d3.select('#map').select('svg');

  /** Per-station departure/arrival counts by minute-of-day, then prefix sums for O(1) window queries */
  let departurePrefixByStation = new Map();
  let arrivalPrefixByStation = new Map();

  let allDepartures;
  let allArrivals;

  function computeStationTraffic(stations, timeFilter = -1) {
    if (timeFilter === -1 && allDepartures && allArrivals) {
      return stations.map((station) => {
        const id = station.short_name;
        station.arrivals = allArrivals.get(id) ?? 0;
        station.departures = allDepartures.get(id) ?? 0;
        station.totalTraffic = station.arrivals + station.departures;
        return station;
      });
    }

    return stations.map((station) => {
      const id = station.short_name;
      const depPref = departurePrefixByStation.get(id);
      const arrPref = arrivalPrefixByStation.get(id);
      station.departures = countTripsInTimeWindow(depPref, timeFilter);
      station.arrivals = countTripsInTimeWindow(arrPref, timeFilter);
      station.totalTraffic = station.arrivals + station.departures;
      return station;
    });
  }

  map.on('load', async () => {
    map.addSource('boston_route', {
      type: 'geojson',
      data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
    });

    map.addLayer({
      id: 'bike-lanes',
      type: 'line',
      source: 'boston_route',
      paint: lanePaint,
    });

    map.addSource('cambridge_route', {
      type: 'geojson',
      data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
    });

    map.addLayer({
      id: 'bike-lanes-cambridge',
      type: 'line',
      source: 'cambridge_route',
      paint: lanePaint,
    });

    let jsonData;
    try {
      jsonData = await d3.json(
        'https://dsc106.com/labs/lab07/data/bluebikes-stations.json',
      );
      console.log('Loaded JSON Data:', jsonData);
    } catch (error) {
      console.error('Error loading JSON:', error);
      return;
    }

    let trips = await d3.csv(
      'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
      (trip) => {
        trip.started_at = new Date(trip.started_at);
        trip.ended_at = new Date(trip.ended_at);
        return trip;
      },
    );

    const departureHist = new Map();
    const arrivalHist = new Map();

    function bumpHist(map, stationId, minute) {
      let h = map.get(stationId);
      if (!h) {
        h = new Uint32Array(1440);
        map.set(stationId, h);
      }
      h[minute]++;
    }

    for (const s of jsonData.data.stations) {
      const id = s.short_name;
      if (!departureHist.has(id)) departureHist.set(id, new Uint32Array(1440));
      if (!arrivalHist.has(id)) arrivalHist.set(id, new Uint32Array(1440));
    }

    for (const trip of trips) {
      bumpHist(departureHist, trip.start_station_id, minutesSinceMidnight(trip.started_at));
      bumpHist(arrivalHist, trip.end_station_id, minutesSinceMidnight(trip.ended_at));
    }

    departurePrefixByStation = new Map();
    arrivalPrefixByStation = new Map();
    for (const [id, hist] of departureHist) {
      departurePrefixByStation.set(id, minuteHistogramToPrefix(hist));
    }
    for (const [id, hist] of arrivalHist) {
      arrivalPrefixByStation.set(id, minuteHistogramToPrefix(hist));
    }

    allDepartures = d3.rollup(
      trips,
      (v) => v.length,
      (d) => d.start_station_id,
    );
    allArrivals = d3.rollup(
      trips,
      (v) => v.length,
      (d) => d.end_station_id,
    );

    let stations = computeStationTraffic(jsonData.data.stations);
    console.log('Stations Array:', stations);

    const maxTrafficAll = d3.max(stations, (d) => d.totalTraffic) ?? 0;
    const radiusScale = d3
      .scaleSqrt()
      .domain([0, Math.max(maxTrafficAll, 1)])
      .range([0, 25]);

    let circles = svg
      .selectAll('circle')
      .data(stations, (d) => d.short_name)
      .join((enter) =>
        enter
          .append('circle')
          .attr('stroke', 'white')
          .attr('stroke-width', 1)
          .attr('opacity', 0.8)
          .call((sel) => sel.append('title')),
      )
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatioForStation);

    circles.select('title').text(tooltipLines);

    function updatePositions() {
      const { clientWidth: w, clientHeight: h } = map.getContainer();
      svg.attr('width', w).attr('height', h);

      circles
        .attr('cx', (d) => getCoords(d).cx)
        .attr('cy', (d) => getCoords(d).cy);
    }

    updatePositions();

    map.on('move', updatePositions);
    map.on('zoom', updatePositions);
    map.on('resize', updatePositions);
    map.on('moveend', updatePositions);

    const timeSlider = document.getElementById('time-slider');
    const selectedTime = document.getElementById('selected-time');
    const anyTimeLabel = document.getElementById('any-time');

    function updateScatterPlot(timeFilter) {
      computeStationTraffic(stations, timeFilter);

      timeFilter === -1
        ? radiusScale.range([0, 25])
        : radiusScale.range([3, 50]);

      circles
        .attr('r', (d) => radiusScale(d.totalTraffic))
        .style('--departure-ratio', departureRatioForStation);

      circles.select('title').text(tooltipLines);
    }

    let pendingTimeFilter = null;
    let scatterRaf = 0;

    function flushScatter() {
      scatterRaf = 0;
      if (pendingTimeFilter === null) return;
      const tf = pendingTimeFilter;
      pendingTimeFilter = null;
      updateScatterPlot(tf);
    }

    function scheduleScatter(timeFilter) {
      pendingTimeFilter = timeFilter;
      if (!scatterRaf) scatterRaf = requestAnimationFrame(flushScatter);
    }

    function updateTimeDisplay() {
      const raw = Number(timeSlider.value);
      const timeFilter = Number.isFinite(raw) ? raw : -1;

      if (timeFilter === -1) {
        selectedTime.textContent = '';
        anyTimeLabel.style.display = 'block';
      } else {
        selectedTime.textContent = formatTime(timeFilter);
        anyTimeLabel.style.display = 'none';
      }

      scheduleScatter(timeFilter);
    }

    timeSlider.addEventListener('input', updateTimeDisplay);
    updateScatterPlot(-1);

    map.resize();
    map.once('idle', () => {
      updatePositions();
    });
  });

  window.addEventListener('resize', () => map.resize());
}

bootstrap().catch(console.error);
