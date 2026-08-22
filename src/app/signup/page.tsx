"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SPECIALTIES } from "@/lib/specialty";
import VoiceTextarea from "@/components/VoiceTextarea";
import LocationPicker from "@/components/LocationPicker";

type Role = "PATIENT" | "DOCTOR" | null;

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [symptoms, setSymptoms] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [specialty, setSpecialty] = useState<string>(SPECIALTIES[0]);
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locationLabel, setLocationLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const payload: Record<string, unknown> = {
      role,
      name,
      email,
      password,
      lat: coords?.lat,
      lng: coords?.lng,
      locationLabel,
    };
    if (role === "PATIENT") {
      payload.symptoms = symptoms;
      if (inviteCode.trim()) payload.inviteCode = inviteCode.trim();
    } else if (role === "DOCTOR") {
      payload.specialty = specialty;
      payload.phone = phone;
    }

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        setLoading(false);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error");
      setLoading(false);
    }
  }

  if (!role) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <h1 className="text-2xl font-bold mb-8">I am a...</h1>
        <div className="flex gap-4">
          <button
            onClick={() => setRole("PATIENT")}
            className="rounded-2xl border border-neutral-300 dark:border-neutral-700 px-8 py-6 text-lg font-medium hover:border-blue-600 hover:text-blue-600 transition"
          >
            🧑 Patient
          </button>
          <button
            onClick={() => setRole("DOCTOR")}
            className="rounded-2xl border border-neutral-300 dark:border-neutral-700 px-8 py-6 text-lg font-medium hover:border-blue-600 hover:text-blue-600 transition"
          >
            🩺 Doctor
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-12">
      <div className="w-full max-w-md">
        <button
          type="button"
          onClick={() => setRole(null)}
          className="text-sm text-neutral-500 hover:text-blue-600 mb-4"
        >
          ← back
        </button>
        <h1 className="text-2xl font-bold mb-6">
          {role === "PATIENT" ? "Patient sign up" : "Doctor sign up"}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            required
            aria-label="Full name"
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
          />
          <input
            required
            type="email"
            aria-label="Email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
          />
          <input
            required
            type="password"
            aria-label="Password, minimum 8 characters"
            placeholder="Password (min 8 characters)"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
          />

          {role === "PATIENT" && (
            <>
              <div>
                <label className="text-sm font-medium mb-1 block">
                  What&rsquo;s wrong? Speak or type.
                </label>
                <VoiceTextarea value={symptoms} onChange={setSymptoms} />
              </div>

              <LocationPicker
                coords={coords}
                onCoords={setCoords}
                label={locationLabel}
                onLabel={setLocationLabel}
              />

              <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 p-4">
                <label className="text-sm font-medium mb-1 block">
                  Already have a doctor? Enter their invite code (optional)
                </label>
                <input
                  aria-label="Doctor's invite code"
                  placeholder="e.g. AB12CD"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2 tracking-widest uppercase"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Leave blank and we&rsquo;ll match you with nearby doctors instead.
                </p>
              </div>
            </>
          )}

          {role === "DOCTOR" && (
            <>
              <select
                aria-label="Specialty"
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
              >
                {SPECIALTIES.map((s) => (
                  <option key={s} value={s} className="text-black">
                    {s}
                  </option>
                ))}
              </select>
              <input
                required
                type="tel"
                aria-label="Phone number"
                placeholder="Phone number (e.g. +1 555 123 4567)"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2"
              />
              <LocationPicker
                coords={coords}
                onCoords={setCoords}
                label={locationLabel}
                onLabel={setLocationLabel}
              />
            </>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 rounded-full bg-blue-600 px-6 py-3 font-medium text-white shadow hover:bg-blue-700 transition disabled:opacity-50"
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>
    </main>
  );
}
