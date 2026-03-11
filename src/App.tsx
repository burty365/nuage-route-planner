import React, { useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Tooltip,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type StopRow = {
  postcode: string;
  locked: boolean;
};

type SavedLocation = {
  name: string;
  postcode: string;
};

type GeoStop = {
  postcode: string;
  lat: number;
  lon: number;
  label: string;
  locked?: boolean;
  rowIndex?: number;
};

type RouteLeg = {
  from: string;
  to: string;
  distanceMiles: number;
  travelMinutes: number;
};

const TRAFFIC_BUFFER = 1.15;
const MAX_STOPS = 8;

function cleanPostcode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function splitPastedPostcodes(text: string) {
  return [
    ...new Set(
      text
        .split(/\n|,|;/)
        .map(cleanPostcode)
        .filter(Boolean)
    ),
  ];
}

function haversineMiles(a: GeoStop, b: GeoStop) {
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

function formatDuration(minutes: number) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;

  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function getTravelColour(minutes: number) {
  if (minutes <= 10) return "#16a34a";
  if (minutes <= 20) return "#f97316";
  return "#dc2626";
}

function getPinColour(index: number) {
  const colours = [
    "#2563eb",
    "#16a34a",
    "#f97316",
    "#dc2626",
    "#7c3aed",
    "#0891b2",
    "#ca8a04",
    "#be185d",
  ];

  return colours[index % colours.length];
}

function createEmptyRows(count = 4): StopRow[] {
  return Array.from({ length: count }, () => ({ postcode: "", locked: false }));
}

function shuffleArray<T>(items: T[], seed: number) {
  const copy = [...items];
  let randomSeed = seed;

  function nextRandom() {
    randomSeed = (randomSeed * 9301 + 49297) % 233280;
    return randomSeed / 233280;
  }

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function routeCost(
  route: GeoStop[],
  startStop: GeoStop | null,
  finishStop: GeoStop | null
) {
  let cost = 0;
  if (!route.length) return cost;

  if (startStop) {
    cost += haversineMiles(startStop, route[0]);
  }

  for (let i = 1; i < route.length; i += 1) {
    cost += haversineMiles(route[i - 1], route[i]);
  }

  if (finishStop) {
    cost += haversineMiles(route[route.length - 1], finishStop);
  }

  return cost;
}

function twoOptImprove(
  route: GeoStop[],
  startStop: GeoStop | null,
  finishStop: GeoStop | null
) {
  if (route.length < 4) return route;

  const working = [...route];
  const lockedSet = new Set(
    working
      .filter((stop) => stop.locked && typeof stop.rowIndex === "number")
      .map((stop) => stop.rowIndex as number)
  );

  let improved = true;
  let bestCost = routeCost(working, startStop, finishStop);

  while (improved) {
    improved = false;

    for (let i = 0; i < working.length - 1; i += 1) {
      for (let k = i + 1; k < working.length; k += 1) {
        const affectedLocked = Array.from(
          { length: k - i + 1 },
          (_, offset) => i + offset
        ).some((index) => lockedSet.has(index));

        if (affectedLocked) continue;

        const candidate = [
          ...working.slice(0, i),
          ...working.slice(i, k + 1).reverse(),
          ...working.slice(k + 1),
        ];

        const candidateCost = routeCost(candidate, startStop, finishStop);
        if (candidateCost + 0.001 < bestCost) {
          bestCost = candidateCost;
          working.splice(0, working.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  return working;
}

async function geocodePostcode(postcode: string): Promise<GeoStop> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=gb&limit=1&q=${encodeURIComponent(
    postcode
  )}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Could not look up ${postcode}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Postcode not found: ${postcode}`);
  }

  return {
    postcode,
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    label: data[0].display_name,
  };
}

async function getDriveLeg(a: GeoStop, b: GeoStop): Promise<RouteLeg> {
  const fallbackMiles = haversineMiles(a, b);
  const fallbackMinutes = fallbackMiles * 3.2 * TRAFFIC_BUFFER;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const res = await fetch(url);

    if (!res.ok) {
      return {
        from: a.postcode,
        to: b.postcode,
        distanceMiles: fallbackMiles,
        travelMinutes: fallbackMinutes,
      };
    }

    const data = await res.json();
    const firstRoute = data?.routes?.[0];

    if (!firstRoute) {
      return {
        from: a.postcode,
        to: b.postcode,
        distanceMiles: fallbackMiles,
        travelMinutes: fallbackMinutes,
      };
    }

    return {
      from: a.postcode,
      to: b.postcode,
      distanceMiles: firstRoute.distance / 1609.344,
      travelMinutes: (firstRoute.duration / 60) * TRAFFIC_BUFFER,
    };
  } catch {
    return {
      from: a.postcode,
      to: b.postcode,
      distanceMiles: fallbackMiles,
      travelMinutes: fallbackMinutes,
    };
  }
}

function buildGreedyOrder(
  jobs: GeoStop[],
  startStop: GeoStop | null,
  finishStop: GeoStop | null,
  seed = 1
) {
  if (!jobs.length) return [] as GeoStop[];

  const orderedJobs = new Array(jobs.length).fill(null) as (GeoStop | null)[];
  const used = new Set<string>();

  jobs.forEach((job) => {
    if (
      job.locked &&
      typeof job.rowIndex === "number" &&
      job.rowIndex >= 0 &&
      job.rowIndex < jobs.length
    ) {
      orderedJobs[job.rowIndex] = job;
      used.add(job.postcode);
    }
  });

  let current = startStop || null;

  for (let position = 0; position < jobs.length; position += 1) {
    if (orderedJobs[position]) {
      current = orderedJobs[position];
      continue;
    }

    let remaining = jobs.filter((job) => !used.has(job.postcode));
    if (!remaining.length) break;

    remaining = shuffleArray(remaining, seed + position);

    let best = remaining[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of remaining) {
      const fromDistance = current ? haversineMiles(current, candidate) : 0;
      const toFinishDistance = finishStop
        ? haversineMiles(candidate, finishStop) * 0.35
        : 0;
      const score = fromDistance + toFinishDistance;

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    orderedJobs[position] = best;
    used.add(best.postcode);
    current = best;
  }

  return orderedJobs.filter(Boolean) as GeoStop[];
}

function buildBestJobOrder(
  jobs: GeoStop[],
  startStop: GeoStop | null,
  finishStop: GeoStop | null,
  seed = 1
) {
  if (!jobs.length) return [] as GeoStop[];

  let bestRoute = buildGreedyOrder(jobs, startStop, finishStop, seed);
  bestRoute = twoOptImprove(bestRoute, startStop, finishStop);
  let bestCost = routeCost(bestRoute, startStop, finishStop);

  for (let attempt = 1; attempt < 12; attempt += 1) {
    const candidateSeed = seed + attempt * 17;
    let candidate = buildGreedyOrder(
      jobs,
      startStop,
      finishStop,
      candidateSeed
    );
    candidate = twoOptImprove(candidate, startStop, finishStop);
    const candidateCost = routeCost(candidate, startStop, finishStop);

    if (candidateCost < bestCost) {
      bestRoute = candidate;
      bestCost = candidateCost;
    }
  }

  return bestRoute;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: 12,
        background: "#f8fafc",
      }}
    >
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  );
}

function makeNumberIcon(number: number, locked = false, specialLabel?: string) {
  const background = specialLabel
    ? "#111827"
    : locked
    ? "#f59e0b"
    : getPinColour(number - 1);
  const label = specialLabel || String(number);

  return L.divIcon({
    className: "",
    html: `<div style="
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: ${background};
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(15,23,42,0.25);
    ">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function RouteMapPreview({
  route,
  startStop,
}: {
  route: GeoStop[];
  startStop: GeoStop | null;
}) {
  const linePositions = route.map(
    (stop) => [stop.lat, stop.lon] as [number, number]
  );
  const allPoints = [
    ...(startStop ? [[startStop.lat, startStop.lon] as [number, number]] : []),
    ...linePositions,
  ];

  if (!route.length) {
    return (
      <p style={{ color: "#64748b" }}>Build a route to see the map preview.</p>
    );
  }

  const center = allPoints[Math.floor(allPoints.length / 2)];

  return (
    <div>
      <div style={{ marginBottom: 10, color: "#64748b", fontSize: 13 }}>
        Numbered pins match the job order. Locked stops show a lock.
      </div>
      <div
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <MapContainer
          center={center}
          zoom={10}
          style={{ height: 320, width: "100%" }}
          scrollWheelZoom={false}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {startStop ? (
            <Marker
              position={[startStop.lat, startStop.lon]}
              icon={makeNumberIcon(0, false, "S")}
            >
              <Tooltip
                direction="top"
                offset={[0, -12]}
                opacity={1}
                permanent={false}
              >
                Start: {startStop.postcode}
              </Tooltip>
            </Marker>
          ) : null}

          <Polyline
            positions={allPoints}
            pathOptions={{ color: "#475569", weight: 4, dashArray: "6 8" }}
          />

          {route.map((stop, index) => (
            <Marker
              key={`${stop.postcode}-${index}`}
              position={[stop.lat, stop.lon]}
              icon={makeNumberIcon(index + 1, !!stop.locked)}
            >
              <Tooltip
                direction="top"
                offset={[0, -12]}
                opacity={1}
                permanent={false}
              >
                {stop.locked ? "🔒 " : ""}
                {index + 1}. {stop.postcode}
              </Tooltip>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

export default function App() {
  const [rows, setRows] = useState<StopRow[]>(createEmptyRows());
  const [pasteInput, setPasteInput] = useState("");

  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([
    { name: "Office", postcode: "CV6 4AZ" },
  ]);

  const [selectedStart, setSelectedStart] = useState("");
  const [manualStartPostcode, setManualStartPostcode] = useState("");

  const [selectedFinish, setSelectedFinish] = useState("");
  const [manualFinishPostcode, setManualFinishPostcode] = useState("");

  const [newSavedName, setNewSavedName] = useState("");
  const [newSavedPostcode, setNewSavedPostcode] = useState("");

  const [dayStartTime, setDayStartTime] = useState("08:00");

  const [route, setRoute] = useState<GeoStop[]>([]);
  const [mapStartStop, setMapStartStop] = useState<GeoStop | null>(null);
  const [legs, setLegs] = useState<RouteLeg[]>([]);
  const [totalMiles, setTotalMiles] = useState<number | null>(null);
  const [totalTravelMinutes, setTotalTravelMinutes] = useState<number | null>(
    null
  );
  const [optimiseSeed, setOptimiseSeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const currentStartPostcode = selectedStart
    ? savedLocations.find((s) => s.name === selectedStart)?.postcode || ""
    : cleanPostcode(manualStartPostcode);

  const currentFinishPostcode = selectedFinish
    ? savedLocations.find((s) => s.name === selectedFinish)?.postcode || ""
    : cleanPostcode(manualFinishPostcode);

  const filledRows = useMemo(() => {
    return rows.filter((row) => cleanPostcode(row.postcode)).length;
  }, [rows]);

  const longestLegMinutes = useMemo(() => {
    if (!legs.length) return 0;
    return Math.max(...legs.map((leg) => leg.travelMinutes));
  }, [legs]);

  const routeSummary = useMemo(() => {
    const travel = totalTravelMinutes || 0;
    return {
      stops: route.length,
      totalTravel: travel,
      longestLeg: longestLegMinutes,
    };
  }, [route.length, totalTravelMinutes, longestLegMinutes]);

  function updateRow(
    index: number,
    key: keyof StopRow,
    value: string | boolean
  ) {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [key]: value } : row))
    );
  }

  function moveRow(fromIndex: number, toIndex: number) {
    setRows((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function addRow() {
    if (rows.length >= MAX_STOPS) return;
    setRows((prev) => [...prev, { postcode: "", locked: false }]);
  }

  function removeRow(index: number) {
    if (rows.length <= 2) return;
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function applyPastedPostcodes() {
    const parsed = splitPastedPostcodes(pasteInput).slice(0, MAX_STOPS);
    if (!parsed.length) return;

    const nextRows = parsed.map((postcode) => ({
      postcode,
      locked: false,
    }));

    while (nextRows.length < 4) {
      nextRows.push({ postcode: "", locked: false });
    }

    setRows(nextRows);
    setPasteInput("");
  }

  function savePostcode() {
    const name = newSavedName.trim();
    const postcode = cleanPostcode(newSavedPostcode);

    if (!name || !postcode) return;

    setSavedLocations((prev) => {
      const withoutSame = prev.filter(
        (item) => item.name.toLowerCase() !== name.toLowerCase()
      );
      return [...withoutSame, { name, postcode }];
    });

    setNewSavedName("");
    setNewSavedPostcode("");
  }

  async function runOptimiser(seed: number) {
    setLoading(true);
    setError("");

    try {
      const cleanedRows = rows
        .map((row, index) => ({
          rowIndex: index,
          postcode: cleanPostcode(row.postcode),
          locked: row.locked,
        }))
        .filter((row) => row.postcode);

      const uniqueRows = cleanedRows.filter(
        (row, index, arr) =>
          arr.findIndex((x) => x.postcode === row.postcode) === index
      );

      if (uniqueRows.length < 2) {
        throw new Error("Add at least 2 job postcodes.");
      }

      if (uniqueRows.length > MAX_STOPS) {
        throw new Error(`Please keep job postcodes to ${MAX_STOPS} or fewer.`);
      }

      const lookups = [
        ...new Set(
          [
            currentStartPostcode,
            currentFinishPostcode,
            ...uniqueRows.map((row) => row.postcode),
          ].filter(Boolean)
        ),
      ];

      const geocoded = await Promise.all(
        lookups.map((pc) => geocodePostcode(pc))
      );
      const byPostcode = new Map(geocoded.map((item) => [item.postcode, item]));

      const startStop = currentStartPostcode
        ? byPostcode.get(currentStartPostcode) || null
        : null;

      const finishStop = currentFinishPostcode
        ? byPostcode.get(currentFinishPostcode) || null
        : null;

      const jobs: GeoStop[] = uniqueRows
        .map((row, index) => {
          const base = byPostcode.get(row.postcode);
          if (!base) return null;

          return {
            ...base,
            locked: row.locked,
            rowIndex: index,
          };
        })
        .filter(Boolean) as GeoStop[];

      const jobsWithoutStartFinish = jobs.filter(
        (job) =>
          job.postcode !== currentStartPostcode &&
          job.postcode !== currentFinishPostcode
      );

      const orderedJobs = buildBestJobOrder(
        jobsWithoutStartFinish,
        startStop,
        finishStop,
        seed
      );

      const finalRoute = [...orderedJobs, ...(finishStop ? [finishStop] : [])];

      const routeStart = finalRoute[0];
      const computedLegs: RouteLeg[] = [];

      if (routeStart && startStop) {
        computedLegs.push(await getDriveLeg(startStop, routeStart));
      }

      for (let i = 1; i < finalRoute.length; i += 1) {
        const leg = await getDriveLeg(finalRoute[i - 1], finalRoute[i]);
        computedLegs.push(leg);
      }

      const miles = computedLegs.reduce(
        (sum, leg) => sum + leg.distanceMiles,
        0
      );
      const minutes = computedLegs.reduce(
        (sum, leg) => sum + leg.travelMinutes,
        0
      );

      setRoute(finalRoute);
      setMapStartStop(startStop);
      setLegs(computedLegs);
      setTotalMiles(miles);
      setTotalTravelMinutes(minutes);
      setOptimiseSeed(seed);
    } catch (err: any) {
      setRoute([]);
      setMapStartStop(null);
      setLegs([]);
      setTotalMiles(null);
      setTotalTravelMinutes(null);
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function buildRoute() {
    runOptimiser(1);
  }

  function reOptimiseRoute() {
    runOptimiser(optimiseSeed + 7);
  }

  async function copyOrder() {
    if (!route.length) return;
    const lines = route.map((stop, index) => `${index + 1}. ${stop.postcode}`);
    await navigator.clipboard.writeText(lines.join("\n"));
  }

  function clearAll() {
    setRows(createEmptyRows());
    setPasteInput("");
    setSelectedStart("");
    setSelectedFinish("");
    setManualStartPostcode("");
    setManualFinishPostcode("");
    setNewSavedName("");
    setNewSavedPostcode("");
    setDayStartTime("08:00");
    setRoute([]);
    setMapStartStop(null);
    setLegs([]);
    setTotalMiles(null);
    setTotalTravelMinutes(null);
    setError("");
    setDragIndex(null);
  }

  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        padding: 24,
        maxWidth: 1280,
        margin: "0 auto",
        color: "#111827",
        background: "#f8fafc",
        minHeight: "100vh",
      }}
    >
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ marginBottom: 8 }}>Postcode Route Planner</h1>
        <p style={{ marginTop: 0, color: "#64748b" }}>
          Office route planning tool with stronger optimisation, drag-and-drop
          ordering, locked stops, saved locations, numbered map pins, and travel
          times.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 24,
          gridTemplateColumns: "1.25fr 0.95fr",
          alignItems: "start",
        }}
      >
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 18,
            padding: 20,
            boxShadow: "0 6px 20px rgba(15,23,42,0.04)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 14,
                background: "#f8fafc",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Start postcode</h3>
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontSize: 13,
                  color: "#64748b",
                }}
              >
                Saved locations
              </label>
              <select
                value={selectedStart}
                onChange={(e) => setSelectedStart(e.target.value)}
                style={{ width: "100%", padding: 10, marginBottom: 10 }}
              >
                <option value="">Manual postcode</option>
                {savedLocations.map((item) => (
                  <option key={`start-${item.name}`} value={item.name}>
                    {item.name} - {item.postcode}
                  </option>
                ))}
              </select>

              {!selectedStart && (
                <input
                  value={manualStartPostcode}
                  onChange={(e) => setManualStartPostcode(e.target.value)}
                  placeholder="CV6 4AZ"
                  style={{
                    width: "100%",
                    padding: 10,
                    boxSizing: "border-box",
                  }}
                />
              )}
            </div>

            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 14,
                background: "#f8fafc",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>
                Finish postcode
              </h3>
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontSize: 13,
                  color: "#64748b",
                }}
              >
                Saved locations
              </label>
              <select
                value={selectedFinish}
                onChange={(e) => setSelectedFinish(e.target.value)}
                style={{ width: "100%", padding: 10, marginBottom: 10 }}
              >
                <option value="">Manual postcode</option>
                {savedLocations.map((item) => (
                  <option key={`finish-${item.name}`} value={item.name}>
                    {item.name} - {item.postcode}
                  </option>
                ))}
              </select>

              {!selectedFinish && (
                <input
                  value={manualFinishPostcode}
                  onChange={(e) => setManualFinishPostcode(e.target.value)}
                  placeholder="LE10 3JE"
                  style={{
                    width: "100%",
                    padding: 10,
                    boxSizing: "border-box",
                  }}
                />
              )}
            </div>
          </div>

          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: 14,
              padding: 14,
              marginBottom: 20,
              background: "#f8fafc",
            }}
          >
            <div style={{ marginBottom: 10, fontWeight: 700 }}>
              Saved locations
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr auto",
                gap: 8,
              }}
            >
              <input
                value={newSavedName}
                onChange={(e) => setNewSavedName(e.target.value)}
                placeholder="Name"
                style={{ padding: 10 }}
              />
              <input
                value={newSavedPostcode}
                onChange={(e) => setNewSavedPostcode(e.target.value)}
                placeholder="Postcode"
                style={{ padding: 10 }}
              />
              <button onClick={savePostcode} style={{ padding: "10px 14px" }}>
                Save postcode
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 180px",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 14,
                background: "#f8fafc",
              }}
            >
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontWeight: 700,
                }}
              >
                Quick paste postcodes
              </label>
              <textarea
                value={pasteInput}
                onChange={(e) => setPasteInput(e.target.value)}
                placeholder={"CV6 4AZ, CV5 6EE, LE10 3JE"}
                rows={3}
                style={{ width: "100%", padding: 10, boxSizing: "border-box" }}
              />
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={applyPastedPostcodes}
                  style={{ padding: "10px 14px" }}
                >
                  Apply pasted postcodes
                </button>
              </div>
            </div>

            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 14,
                background: "#f8fafc",
              }}
            >
              <label
                style={{
                  display: "block",
                  marginBottom: 6,
                  fontWeight: 700,
                }}
              >
                First job time
              </label>
              <input
                type="time"
                value={dayStartTime}
                onChange={(e) => setDayStartTime(e.target.value)}
                style={{ width: "100%", padding: 10, boxSizing: "border-box" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <h3 style={{ marginBottom: 6 }}>Job postcodes</h3>
            <p style={{ marginTop: 0, color: "#64748b", fontSize: 14 }}>
              Drag and drop stops to reorder them manually. Lock a stop if it
              must stay in that position.
            </p>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {rows.map((row, index) => (
              <div
                key={index}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex === null || dragIndex === index) return;
                  moveRow(dragIndex, index);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "44px 72px 1fr 92px 92px",
                  gap: 10,
                  alignItems: "center",
                  border: row.locked
                    ? "2px solid #f59e0b"
                    : dragIndex === index
                    ? "2px solid #94a3b8"
                    : "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: 10,
                  background: row.locked
                    ? "#fef3c7"
                    : dragIndex === index
                    ? "#f8fafc"
                    : "#fff",
                }}
              >
                <div
                  title="Drag to reorder"
                  style={{
                    cursor: "grab",
                    textAlign: "center",
                    color: "#64748b",
                    fontSize: 18,
                    userSelect: "none",
                  }}
                >
                  ⋮⋮
                </div>

                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  Stop {index + 1}
                </div>

                <input
                  value={row.postcode}
                  onChange={(e) => updateRow(index, "postcode", e.target.value)}
                  placeholder="Enter postcode"
                  style={{ padding: 10 }}
                />

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 14,
                    justifyContent: "center",
                    fontWeight: row.locked ? 700 : 400,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={row.locked}
                    onChange={(e) =>
                      updateRow(index, "locked", e.target.checked)
                    }
                  />
                  Lock
                </label>

                <button
                  onClick={() => removeRow(index)}
                  disabled={rows.length <= 2}
                  style={{ padding: "10px 12px" }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 14,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={addRow}
              disabled={rows.length >= MAX_STOPS}
              style={{ padding: "10px 14px" }}
            >
              Add stop
            </button>
            <button
              onClick={buildRoute}
              disabled={loading}
              style={{ padding: "10px 14px" }}
            >
              {loading ? "Calculating..." : "Build route"}
            </button>
            <button
              onClick={reOptimiseRoute}
              disabled={loading || !route.length}
              style={{ padding: "10px 14px" }}
            >
              Re-optimise route
            </button>
            <button
              onClick={copyOrder}
              disabled={!route.length}
              style={{ padding: "10px 14px" }}
            >
              Copy order
            </button>
            <button onClick={clearAll} style={{ padding: "10px 14px" }}>
              Clear
            </button>
          </div>

          <p style={{ color: "#64748b", marginTop: 12 }}>
            {filledRows} filled job postcode{filledRows === 1 ? "" : "s"} ·
            Travel times include a 15% planning buffer.
          </p>

          {error && (
            <p style={{ color: "#dc2626", fontWeight: 700 }}>{error}</p>
          )}
        </div>

        <div style={{ display: "grid", gap: 20 }}>
          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 18,
              padding: 20,
              boxShadow: "0 6px 20px rgba(15,23,42,0.04)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Route summary</h3>

            {route.length ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <StatCard label="Stops" value={routeSummary.stops} />
                <StatCard
                  label="Total travel time"
                  value={formatDuration(routeSummary.totalTravel)}
                />
                <StatCard
                  label="Total miles"
                  value={(totalMiles || 0).toFixed(1)}
                />
                <StatCard
                  label="Longest drive"
                  value={formatDuration(routeSummary.longestLeg)}
                />
              </div>
            ) : (
              <p style={{ color: "#64748b" }}>
                Build a route to see the summary.
              </p>
            )}
          </div>

          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 18,
              padding: 20,
              boxShadow: "0 6px 20px rgba(15,23,42,0.04)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Map preview</h3>
            <RouteMapPreview route={route} startStop={mapStartStop} />
          </div>

          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 18,
              padding: 20,
              boxShadow: "0 6px 20px rgba(15,23,42,0.04)",
            }}
          >
            <h3 style={{ marginTop: 0 }}>Suggested order</h3>

            {route.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {route.map((stop, index) => {
                  const previousLeg = legs[index];
                  const colour = previousLeg
                    ? getTravelColour(previousLeg.travelMinutes)
                    : "#111827";
                  const isFinish =
                    !!currentFinishPostcode && index === route.length - 1;
                  const isLocked = rows.some(
                    (row) =>
                      row.locked &&
                      cleanPostcode(row.postcode) === stop.postcode
                  );

                  return (
                    <div key={`${stop.postcode}-${index}`}>
                      {previousLeg && (
                        <div
                          style={{
                            margin: "0 0 8px 52px",
                            color: colour,
                            fontWeight: 700,
                          }}
                        >
                          Travel time {Math.round(previousLeg.travelMinutes)}{" "}
                          min
                        </div>
                      )}

                      <div
                        style={{
                          border: isLocked
                            ? "2px solid #f59e0b"
                            : "1px solid #e2e8f0",
                          borderRadius: 14,
                          padding: 12,
                          display: "flex",
                          gap: 12,
                          alignItems: "flex-start",
                          background: isLocked ? "#fef3c7" : "#fff",
                        }}
                      >
                        <div
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 999,
                            background: isLocked ? "#f59e0b" : "#111827",
                            color: "#fff",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 14,
                            flexShrink: 0,
                            fontWeight: 700,
                          }}
                        >
                          {index + 1}
                        </div>

                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>
                            {isLocked ? "🔒 " : ""}
                            {stop.postcode}
                            {isFinish ? "  • Finish" : ""}
                            {isLocked ? "  • Locked" : ""}
                          </div>

                          <div
                            style={{
                              fontSize: 13,
                              color: "#64748b",
                              marginBottom: 6,
                              lineHeight: 1.4,
                            }}
                          >
                            {stop.label}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p style={{ color: "#64748b" }}>
                Add your postcodes and click Build route.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
