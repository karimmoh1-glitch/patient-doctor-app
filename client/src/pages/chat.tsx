import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Send, Paperclip, CalendarDays, Pill, FileText, RotateCw, Flag, ShieldBan, Check, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import ConfirmAction from "@/components/confirm-action";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ErrorBlock, LoadingBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { formatRelativeDay, formatDateTime } from "@/lib/format";
import { useEmergency } from "@/lib/emergency";
import { useI18n } from "@/lib/i18n";
import { appointmentTypeLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface ContextAppointment { type: string; scheduledAt: string; doctor: { name: string } | null; status: string }
interface ContextPrescription { medicationName: string; instructions: string; status: string }
interface ContextDocument { title: string; category: string }

// Lets a patient add a readable line about their own appointment, medicine or
// document to the message they're writing, instead of retyping it.
function ContextAttachMenu({ onAttach }: { onAttach: (text: string) => void }) {
  const { t } = useI18n();
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
          <Paperclip aria-hidden="true" /> {t("pt.chat.addDetails")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 text-base">
        <DropdownMenuLabel className="flex items-center gap-2"><CalendarDays className="h-4 w-4" aria-hidden="true" /> {t("pt.chat.myVisits")}</DropdownMenuLabel>
        {upcoming.length === 0 && <p className="px-2 pb-2 text-muted-foreground">{t("pt.chat.noVisits")}</p>}
        {upcoming.map((a, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(t("pt.chat.aboutVisit", { type: appointmentTypeLabel(t, a.type), doctor: a.doctor?.name ?? t("pt.chat.myDoctor"), when: formatRelativeDay(a.scheduledAt) }))}>
            {t("pt.chat.visitItem", { type: appointmentTypeLabel(t, a.type), when: formatRelativeDay(a.scheduledAt) })}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2"><Pill className="h-4 w-4" aria-hidden="true" /> {t("pt.chat.myMeds")}</DropdownMenuLabel>
        {activeRx.length === 0 && <p className="px-2 pb-2 text-muted-foreground">{t("pt.chat.noMeds")}</p>}
        {activeRx.map((p, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(t("pt.chat.aboutMed", { name: p.medicationName, instructions: p.instructions }))}>
            {p.medicationName}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2"><FileText className="h-4 w-4" aria-hidden="true" /> {t("pt.chat.myDocs")}</DropdownMenuLabel>
        {recentDocs.length === 0 && <p className="px-2 pb-2 text-muted-foreground">{t("pt.chat.noDocs")}</p>}
        {recentDocs.map((d, i) => (
          <DropdownMenuItem key={i} className="min-h-11" onClick={() => onAttach(t("pt.chat.aboutDoc", { title: d.title, category: d.category }))}>
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
  /** Only on this person's own messages: what the server can truthfully say about it. */
  status?: "sent" | "delivered" | "read";
}

const PAGE_SIZE = 100;
const newClientId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

function StatusMark({ status }: { status: NonNullable<ChatMessage["status"]> }) {
  const { t } = useI18n();
  const Icon = status === "sent" ? Check : CheckCheck;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="h-4 w-4" aria-hidden="true" />
      {t(`msg.status.${status}` as const)}
    </span>
  );
}

const REASONS = ["abuse", "harassment", "unsafe", "spam", "other"] as const;

function ReportMessage({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("abuse");
  const [details, setDetails] = useState("");
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/conversations/messages/${message.id}/report`, { reason, details: details.trim() || undefined, shareText: share });
      toast({ title: t("msg.report.sent") });
      setOpen(false);
      setDetails("");
      setShare(false);
    } catch (err: any) {
      toast({ title: t("msg.report.failed"), description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="mt-1"><Flag aria-hidden="true" /> {t("msg.report")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("msg.report.title")}</DialogTitle>
          <DialogDescription>{t("msg.report.shareHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`rr-${message.id}`} className="text-base">{t("msg.report.reason")}</Label>
            <NativeSelect id={`rr-${message.id}`} value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
              {REASONS.map((r) => <option key={r} value={r}>{t(`msg.report.r.${r}` as const)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`rd-${message.id}`} className="text-base">{t("msg.report.details")}</Label>
            <Textarea id={`rd-${message.id}`} rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
          </div>
          <label className="flex min-h-12 cursor-pointer items-start gap-3 text-base font-medium">
            <input type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={share} onChange={(e) => setShare(e.target.checked)} />
            {t("msg.report.share")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button disabled={busy} onClick={submit}>{t("msg.report.send")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A message the server hasn't confirmed yet. Shown as "sending" or "not sent",
// never as delivered or read — we only know what the server tells us.
interface PendingMessage {
  tempId: string;
  /** Reused on every retry of this message, so a retry can never send it twice. */
  clientMessageId: string;
  body: string;
  state: "sending" | "failed";
  error?: string;
}

export default function ChatPage({ pairingId, user, backHref }: { pairingId: string; user: AuthUser; backHref: string }) {
  const { t } = useI18n();
  const emergency = useEmergency();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [noMoreOlder, setNoMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const isPatient = user.role === "patient";
  const counterpartName = new URLSearchParams(window.location.search).get("with") || (isPatient ? t("pt.yourDoctor") : t("pt.thePatient"));
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

  // Tell the server, only while the conversation is really on screen, that what the other person sent has been seen.
  const lastIncoming = query.data?.filter((m) => m.senderUserId !== user.id).at(-1)?.id;
  useEffect(() => {
    if (!lastIncoming || document.visibilityState !== "visible") return;
    apiRequest("POST", `${messagesKey}/read`)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
        queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      })
      .catch(() => {});
  }, [lastIncoming, messagesKey, queryClient]);

  async function loadOlder() {
    const first = older[0] ?? query.data?.[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const res = await apiRequest("GET", `${messagesKey}?limit=${PAGE_SIZE}&before=${encodeURIComponent(first.createdAt)}`);
      const page = (await res.json()) as ChatMessage[];
      setOlder((o) => [...page, ...o]);
      if (page.length < PAGE_SIZE) setNoMoreOlder(true);
    } catch (err: any) {
      toast({ title: t("pt.chat.loading"), description: err.message, variant: "destructive" });
    } finally {
      setLoadingOlder(false);
    }
  }

  async function blockAndEnd() {
    await apiRequest("POST", `/api/conversations/${pairingId}/block`);
    toast({ title: t("msg.block.done") });
    queryClient.invalidateQueries();
    navigate(backHref);
  }

  async function deliver(tempId: string, body: string, clientMessageId: string) {
    setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, state: "sending", error: undefined } : m)));
    try {
      await apiRequest("POST", messagesKey, { body, clientMessageId });
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
    const clientMessageId = newClientId();
    setPending((p) => [...p, { tempId, clientMessageId, body, state: "sending" }]);
    setDraft("");
    deliver(tempId, body, clientMessageId);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline">
          <Link href={backHref}><ArrowLeft aria-hidden="true" className="flip-rtl" /> {t("common.back")}</Link>
        </Button>
        <h1 className="text-2xl font-semibold">{t("pt.chat.title", { name: counterpartName })}</h1>
        <div className="ms-auto">
          <ConfirmAction
            trigger={<Button type="button" variant="outline" size="sm"><ShieldBan aria-hidden="true" /> {t("msg.block")}</Button>}
            title={t("msg.block.title", { name: counterpartName })}
            description={t("msg.block.body")}
            confirmLabel={t("msg.block.yes")}
            cancelLabel={t("common.cancel")}
            onConfirm={blockAndEnd}
          />
        </div>
      </div>

      {isPatient ? (
        <p role="note" className="rounded-xl border-2 border-input bg-card p-4 text-lg">
          {t("pt.chat.note", { name: counterpartName, number: emergency.label })}
        </p>
      ) : (
        <p role="note" className="rounded-xl border-2 border-input bg-card p-4 text-lg">{t("msg.doctorNote")}</p>
      )}

      {query.isLoading && <LoadingBlock label={t("pt.chat.loading")} />}
      {query.isError && !query.data && <ErrorBlock error={query.error} onRetry={() => query.refetch()} />}

      {(query.data || pending.length > 0) && (
        <div
          role="log"
          aria-label={t("pt.chat.conversation")}
          aria-live="polite"
          className="flex max-h-[32rem] min-h-48 flex-col gap-4 overflow-y-auto rounded-xl border-2 border-input bg-card p-4"
        >
          {query.data?.length === 0 && pending.length === 0 && <p className="text-lg text-muted-foreground">{t("pt.chat.empty")}</p>}
          {!noMoreOlder && ((query.data?.length ?? 0) >= PAGE_SIZE || older.length > 0) && (
            <Button type="button" variant="outline" size="sm" className="self-center" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? t("msg.older.loading") : t("msg.older")}
            </Button>
          )}
          {[...older, ...(query.data ?? [])].map((m) => {
            const mine = m.senderUserId === user.id;
            return (
              <div key={m.id} className={mine ? "self-end" : "self-start"}>
                <p className="mb-1 text-sm font-semibold text-muted-foreground">{mine ? t("pt.chat.you") : counterpartName}</p>
                <p dir="auto" className={`max-w-prose whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-lg ${mine ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
                  {m.body}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                  <span>{mine ? t("pt.chat.sent", { when: formatDateTime(m.createdAt) }) : formatDateTime(m.createdAt)}</span>
                  {mine && m.status && m.status !== "sent" && <StatusMark status={m.status} />}
                </p>
                {!mine && <ReportMessage message={m} />}
              </div>
            );
          })}
          {pending.map((m) => (
            <div key={m.tempId} className="self-end">
              <p className="mb-1 text-sm font-semibold text-muted-foreground">{t("pt.chat.you")}</p>
              <p dir="auto" className="max-w-prose whitespace-pre-wrap break-words rounded-xl border-2 border-dashed border-input px-4 py-3 text-lg">{m.body}</p>
              {m.state === "sending" ? (
                <p role="status" className="mt-1 text-sm text-muted-foreground">{t("pt.sending")}</p>
              ) : (
                <div role="alert" className="mt-1 flex flex-wrap items-center gap-3">
                  <p className="font-semibold text-destructive">{t("pt.chat.notSent", { error: m.error ?? "" })}</p>
                  <Button variant="outline" size="sm" onClick={() => deliver(m.tempId, m.body, m.clientMessageId)}><RotateCw aria-hidden="true" /> {t("common.retry")}</Button>
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      <p className="text-sm text-muted-foreground">{t("msg.status.help")}</p>

      <form onSubmit={send} className="space-y-3">
        <Label htmlFor="message" className="text-base">{t("pt.chat.yourMessage")}</Label>
        <Textarea id="message" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} maxLength={4000} />
        <div className="flex flex-wrap gap-3">
          {isPatient && <ContextAttachMenu onAttach={(text) => setDraft((d) => (d ? `${d}\n${text}` : text))} />}
          <Button type="submit" size="lg" disabled={!draft.trim()}>
            <Send aria-hidden="true" className="flip-rtl" /> {t("pt.chat.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}
