"use client";

import { useState } from "react";

export default function LocationPicker({
  coords,
  onCoords,
  label,
  onLabel,
}: {
  coords: { lat: number; lng: number } | null;
  onCoords: (c: { lat: number; lng: number } | null) => void;
  label: string;
  onLabel: (l: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        if (!label) onLabel("Current location");
        setStatus("idle");
      },
      () => setStatus("error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return (
    <div>
      <label htmlFor="location-label" className="text-sm font-medium mb-1 block">
        Location
      </label>
      <div className="flex gap-2">
        <input
          id="location-label"
          placeholder="City or neighborhood (optional)"
          value={label}
          onChange={(e) => onLabel(e.target.value)}
          className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
        />
        <button
          type="button"
          onClick={useMyLocation}
          className="whitespace-nowrap rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          📍 {status === "loading" ? "Locating…" : "Use my location"}
        </button>
      </div>
      {coords && (
        <p className="text-xs text-green-600 mt-1">Location captured ✓</p>
      )}
      {status === "error" && (
        <p className="text-xs text-red-600 mt-1">
          Couldn&rsquo;t get your location — you can still type it above.
        </p>
      )}
    </div>
  );
}
