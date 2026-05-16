import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

const TOKEN_PLACEHOLDER = 'YOUR_MAPBOX_PUBLIC_TOKEN';

async function resolveMapboxAccessToken() {
  try {
    const mod = await import('./mapbox-token.local.js');
    const token = typeof mod.default === 'string' ? mod.default.trim() : '';
    if (token && token !== TOKEN_PLACEHOLDER) return token;
  } catch {
    /* e.g. no local overrides on GitHub Pages */
  }

  try {
    const mod = await import('./mapbox-token.defaults.js');
    const token = typeof mod.default === 'string' ? mod.default.trim() : '';
    return token;
  } catch {
    return '';
  }
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

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  }

  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

async function bootstrap() {
  const accessToken = await resolveMapboxAccessToken();

  mapboxgl.accessToken = accessToken;

  const missingToken =
    !accessToken || accessToken === TOKEN_PLACEHOLDER;

  if (missingToken) {
    console.warn(
      'Mapbox token missing or placeholder. Copy mapbox-token.js.example → mapbox-token.local.js with your pk… token.',
    );
    const bar = document.createElement('div');
    bar.role = 'alert';
    bar.textContent =
      'Missing Mapbox public token — copy mapbox-token.js.example to mapbox-token.local.js and paste your pk… token.';
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
    container: 'map',
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

  let departuresByMinute = Array.from({ length: 1440 }, () => []);
  let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

  let allDepartures;
  let allArrivals;

  function computeStationTraffic(stations, timeFilter = -1) {
    let departures;
    let arrivals;

    if (timeFilter === -1 && allDepartures && allArrivals) {
      departures = allDepartures;
      arrivals = allArrivals;
    } else {
      departures = d3.rollup(
        filterByMinute(departuresByMinute, timeFilter),
        (v) => v.length,
        (d) => d.start_station_id,
      );

      arrivals = d3.rollup(
        filterByMinute(arrivalsByMinute, timeFilter),
        (v) => v.length,
        (d) => d.end_station_id,
      );
    }

    return stations.map((station) => {
      let id = station.short_name;
      station.arrivals = arrivals.get(id) ?? 0;
      station.departures = departures.get(id) ?? 0;
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

        let startedMinutes = minutesSinceMidnight(trip.started_at);
        departuresByMinute[startedMinutes].push(trip);

        let endedMinutes = minutesSinceMidnight(trip.ended_at);
        arrivalsByMinute[endedMinutes].push(trip);

        return trip;
      },
    );

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
