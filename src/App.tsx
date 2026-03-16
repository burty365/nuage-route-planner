import React, { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

type StopRow = {
  id: string;
  postcode: string;
  locked: boolean;
};

type SavedLocation = {
  id: string;
  name: string;
  postcode: string;
};

type GeoPoint = {
  id: string;
  postcode: string;
  lat: number;
  lon: number;
  locked: boolean;
};

type OrderedStop = GeoPoint & {
  orderNumber: number;
  arrivalTime: string;
  travelMinutesFromPrevious: number;
  distanceMilesFromPrevious: number;
};

type RouteSummary = {
  totalMiles: number;
  totalTravelMinutes: number;
  longestDriveMinutes: number;
};

const TRAFFIC_BUFFER = 1.15;
const MAX_STOPS = 8;

/* DEFAULTS NOW BLANK */

const DEFAULT_START = "";
const DEFAULT_FINISH = "";

/* STORAGE RESET */

const STORAGE_STOPS = "nuage-route-planner-stops-v3";
const STORAGE_SAVED = "nuage-route-planner-saved-v3";
const STORAGE_START = "nuage-route-planner-start-v3";
const STORAGE_FINISH = "nuage-route-planner-finish-v3";
const STORAGE_TIME = "nuage-route-planner-time-v3";
const STORAGE_CACHE = "nuage-route-planner-geo-cache-v3";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanPostcode(value: string) {
  return value.trim().toUpperCase();
}

function createStopRows(count = 6): StopRow[] {
  return Array.from({ length: count }, () => ({
    id: uid(),
    postcode: "",
    locked: false,
  }));
}

function haversineMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
) {
  const R = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function estimateTravelMinutes(miles: number) {
  const averageMph = 28;
  return Math.max(3, Math.round((miles / averageMph) * 60 * TRAFFIC_BUFFER));
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function addMinutes(timeString: string, minutesToAdd: number) {
  const [h, m] = timeString.split(":").map(Number);
  const total = h * 60 + m + minutesToAdd;

  const hours = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");

  const mins = (total % 60).toString().padStart(2, "0");

  return `${hours}:${mins}`;
}

function FitToRoute({ points }: any) {
  const map = useMap();

  useEffect(() => {
    if (!points.length) return;

    const bounds = L.latLngBounds(
      points.map((p: any) => [p.lat, p.lon])
    );

    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, points]);

  return null;
}

export default function App() {
  const [stops, setStops] = useState<StopRow[]>(createStopRows());
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [startPostcode, setStartPostcode] = useState(DEFAULT_START);
  const [finishPostcode, setFinishPostcode] = useState(DEFAULT_FINISH);
  const [pastedPostcodes, setPastedPostcodes] = useState("");
  const [firstJobTime, setFirstJobTime] = useState("08:00");

  const [orderedStops, setOrderedStops] = useState<OrderedStop[]>([]);
  const [summary, setSummary] = useState<RouteSummary | null>(null);
  const [mapPoints, setMapPoints] = useState<any[]>([]);

  const buildRoute = async () => {
    const enteredStops = stops
      .map((s) => cleanPostcode(s.postcode))
      .filter(Boolean);

    if (!startPostcode || !finishPostcode || !enteredStops.length) return;

    const cache: any = {};

    const geocode = async (postcode: string) => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${postcode}`;

      const res = await fetch(url);
      const data = await res.json();

      return {
        lat: Number(data[0].lat),
        lon: Number(data[0].lon),
      };
    };

    const startGeo = await geocode(startPostcode);
    const finishGeo = await geocode(finishPostcode);

    const geoStops = await Promise.all(
      enteredStops.map(async (pc) => ({
        postcode: pc,
        ...(await geocode(pc)),
      }))
    );

    let prev = startGeo;
    let runningTime = firstJobTime;

    let totalMiles = 0;
    let totalMinutes = 0;
    let longest = 0;

    const ordered: OrderedStop[] = geoStops.map((s, i) => {
      const miles = haversineMiles(prev, s);
      const mins = estimateTravelMinutes(miles);

      runningTime = addMinutes(runningTime, mins);

      totalMiles += miles;
      totalMinutes += mins;
      longest = Math.max(longest, mins);

      prev = s;

      return {
        ...s,
        id: uid(),
        locked: false,
        orderNumber: i + 1,
        arrivalTime: runningTime,
        travelMinutesFromPrevious: mins,
        distanceMilesFromPrevious: Number(miles.toFixed(1)),
      };
    });

    setOrderedStops(ordered);

    setSummary({
      totalMiles: Number(totalMiles.toFixed(1)),
      totalTravelMinutes: totalMinutes,
      longestDriveMinutes: longest,
    });

    setMapPoints([
      { ...startGeo, label: "Start" },
      ...ordered,
      { ...finishGeo, label: "Finish" },
    ]);
  };

  return (
    <div className="planner-page">
      <div className="planner-shell">

        <div className="planner-header">
          <h1>Postcode Route Planner</h1>
        </div>

        <div className="planner-grid">

          <div className="planner-left">

            <div className="panel two-up">

              <div className="sub-panel">
                <h3>Start postcode</h3>

                <input
                  value={startPostcode}
                  onChange={(e) => setStartPostcode(e.target.value)}
                />
              </div>

              <div className="sub-panel">
                <h3>Finish postcode</h3>

                <input
                  value={finishPostcode}
                  onChange={(e) => setFinishPostcode(e.target.value)}
                />
              </div>

            </div>

            <div className="panel">

              <h3>Quick paste postcodes</h3>

              <textarea
                value={pastedPostcodes}
                onChange={(e) => setPastedPostcodes(e.target.value)}
              />

            </div>

            <div className="stops-list">

              {stops.map((s, i) => (
                <div key={s.id} className="stop-row">

                  <div className="stop-label">
                    Stop {i + 1}
                  </div>

                  <input
                    value={s.postcode}
                    onChange={(e) =>
                      setStops((st) =>
                        st.map((x) =>
                          x.id === s.id
                            ? { ...x, postcode: e.target.value }
                            : x
                        )
                      )
                    }
                  />

                </div>
              ))}

            </div>

            <button className="btn-primary" onClick={buildRoute}>
              Build route
            </button>

          </div>

          <div className="planner-right">

            <div className="panel">
              <h2>Route summary</h2>

              {summary && (
                <div>

                  <p>Total miles: {summary.totalMiles}</p>
                  <p>Total travel: {formatDuration(summary.totalTravelMinutes)}</p>
                  <p>Longest drive: {formatDuration(summary.longestDriveMinutes)}</p>

                </div>
              )}
            </div>

            <div className="panel">

              <h2>Map preview</h2>

              <div className="map-wrap">

                <MapContainer
                  center={[52.4068, -1.5197]}
                  zoom={10}
                  style={{ height: "100%", width: "100%" }}
                >

                  <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />

                  {mapPoints.length > 0 && (
                    <>
                      <FitToRoute points={mapPoints} />

                      <Polyline
                        positions={mapPoints.map((p) => [p.lat, p.lon])}
                      />
                    </>
                  )}

                  {orderedStops.map((s, i) => (
                    <Marker
                      key={s.id}
                      position={[s.lat, s.lon]}
                    >
                      <Tooltip>

                        {i + 1}. {s.postcode}

                      </Tooltip>
                    </Marker>
                  ))}

                </MapContainer>

              </div>

            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
