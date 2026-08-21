"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

type Pairing = {
  id: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
  counterpart: { name: string; symptoms: string | null };
};

export default function DoctorDashboard({ inviteCode }: { inviteCode: string }) {
  const [pairings, setPairings] = useState<Pairing[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/pairings");
    const data = await res.json();
    setPairings(data.pairings ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    load();
  }, [load]);

  async function respond(id: string, action: "ACCEPT" | "DECLINE") {
    setResponding(id);
    await fetch(`/api/pairings/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setResponding(null);
    await load();
  }

  function copyCode() {
    navigator.clipboard.writeText(inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const pending = pairings?.filter((p) => p.status === "PENDING") ?? [];
  const accepted = pairings?.filter((p) => p.status === "ACCEPTED") ?? [];

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 p-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Share this invite code with your existing patients so they can connect directly:
        </p>
        <div className="mt-2 flex items-center gap-3">
          <span className="text-2xl font-mono font-bold tracking-widest text-blue-600">
            {inviteCode}
          </span>
          <button
            onClick={copyCode}
            className="rounded-full border border-blue-300 dark:border-blue-800 px-3 py-1 text-sm hover:bg-blue-100 dark:hover:bg-blue-900"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4">Pending requests</h2>
        {pairings === null ? (
          <p className="text-neutral-500">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="text-neutral-500">No pending requests.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((p) => (
              <li
                key={p.id}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4"
              >
                <p className="font-medium">{p.counterpart.name}</p>
                {p.counterpart.symptoms && (
                  <p className="text-sm text-neutral-500 mt-1">
                    &ldquo;{p.counterpart.symptoms}&rdquo;
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => respond(p.id, "ACCEPT")}
                    disabled={responding === p.id}
                    className="rounded-full bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => respond(p.id, "DECLINE")}
                    disabled={responding === p.id}
                    className="rounded-full border border-neutral-300 dark:border-neutral-700 px-4 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4">Your patients</h2>
        {accepted.length === 0 ? (
          <p className="text-neutral-500">No connected patients yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {accepted.map((p) => (
              <li
                key={p.id}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4 flex items-center justify-between"
              >
                <p className="font-medium">{p.counterpart.name}</p>
                <Link
                  href={`/chat/${p.id}`}
                  className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Open chat
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
