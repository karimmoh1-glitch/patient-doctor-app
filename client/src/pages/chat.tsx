import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Send, Paperclip, CalendarDays, Pill, FileText, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ErrorBlock, LoadingBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { formatRelativeDay, formatDateTime } from "@/lib/format";
import { EMERGENCY_NUMBER } from "@/lib/emergency";
import type { AuthUser } from "@/hooks/use-auth";

interface ContextAppointment { type: string; scheduledAt: string; doctor: { name: string } | null; status: string }
interface ContextPrescription { medicationName: string; instructions: string; status: string }
interface ContextDocument { title: string; category: string }

// Lets a patient add a readable line about their own appointment, medicine or
// document to the message they're writing, instead of retyping it.
function ContextAttachMenu({ onAttach }: { onAttach: (text: string) => void }) {
  const { data: appointments } = useQuery<ContextAppointment[]>({ queryKey: ["/api/appointments"] });
  const { data: prescriptions } = useQuery<ContextPrescription[]>({ queryKey: ["/api/prescriptions"] });
  const { data: documents } = useQuery<ContextDocument[]>({ queryKey: ["/api/documents"] });

  const upcoming = (appointments || []).filter((a) => a.status === "requested" || a.status === "confirmed").slice(0, 3);
  const activeRx = (prescriptions || []).filter((p) => p.status === "active").slice(0, 3);
  const recentDocs = (documents || []).slice(0, 3);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline">
          <Paperclip aria-hidden="true" /> Add details
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 text-base">
        <DropdownMenuLabel className="flex items-center gap-2"><CalendarDays className="h-4 w-4" aria-hidden="true" /> My visits</DropdownMenuLabel>
        {upcoming.length === 0 && <p className="px-2 pb-2 text-muted-foreground">None coming up</p>}
        {upcoming.map((a, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(`About my visit: ${a.type} with ${a.doctor?.name ?? "my doctor"}, ${formatRelativeDay(a.scheduledAt)}.`)}>
            {a.type} — {formatRelativeDay(a.scheduledAt)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2"><Pill className="h-4 w-4" aria-hidden="true" /> My medicines</DropdownMenuLabel>
        {activeRx.length === 0 && <p className="px-2 pb-2 text-muted-foreground">None active</p>}
        {activeRx.map((p, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(`About my medicine: ${p.medicationName} (${p.instructions}).`)}>
            {p.medicationName}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2"><FileText className="h-4 w-4" aria-hidden="true" /> My documents</DropdownMenuLabel>
        {recentDocs.length === 0 && <p className="px-2 pb-2 text-muted-foreground">None saved</p>}
        {recentDocs.map((d, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(`About my document: ${d.title} (${d.category}).`)}>
            {d.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ChatMessage {
  id: string;
  senderUserId: string;
  body: string;
  createdAt: string;
}

// A message the server hasn't confirmed yet. Shown as "sending" or "not sent",
// never as delivered or read — we only know what the server tells us.
interface PendingMessage {
  tempId: string;
  body: string;
  state: "sending" | "failed";
  error?: string;
}

export default function ChatPage({ pairingId, user, backHref }: { pairingId: string; user: AuthUser; backHref: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isPatient = user.role === "patient";
  const counterpartName = new URLSearchParams(window.location.search).get("with") || (isPatient ? "your doctor" : "the patient");
  const messagesKey = `/api/pairings/${pairingId}/messages`;

  const query = useQuery<ChatMessage[]>({
    queryKey: [messagesKey],
    // New replies appear without refreshing. A modest interval keeps data use
    // low, and polling pauses while the tab is hidden.
    refetchInterval: 12_000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [query.data?.length, pending.length]);

  async function deliver(tempId: string, body: string) {
    setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, state: "sending", error: undefined } : m)));
    try {
      await apiRequest("POST", messagesKey, { body });
      await queryClient.invalidateQueries({ queryKey: [messagesKey] });
      setPending((p) => p.filter((m) => m.tempId !== tempId));
    } catch (err: any) {
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, state: "failed", error: err.message } : m)));
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const tempId = `pending-${Date.now()}`;
    setPending((p) => [...p, { tempId, body, state: "sending" }]);
    setDraft("");
    deliver(tempId, body);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <Link href={backHref}><ArrowLeft aria-hidden="true" /> Back</Link>
        </Button>
        <h1 className="text-2xl font-semibold">Messages with {counterpartName}</h1>
      </div>

      {isPatient && (
        <p role="note" className="rounded-xl border-2 border-input bg-card p-4 text-lg">
          For questions that can wait. {counterpartName} will answer when they can, which may take a day or more, and messages aren't watched all day and night. If it's urgent, call them. In an emergency, call {EMERGENCY_NUMBER}.
        </p>
      )}

      {query.isLoading && <LoadingBlock label="Loading messages" />}
      {query.isError && !query.data && <ErrorBlock error={query.error} onRetry={() => query.refetch()} />}

      {(query.data || pending.length > 0) && (
        <div
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          className="flex max-h-[32rem] min-h-48 flex-col gap-4 overflow-y-auto rounded-xl border-2 border-input bg-card p-4"
        >
          {query.data?.length === 0 && pending.length === 0 && <p className="text-lg text-muted-foreground">No messages yet. Write the first one below.</p>}
          {query.data?.map((m) => {
            const mine = m.senderUserId === user.id;
            return (
              <div key={m.id} className={mine ? "self-end" : "self-start"}>
                <p className="mb-1 text-sm font-semibold text-muted-foreground">{mine ? "You" : counterpartName}</p>
                <p className={`max-w-prose whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-lg ${mine ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                  {m.body}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{mine ? "Sent " : ""}{formatDateTime(m.createdAt)}</p>
              </div>
            );
          })}
          {pending.map((m) => (
            <div key={m.tempId} className="self-end">
              <p className="mb-1 text-sm font-semibold text-muted-foreground">You</p>
              <p className="max-w-prose whitespace-pre-wrap break-words rounded-xl border-2 border-dashed border-input px-4 py-3 text-lg">{m.body}</p>
              {m.state === "sending" ? (
                <p role="status" className="mt-1 text-sm text-muted-foreground">Sending…</p>
              ) : (
                <div role="alert" className="mt-1 flex flex-wrap items-center gap-3">
                  <p className="font-semibold text-destructive">Not sent. {m.error}</p>
                  <Button variant="outline" size="sm" onClick={() => deliver(m.tempId, m.body)}><RotateCw aria-hidden="true" /> Try again</Button>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      <form onSubmit={send} className="space-y-3">
        <Label htmlFor="message" className="text-base">Your message</Label>
        <Textarea id="message" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={4000} />
        <div className="flex flex-wrap gap-3">
          {isPatient && <ContextAttachMenu onAttach={(text) => setDraft((d) => (d ? `${d}\n${text}` : text))} />}
          <Button type="submit" size="lg" disabled={!draft.trim()}>
            <Send aria-hidden="true" /> Send
          </Button>
        </div>
      </form>
    </div>
  );
}
