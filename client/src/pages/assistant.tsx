import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Send, CalendarClock, MessageSquareQuote, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import QueryState from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAppConfig } from "@/hooks/use-app-config";
import { EMERGENCY_NUMBER } from "@/lib/emergency";

interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface DashboardData {
  upcomingAppointment: { id: string } | null;
}

export default function Assistant() {
  const { toast } = useToast();
  const config = useAppConfig();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messagesQuery = useQuery<AiMessage[]>({ queryKey: ["/api/ai/messages"] });
  const { data: dashboard } = useQuery<DashboardData>({ queryKey: ["/api/dashboard"] });
  const usesAi = !!config?.features.aiAssistant;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messagesQuery.data?.length]);

  async function send(text?: string) {
    const message = (text ?? draft).trim();
    if (!message) return;
    setSending(true);
    setDraft("");
    queryClient.setQueryData<AiMessage[]>(["/api/ai/messages"], (prev) => [
      ...(prev || []),
      { id: `optimistic-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString() },
    ]);
    try {
      await apiRequest("POST", "/api/ai/chat", { message });
    } catch (err: any) {
      toast({ title: "We couldn't get an answer", description: err.message, variant: "destructive" });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/messages"] });
      setSending(false);
    }
  }

  const appointmentId = dashboard?.upcomingAppointment?.id;
  const quick = [
    { icon: CalendarClock, label: appointmentId ? "Get ready for my next visit" : "When is my next visit?", run: () => (appointmentId ? setLocation(`/appointments/${appointmentId}`) : send("When is my next appointment?")) },
    { icon: MessageSquareQuote, label: "Say my doctor's last instructions in simple words", run: () => send("Explain what my doctor told me to do after my last appointment, in simple language.") },
    { icon: ListChecks, label: "Help me think of questions to ask", run: () => send("Help me think of a few good questions to ask my doctor at my next appointment.") },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">Questions about my care</h1>
        <p role="note" className="rounded-xl border-2 border-input bg-card p-4 text-lg">
          {usesAi
            ? "This helper uses artificial intelligence to find and explain information in your own records. It can be wrong. It is not a doctor and cannot give medical advice."
            : "This helper looks up facts in your own records, like your medicines and visits. It is not artificial intelligence, it is not a doctor, and it cannot give medical advice."}{" "}
          If this is an emergency, call {EMERGENCY_NUMBER}.
        </p>
      </div>

      <ul className="space-y-3">
        {quick.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              onClick={a.run}
              disabled={sending}
              className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-input bg-card px-4 py-3 text-left text-lg font-semibold hover:bg-secondary disabled:opacity-60"
            >
              <a.icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
              {a.label}
            </button>
          </li>
        ))}
      </ul>

      <QueryState query={messagesQuery} loadingLabel="Loading your conversation">
        {(messages) => (
          <div
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-xl border-2 border-input bg-card p-4"
          >
            {messages.length === 0 && <p className="text-lg text-muted-foreground">Nothing asked yet. Choose a button above, or type a question below.</p>}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "self-end" : "self-start"}>
                <p className="mb-1 text-sm font-semibold text-muted-foreground">{m.role === "user" ? "You" : "Helper"}</p>
                <p className={`max-w-prose whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-lg ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                  {m.content}
                </p>
              </div>
            ))}
            {sending && <p role="status" className="text-lg text-muted-foreground">Looking that up…</p>}
            <div ref={bottomRef} />
          </div>
        )}
      </QueryState>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Label htmlFor="ask" className="text-base">Type a question</Label>
        <div className="flex gap-3">
          <Input id="ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="For example: What medicines do I take?" disabled={sending} />
          <Button type="submit" size="lg" disabled={sending || !draft.trim()}>
            <Send aria-hidden="true" /> Ask
          </Button>
        </div>
      </form>
    </div>
  );
}
