"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

type Pairing = {
  id: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
  counterpart: { name: string; specialty: string; phone: string };
};

type NearbyDoctor = {
  id: string;
  name: string;
  specialty: string;
  locationLabel: string | null;
  distanceMiles: number | null;
  matchesSpecialty: boolean;
};

export default function PatientDashboard({ symptoms }: { symptoms: string }) {
  const [pairings, setPairings] = useState<Pairing[] | null>(null);
  const [doctors, setDoctors] = useState<NearbyDoctor[] | null>(null);
  const [suggestedSpecialty, setSuggestedSpecialty] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadPairings = useCallback(async () => {
    try {
      const res = await fetch("/api/pairings");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setPairings(data.pairings ?? []);
    } catch {
      setActionError("Couldn't load your care list. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    loadPairings();
  }, [loadPairings]);

  function findNearbyDoctors() {
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationError("Geolocation isn't supported in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const params = new URLSearchParams({
            lat: String(pos.coords.latitude),
            lng: String(pos.coords.longitude),
            symptoms,
          });
          const res = await fetch(`/api/doctors/nearby?${params}`);
          if (!res.ok) throw new Error();
          const data = await res.json();
          setDoctors(data.doctors ?? []);
          setSuggestedSpecialty(data.suggestedSpecialty ?? null);
        } catch {
          setLocationError("Couldn't search for doctors right now. Please try again.");
        }
        setLocating(false);
      },
      () => {
        setLocationError("Couldn't get your location. Please allow location access.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function requestDoctor(doctorId: string) {
    setRequesting(doctorId);
    setActionError(null);
    try {
      const res = await fetch("/api/pairings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctorId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't send the request. Please try again.");
      }
      await loadPairings();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't send the request. Please try again.");
    } finally {
      setRequesting(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {actionError && (
        <p className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-4 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}
      <section>
        <h1 className="text-2xl font-bold mb-4">Your care</h1>
        {pairings === null ? (
          <p className="text-neutral-500">Loading…</p>
        ) : pairings.length === 0 ? (
          <p className="text-neutral-500">
            You&rsquo;re not connected with a doctor yet. Find one nearby below.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pairings.map((p) => (
              <li
                key={p.id}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">Dr. {p.counterpart.name}</p>
                  <p className="text-sm text-neutral-500">{p.counterpart.specialty}</p>
                </div>
                {p.status === "ACCEPTED" && (
                  <Link
                    href={`/chat/${p.id}`}
                    className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Open chat
                  </Link>
                )}
                {p.status === "PENDING" && (
                  <span className="text-sm text-amber-600 font-medium">Request sent — waiting</span>
                )}
                {p.status === "DECLINED" && (
                  <span className="text-sm text-neutral-400">Declined</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Find a doctor near you</h2>
          <button
            onClick={findNearbyDoctors}
            disabled={locating}
            className="rounded-full border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
          >
            📍 {locating ? "Locating…" : "Search near me"}
          </button>
        </div>
        {locationError && <p className="text-sm text-red-600 mb-2">{locationError}</p>}
        {suggestedSpecialty && (
          <p className="text-sm text-neutral-500 mb-3">
            Based on your symptoms, we suggest{" "}
            <span className="font-medium text-blue-600">{suggestedSpecialty}</span>.
          </p>
        )}
        {doctors && (
          <ul className="flex flex-col gap-3">
            {doctors.length === 0 && (
              <p className="text-neutral-500">No doctors registered yet — check back soon.</p>
            )}
            {doctors.map((d) => (
              <li
                key={d.id}
                className={`rounded-xl border p-4 flex items-center justify-between ${
                  d.matchesSpecialty
                    ? "border-blue-400 dark:border-blue-700"
                    : "border-neutral-200 dark:border-neutral-800"
                }`}
              >
                <div>
                  <p className="font-medium">
                    Dr. {d.name}{" "}
                    {d.matchesSpecialty && (
                      <span className="ml-1 text-xs rounded-full bg-blue-100 dark:bg-blue-950 text-blue-600 px-2 py-0.5">
                        Best match
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-500">
                    {d.specialty}
                    {d.locationLabel ? ` · ${d.locationLabel}` : ""}
                    {d.distanceMiles != null ? ` · ${d.distanceMiles} mi away` : ""}
                  </p>
                </div>
                <button
                  onClick={() => requestDoctor(d.id)}
                  disabled={requesting === d.id}
                  className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {requesting === d.id ? "Sending…" : "Request"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
