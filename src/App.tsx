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
  inputIndex: number;
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
  legsCount: number;
};

const TRAFFIC_BUFFER = 1.15;
const MAX_STOPS = 8;
const DEFAULT_START = "CV6 4AZ";
const DEFAULT_FINISH = "B37 7SP";
const STORAGE_STOPS = "nuage-route-planner-stops-v2";
const STORAGE_SAVED = "nuage-route-planner-saved-v2";
const STORAGE_START = "nuage-route-planner-start-v2";
const STORAGE_FINISH = "nuage-route-planner-finish-v2";
const STORAGE_TIME = "nuage-route-planner-time-v2";
const STORAGE_CACHE = "nuage-route-planner-geo-cache-v2";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanPostcode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function splitPastedPostcodes(text: string) {
  return [...new Set(text.split(/[\n,;]+/).map(cleanPostcode).filter(Boolean))];
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
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function getTravelColour(minutes: number) {
  if (minutes <= 10) return "#6cc04a";
  if (minutes <= 20) return "#ff9f43";
  return "#ff5e57";
}

function getPinColour(index: number) {
  const colours = [
    "#6cc04a",
    "#4da3ff",
    "#ff9f43",
    "#ff5e57",
    "#9b6dff",
    "#2ed3b7",
    "#f6c445",
    "#ff7aa2",
  ];
  return colours[index % colours.length];
}

function createStopRows(count = 4): StopRow[] {
  return Array.from({ length: count }, () => ({
    id: uid(),
    postcode: "",
    locked: false,
  }));
}

function addMinutes(timeString: string, minutesToAdd: number) {
  const [h, m] = timeString.split(":").map(Number);
  const total = h * 60 + m + minutesToAdd;
  const safe = ((total % 1440) + 1440) % 1440;
  const hours = Math.floor(safe / 60)
    .toString()
    .padStart(2, "0");
  const mins = (safe % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function geocodePostcode(
  postcode: string,
  cache: Record<string, { lat: number; lon: number }>
) {
  const cleaned = cleanPostcode(postcode);
  if (!cleaned) throw new Error("Blank postcode");
  if (cache[cleaned]) return cache[cleaned];

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&limit=1&q=${encodeURIComponent(
    cleaned
  )}`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to geocode ${cleaned}`);
  }

  const data = await res.json();

  if (!data.length) {
    throw new Error(`No result found for ${cleaned}`);
  }

  const point = {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
  };

  cache[cleaned] = point;
  saveJSON(STORAGE_CACHE, cache);
  return point;
}

function nearestNeighbour(
  current: { lat: number; lon: number },
  stops: GeoPoint[],
  anchor?: { lat: number; lon: number } | null
) {
  const remaining = [...stops];
  const output: GeoPoint[] = [];
  let currentPoint = { ...current };

  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;

    remaining.forEach((stop, index) => {
      const firstLeg = haversineMiles(currentPoint, stop);
      const anchorLeg = anchor ? haversineMiles(stop, anchor) * 0.35 : 0;
      const score = firstLeg + anchorLeg;

      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    const chosen = remaining.splice(bestIndex, 1)[0];
    output.push(chosen);
    currentPoint = { lat: chosen.lat, lon: chosen.lon };
  }

  return output;
}

function optimiseWithLockedStops(
  rawStops: GeoPoint[],
  start: { lat: number; lon: number },
  finish: { lat: number; lon: number }
) {
  const ordered: GeoPoint[] = new Array(rawStops.length);
  let currentPoint = start;
  let i = 0;

  while (i < rawStops.length) {
    if (rawStops[i].locked) {
      ordered[i] = rawStops[i];
      currentPoint = { lat: rawStops[i].lat, lon: rawStops[i].lon };
      i += 1;
      continue;
    }

    let j = i;
    while (j < rawStops.length && !rawStops[j].locked) {
      j += 1;
    }

    const block = rawStops.slice(i, j);
    const nextAnchor =
      j < rawStops.length
        ? { lat: rawStops[j].lat, lon: rawStops[j].lon }
        : finish;

    const optimisedBlock = nearestNeighbour(currentPoint, block, nextAnchor);

    optimisedBlock.forEach((stop, index) => {
      ordered[i + index] = stop;
    });

    if (optimisedBlock.length) {
      const last = optimisedBlock[optimisedBlock.length - 1];
      currentPoint = { lat: last.lat, lon: last.lon };
    }

    i = j;
  }

  return ordered;
}

function buildGoogleMapsUrl(
  startPostcode: string,
  finishPostcode: string,
  orderedStops: OrderedStop[]
) {
  const origin = encodeURIComponent(startPostcode);
  const destination = encodeURIComponent(finishPostcode);
  const waypoints = orderedStops.map((s) => encodeURIComponent(s.postcode)).join("|");

  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving&waypoints=${waypoints}`;
}

function FitToRoute({
  points,
}: {
  points: Array<{ lat: number; lon: number }>;
}) {
  const map = useMap();

  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, points]);

  return null;
}

function numberedIcon(number: number, colour: string, locked: boolean) {
  return L.divIcon({
    className: "",
    html: `
      <div style="
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background:${colour};
        color:white;
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
        font-size:13px;
        border:2px solid white;
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
        position:relative;
      ">
        ${number}
        ${
          locked
            ? `<span style="
                position:absolute;
                right:-4px;
                top:-4px;
                background:#0a1b38;
                color:#fff;
                font-size:10px;
                width:14px;
                height:14px;
                border-radius:50%;
                display:flex;
                align-items:center;
                justify-content:center;
                border:1px solid #fff;
              ">🔒</span>`
            : ""
        }
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

export default function App() {
  const [stops, setStops] = useState<StopRow[]>(() =>
    typeof window !== "undefined"
      ? loadJSON(STORAGE_STOPS, createStopRows())
      : createStopRows()
  );
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>(() =>
    typeof window !== "undefined" ? loadJSON(STORAGE_SAVED, []) : []
  );
  const [startMode, setStartMode] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_START) || "manual" : "manual"
  );
  const [finishMode, setFinishMode] = useState<string>(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_FINISH) || "manual" : "manual"
  );
  const [startPostcode, setStartPostcode] = useState(DEFAULT_START);
  const [finishPostcode, setFinishPostcode] = useState(DEFAULT_FINISH);
  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationPostcode, setNewLocationPostcode] = useState("");
  const [pastedPostcodes, setPastedPostcodes] = useState("CV6 4AZ, CV5 6EE, LE10 3JE");
  const [firstJobTime, setFirstJobTime] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_TIME) || "08:00" : "08:00"
  );

  const [orderedStops, setOrderedStops] = useState<OrderedStop[]>([]);
  const [summary, setSummary] = useState<RouteSummary | null>(null);
  const [mapPoints, setMapPoints] = useState<Array<{ lat: number; lon: number; label: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Add your postcodes and click Build route.");
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    saveJSON(STORAGE_STOPS, stops);
  }, [stops]);

  useEffect(() => {
    saveJSON(STORAGE_SAVED, savedLocations);
  }, [savedLocations]);

  useEffect(() => {
    localStorage.setItem(STORAGE_START, startMode);
  }, [startMode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_FINISH, finishMode);
  }, [finishMode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_TIME, firstJobTime);
  }, [firstJobTime]);

  const startResolved = useMemo(() => {
    if (startMode === "manual") return cleanPostcode(startPostcode);
    const saved = savedLocations.find((loc) => loc.id === startMode);
    return saved ? cleanPostcode(saved.postcode) : cleanPostcode(startPostcode);
  }, [startMode, startPostcode, savedLocations]);

  const finishResolved = useMemo(() => {
    if (finishMode === "manual") return cleanPostcode(finishPostcode);
    const saved = savedLocations.find((loc) => loc.id === finishMode);
    return saved ? cleanPostcode(saved.postcode) : cleanPostcode(finishPostcode);
  }, [finishMode, finishPostcode, savedLocations]);

  const filledStopsCount = stops.filter((s) => cleanPostcode(s.postcode)).length;

  const handleStopChange = (id: string, value: string) => {
    setStops((current) =>
      current.map((stop) =>
        stop.id === id ? { ...stop, postcode: value.toUpperCase() } : stop
      )
    );
  };

  const handleLockChange = (id: string) => {
    setStops((current) =>
      current.map((stop) =>
        stop.id === id ? { ...stop, locked: !stop.locked } : stop
      )
    );
  };

  const addStop = () => {
    if (stops.length >= MAX_STOPS) return;
    setStops((current) => [...current, { id: uid(), postcode: "", locked: false }]);
  };

  const removeStop = (id: string) => {
    setStops((current) => current.filter((stop) => stop.id !== id));
  };

  const applyPastedPostcodes = () => {
    const pasted = splitPastedPostcodes(pastedPostcodes).slice(0, MAX_STOPS);
    const rebuilt = pasted.map((postcode) => ({
      id: uid(),
      postcode,
      locked: false,
    }));
    while (rebuilt.length < Math.min(4, MAX_STOPS)) {
      rebuilt.push({ id: uid(), postcode: "", locked: false });
    }
    setStops(rebuilt);
  };

  const saveLocation = () => {
    const name = newLocationName.trim();
    const postcode = cleanPostcode(newLocationPostcode);
    if (!name || !postcode) return;

    setSavedLocations((current) => [
      ...current,
      {
        id: uid(),
        name,
        postcode,
      },
    ]);

    setNewLocationName("");
    setNewLocationPostcode("");
  };

  const clearRoute = () => {
    setOrderedStops([]);
    setSummary(null);
    setMapPoints([]);
    setMessage("Add your postcodes and click Build route.");
  };

  const copyOrder = async () => {
    if (!orderedStops.length) return;
    const text = orderedStops
      .map(
        (stop) =>
          `${stop.orderNumber}. ${stop.postcode} - ${stop.arrivalTime} (${formatDuration(
            stop.travelMinutesFromPrevious
          )})`
      )
      .join("\n");

    await navigator.clipboard.writeText(text);
    setMessage("Suggested order copied to clipboard.");
  };

  const openInGoogleMaps = () => {
    if (!orderedStops.length) return;
    const url = buildGoogleMapsUrl(startResolved, finishResolved, orderedStops);
    window.open(url, "_blank");
  };

  const onDragStart = (id: string) => {
    setDraggedId(id);
  };

  const onDrop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;

    setStops((current) => {
      const fromIndex = current.findIndex((s) => s.id === draggedId);
      const toIndex = current.findIndex((s) => s.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return current;
      const copy = [...current];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return copy;
    });

    setDraggedId(null);
  };

  const buildRoute = async () => {
    try {
      setBusy(true);
      setMessage("Building route...");

      const enteredStops = stops
        .map((stop, index) => ({
          ...stop,
          postcode: cleanPostcode(stop.postcode),
          inputIndex: index,
        }))
        .filter((stop) => stop.postcode);

      if (!startResolved) {
        throw new Error("Please enter a start postcode.");
      }

      if (!finishResolved) {
        throw new Error("Please enter a finish postcode.");
      }

      if (!enteredStops.length) {
        throw new Error("Please add at least one job postcode.");
      }

      const cache = loadJSON<Record<string, { lat: number; lon: number }>>(STORAGE_CACHE, {});

      const uniquePostcodes = Array.from(
        new Set([startResolved, finishResolved, ...enteredStops.map((s) => s.postcode)])
      );

      for (const postcode of uniquePostcodes) {
        await geocodePostcode(postcode, cache);
      }

      const startGeo = { ...cache[startResolved], label: "Start", postcode: startResolved };
      const finishGeo = { ...cache[finishResolved], label: "Finish", postcode: finishResolved };

      const geoStops: GeoPoint[] = enteredStops.map((stop) => ({
        id: stop.id,
        postcode: stop.postcode,
        lat: cache[stop.postcode].lat,
        lon: cache[stop.postcode].lon,
        locked: stop.locked,
        inputIndex: stop.inputIndex,
      }));

      const orderedGeoStops = optimiseWithLockedStops(
        geoStops,
        { lat: startGeo.lat, lon: startGeo.lon },
        { lat: finishGeo.lat, lon: finishGeo.lon }
      );

      let runningTime = firstJobTime;
      let prevPoint = startGeo;
      let totalMiles = 0;
      let totalTravelMinutes = 0;
      let longestDriveMinutes = 0;

      const builtOrderedStops: OrderedStop[] = orderedGeoStops.map((stop, index) => {
        const legMiles = haversineMiles(prevPoint, stop);
        const legMinutes = estimateTravelMinutes(legMiles);
        totalMiles += legMiles;
        totalTravelMinutes += legMinutes;
        longestDriveMinutes = Math.max(longestDriveMinutes, legMinutes);

        runningTime = addMinutes(runningTime, legMinutes);

        const built: OrderedStop = {
          ...stop,
          orderNumber: index + 1,
          arrivalTime: runningTime,
          distanceMilesFromPrevious: Number(legMiles.toFixed(1)),
          travelMinutesFromPrevious: legMinutes,
        };

        prevPoint = stop;
        return built;
      });

      const lastLegMiles = haversineMiles(prevPoint, finishGeo);
      const lastLegMinutes = estimateTravelMinutes(lastLegMiles);
      totalMiles += lastLegMiles;
      totalTravelMinutes += lastLegMinutes;
      longestDriveMinutes = Math.max(longestDriveMinutes, lastLegMinutes);

      const allMapPoints = [
        { lat: startGeo.lat, lon: startGeo.lon, label: "Start" },
        ...builtOrderedStops.map((s) => ({
          lat: s.lat,
          lon: s.lon,
          label: s.postcode,
        })),
        { lat: finishGeo.lat, lon: finishGeo.lon, label: "Finish" },
      ];

      setOrderedStops(builtOrderedStops);
      setSummary({
        totalMiles: Number(totalMiles.toFixed(1)),
        totalTravelMinutes,
        longestDriveMinutes,
        legsCount: builtOrderedStops.length + 1,
      });
      setMapPoints(allMapPoints);
      setMessage("Route built successfully.");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to build route.";
      setMessage(text);
      setOrderedStops([]);
      setSummary(null);
      setMapPoints([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="planner-page">
      <div className="planner-shell">
        <div className="planner-header">
          <h1>Postcode Route Planner</h1>
          <p>
            Office route planning tool with stronger optimisation, drag-and-drop ordering,
            locked stops, saved locations, numbered map pins, and travel times.
          </p>
        </div>

        <div className="planner-grid">
          <div className="planner-left">
            <div className="panel two-up">
              <div className="sub-panel">
                <h3>Start postcode</h3>
                <label>Saved locations</label>
                <select
                  value={startMode}
                  onChange={(e) => setStartMode(e.target.value)}
                >
                  <option value="manual">Manual postcode</option>
                  {savedLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>

                <input
                  value={startMode === "manual" ? startPostcode : startResolved}
                  onChange={(e) => setStartPostcode(e.target.value)}
                  disabled={startMode !== "manual"}
                  placeholder="Enter start postcode"
                />
              </div>

              <div className="sub-panel">
                <h3>Finish postcode</h3>
                <label>Saved locations</label>
                <select
                  value={finishMode}
                  onChange={(e) => setFinishMode(e.target.value)}
                >
                  <option value="manual">Manual postcode</option>
                  {savedLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>

                <input
                  value={finishMode === "manual" ? finishPostcode : finishResolved}
                  onChange={(e) => setFinishPostcode(e.target.value)}
                  disabled={finishMode !== "manual"}
                  placeholder="Enter finish postcode"
                />
              </div>
            </div>

            <div className="panel">
              <h3>Saved locations</h3>
              <div className="inline-form">
                <input
                  placeholder="Name"
                  value={newLocationName}
                  onChange={(e) => setNewLocationName(e.target.value)}
                />
                <input
                  placeholder="Postcode"
                  value={newLocationPostcode}
                  onChange={(e) => setNewLocationPostcode(e.target.value.toUpperCase())}
                />
                <button className="btn-primary" onClick={saveLocation}>
                  Save postcode
                </button>
              </div>
            </div>

            <div className="panel paste-time-grid">
              <div>
                <h3>Quick paste postcodes</h3>
                <textarea
                  value={pastedPostcodes}
                  onChange={(e) => setPastedPostcodes(e.target.value)}
                  rows={4}
                />
                <button className="btn-primary" onClick={applyPastedPostcodes}>
                  Apply pasted postcodes
                </button>
              </div>

              <div className="time-box">
                <h3>First job time</h3>
                <input
                  type="time"
                  value={firstJobTime}
                  onChange={(e) => setFirstJobTime(e.target.value)}
                />
              </div>
            </div>

            <div className="jobs-header">
              <div>
                <h2>Job postcodes</h2>
                <p>
                  Drag and drop stops to reorder them manually. Lock a stop if it must
                  stay in that position.
                </p>
              </div>
            </div>

            <div className="stops-list">
              {stops.map((stop, index) => (
                <div
                  key={stop.id}
                  className="stop-row"
                  draggable
                  onDragStart={() => onDragStart(stop.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(stop.id)}
                >
                  <div className="drag-handle">⋮⋮</div>
                  <div className="stop-label">Stop {index + 1}</div>
                  <input
                    value={stop.postcode}
                    onChange={(e) => handleStopChange(stop.id, e.target.value)}
                    placeholder="Enter postcode"
                  />
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={stop.locked}
                      onChange={() => handleLockChange(stop.id)}
                    />
                    Lock
                  </label>
                  <button className="btn-secondary" onClick={() => removeStop(stop.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="action-row">
              <button
                className="btn-secondary"
                onClick={addStop}
                disabled={stops.length >= MAX_STOPS}
              >
                Add stop
              </button>
              <button className="btn-primary" onClick={buildRoute} disabled={busy}>
                {busy ? "Building..." : "Build route"}
              </button>
              <button className="btn-secondary" onClick={buildRoute} disabled={busy}>
                Re-optimise route
              </button>
              <button className="btn-secondary" onClick={copyOrder} disabled={!orderedStops.length}>
                Copy order
              </button>
              <button className="btn-secondary" onClick={openInGoogleMaps} disabled={!orderedStops.length}>
                Open in Google Maps
              </button>
              <button className="btn-secondary" onClick={clearRoute}>
                Clear
              </button>
            </div>

            <div className="route-note">
              {filledStopsCount} filled job postcodes · Travel times include a 15% planning buffer.
            </div>
          </div>

          <div className="planner-right">
            <div className="panel">
              <h2>Route summary</h2>
              {summary ? (
                <div className="summary-grid">
                  <div className="summary-card">
                    <span>Stops</span>
                    <strong>{orderedStops.length + 1}</strong>
                  </div>
                  <div className="summary-card">
                    <span>Total travel time</span>
                    <strong>{formatDuration(summary.totalTravelMinutes)}</strong>
                  </div>
                  <div className="summary-card">
                    <span>Total miles</span>
                    <strong>{summary.totalMiles}</strong>
                  </div>
                  <div className="summary-card">
                    <span>Longest drive</span>
                    <strong>{formatDuration(summary.longestDriveMinutes)}</strong>
                  </div>
                </div>
              ) : (
                <p>{message}</p>
              )}
            </div>

            <div className="panel">
              <h2>Map preview</h2>
              <p>Numbered pins match the job order. Locked stops show a lock.</p>

              <div className="map-wrap">
                <MapContainer
                  center={[52.4068, -1.5197]}
                  zoom={10}
                  style={{ height: "100%", width: "100%" }}
                >
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />

                  {mapPoints.length > 0 && (
                    <>
                      <FitToRoute points={mapPoints} />
                      <Polyline
                        positions={mapPoints.map((p) => [p.lat, p.lon])}
                        pathOptions={{ color: "#6cc04a", weight: 4, opacity: 0.8 }}
                      />
                    </>
                  )}

                  {orderedStops.map((stop, index) => (
                    <Marker
                      key={stop.id}
                      position={[stop.lat, stop.lon]}
                      icon={numberedIcon(index + 1, getPinColour(index), stop.locked)}
                    >
                      <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                        <div>
                          <strong>
                            {index + 1}. {stop.postcode}
                          </strong>
                          <br />
                          Arrival: {stop.arrivalTime}
                          <br />
                          Travel: {formatDuration(stop.travelMinutesFromPrevious)}
                        </div>
                      </Tooltip>
                    </Marker>
                  ))}
                </MapContainer>
              </div>
            </div>

            <div className="panel">
              <h2>Suggested order</h2>
              {orderedStops.length ? (
                <div className="suggested-list">
                  {orderedStops.map((stop) => (
                    <div key={stop.id} className="suggested-item">
                      <div className="travel-pill" style={{ color: getTravelColour(stop.travelMinutesFromPrevious) }}>
                        Travel time {formatDuration(stop.travelMinutesFromPrevious)}
                      </div>
                      <div className="suggested-main">
                        <div className="order-badge">{stop.orderNumber}</div>
                        <div>
                          <div className="suggested-postcode">{stop.postcode}</div>
                          <div className="suggested-meta">
                            Arrive {stop.arrivalTime} · {stop.distanceMilesFromPrevious} miles
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>Add your postcodes and click Build route.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
