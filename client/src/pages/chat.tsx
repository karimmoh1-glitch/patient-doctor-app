import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AuthUser } from "@/hooks/use-auth";

interface ChatMessage {
  id: string;
  senderUserId: string;
  body: string;
  createdAt: string;
}

export default function ChatPage({
  pairingId,
  user,
  backHref,
}: {
  pairingId: string;
  user: AuthUser;
  backHref: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const counterpartName = new URLSearchParams(window.location.search).get("with") || "your doctor";
  const messagesKey = `/api/pairings/${pairingId}/messages`;

  const { data: messages, isLoading, isError, error } = useQuery<ChatMessage[]>({
    queryKey: [messagesKey],
    // Polling keeps this simple and consistent with how match results and
    // requests already refresh — no WebSocket infra for a demo app.
    refetchInterval: 4000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await apiRequest("POST", messagesKey, { body });
      setDraft("");
      queryClient.invalidateQueries({ queryKey: [messagesKey] });
    } catch (err: any) {
      toast({ title: "Couldn't send message", description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col space-y-4">
      <div className="flex items-center gap-2">
        <Link href={backHref}>
          <Button variant="ghost" size="sm">
            <ArrowLeft /> Back
          </Button>
        </Link>
        <h1 className="text-xl font-semibold">Chat with {counterpartName}</h1>
      </div>

      {isError && <p className="text-sm text-destructive">{(error as Error)?.message || "Couldn't load messages."}</p>}

      <div className="flex h-[28rem] flex-col gap-2 overflow-y-auto rounded-md border border-border bg-card p-4">
        {isLoading && <p className="text-muted-foreground">Loading…</p>}
        {!isLoading && messages?.length === 0 && (
          <p className="text-muted-foreground">No messages yet — say hello.</p>
        )}
        {messages?.map((m) => {
          const mine = m.senderUserId === user.id;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                  mine ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1 text-[10px] opacity-70">
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          disabled={sending}
          aria-label="Message"
        />
        <Button type="submit" disabled={sending || !draft.trim()}>
          <Send />
        </Button>
      </form>
    </div>
  );
}
