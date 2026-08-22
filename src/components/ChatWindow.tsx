"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

type Message = {
  id: string;
  text: string;
  createdAt: string;
  mine: boolean;
  senderName: string;
};

export default function ChatWindow({
  pairingId,
  viewerRole,
}: {
  pairingId: string;
  viewerRole: string;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [counterpart, setCounterpart] = useState<{ name: string; phone: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/pairings/${pairingId}/messages`);
    if (!res.ok) {
      setNotFound(true);
      return;
    }
    const data = await res.json();
    setMessages(data.messages);
    setCounterpart(data.counterpart);
    setStatus(data.status);
  }, [pairingId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/pairings/${pairingId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't send that message. Please try again.");
      }
      setDraft("");
      await load();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Couldn't send that message. Please try again.");
    } finally {
      setSending(false);
    }
  }

  if (notFound) {
    return (
      <main className="flex-1 flex items-center justify-center px-6">
        <p className="text-neutral-500">
          Conversation not found.{" "}
          <Link href="/dashboard" className="text-blue-600 hover:underline">
            Back to dashboard
          </Link>
        </p>
      </main>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-6 py-3">
        <div>
          <p className="font-medium">{counterpart ? counterpart.name : "Loading…"}</p>
          {status === "PENDING" && (
            <p className="text-xs text-amber-600">Waiting for the doctor to accept</p>
          )}
        </div>
        {viewerRole === "PATIENT" && counterpart?.phone && (
          <a
            href={`tel:${counterpart.phone.replace(/[^+\d]/g, "")}`}
            className="rounded-full bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 flex items-center gap-1"
          >
            📞 Call
          </a>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-2">
        {messages === null ? (
          <p className="text-neutral-500">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-neutral-500 text-sm">
            No messages yet. Say hello to get started.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                m.mine
                  ? "self-end bg-blue-600 text-white"
                  : "self-start bg-neutral-100 dark:bg-neutral-800"
              }`}
            >
              {m.text}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {sendError && (
        <p className="px-4 pt-2 text-sm text-red-600">{sendError}</p>
      )}
      <form onSubmit={send} className="border-t border-neutral-200 dark:border-neutral-800 p-4 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={status === "ACCEPTED" ? "Type a message…" : "Waiting for pairing to be accepted…"}
          disabled={status !== "ACCEPTED"}
          className="flex-1 rounded-full border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || status !== "ACCEPTED"}
          className="rounded-full bg-blue-600 px-5 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
