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
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
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
      toast({ title: t("assistant.toast.failed"), description: err.message, variant: "destructive" });
    } finally {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/messages"] });
      setSending(false);
    }
  }

  const appointmentId = dashboard?.upcomingAppointment?.id;
  // The text each button SENDS stays English: the helper on the server reads English wording.
  const quick = [
    { icon: CalendarClock, label: appointmentId ? t("assistant.quick.getReady") : t("assistant.quick.whenNext"), run: () => (appointmentId ? setLocation(`/appointments/${appointmentId}`) : send("When is my next appointment?")) },
    { icon: MessageSquareQuote, label: t("assistant.quick.simple"), run: () => send("Explain what my doctor told me to do after my last appointment, in simple language.") },
    { icon: ListChecks, label: t("assistant.quick.questions"), run: () => send("Help me think of a few good questions to ask my doctor at my next appointment.") },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold">{t("assistant.title")}</h1>
        <p role="note" className="rounded-xl border-2 border-input bg-card p-4 text-lg">
          {usesAi
            ? t("assistant.note.ai")
            : t("assistant.note.noai")}{" "}
          {t("assistant.note.emergency", { number: EMERGENCY_NUMBER })}
        </p>
      </div>

      <ul className="space-y-3">
        {quick.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              onClick={a.run}
              disabled={sending}
              className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 border-input bg-card px-4 py-3 text-start text-lg font-semibold hover:bg-secondary disabled:opacity-60"
            >
              <a.icon className="h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
              {a.label}
            </button>
          </li>
        ))}
      </ul>

      <QueryState query={messagesQuery} loadingLabel={t("assistant.loading")}>
        {(messages) => (
          <div
            role="log"
            aria-label={t("assistant.log")}
            aria-live="polite"
            className="flex max-h-[28rem] min-h-40 flex-col gap-3 overflow-y-auto rounded-xl border-2 border-input bg-card p-4"
          >
            {messages.length === 0 && <p className="text-lg text-muted-foreground">{t("assistant.empty")}</p>}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "self-end" : "self-start"}>
                <p className="mb-1 text-sm font-semibold text-muted-foreground">{m.role === "user" ? t("assistant.you") : t("assistant.helper")}</p>
                <p dir="auto" className={`max-w-prose whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-lg ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                  {m.content}
                </p>
              </div>
            ))}
            {sending && <p role="status" className="text-lg text-muted-foreground">{t("assistant.lookingUp")}</p>}
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
        <Label htmlFor="ask" className="text-base">{t("assistant.ask.label")}</Label>
        <div className="flex gap-3">
          <Input id="ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("assistant.ask.placeholder")} disabled={sending} />
          <Button type="submit" size="lg" disabled={sending || !draft.trim()}>
            <Send aria-hidden="true" className="flip-rtl" /> {t("assistant.ask.button")}
          </Button>
        </div>
      </form>
    </div>
  );
}
