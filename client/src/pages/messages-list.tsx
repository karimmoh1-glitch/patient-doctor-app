import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronRight, Search } from "lucide-react";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { timeAgo } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface Conversation {
  pairingId: string;
  name: string;
  specialty: string | null;
  unread: number;
  lastMessage: { at: string; fromMe: boolean; snippet: string } | null;
}
interface Inbox { unreadTotal: number; conversations: Conversation[] }
interface Hit { messageId: string; pairingId: string; name: string; at: string | null; excerpt: string; fromMe: boolean }

const chatHref = (pairingId: string, name: string) => `/chat/${pairingId}?with=${encodeURIComponent(name)}`;

function ConversationRow({ c }: { c: Conversation }) {
  const { t } = useI18n();
  return (
    <li>
      <Link href={chatHref(c.pairingId, c.name)} className="flex min-h-20 items-center gap-4 rounded-xl border-2 border-input bg-card p-4 hover:bg-secondary">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={`block text-xl ${c.unread ? "font-bold" : "font-semibold"}`}>{c.name}</span>
            {c.unread > 0 && <span className="rounded-full bg-primary px-2.5 py-0.5 text-base font-semibold text-primary-foreground">{t("msg.unread", { count: c.unread })}</span>}
          </span>
          {c.specialty && <span className="block text-muted-foreground">{specialtyLabel(t, c.specialty)}</span>}
          <span className={`mt-1 block truncate text-lg ${c.unread ? "font-medium" : ""}`}>
            {c.lastMessage ? (c.lastMessage.fromMe ? t("pt.msgs.you", { body: c.lastMessage.snippet }) : c.lastMessage.snippet) : <em className="text-muted-foreground">{t("pt.msgs.none")}</em>}
          </span>
        </span>
        {c.lastMessage && <span className="shrink-0 text-muted-foreground">{timeAgo(c.lastMessage.at)}</span>}
        <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground flip-rtl" aria-hidden="true" />
      </Link>
    </li>
  );
}

function SearchBox() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const term = q.trim();
  const results = useQuery<Hit[]>({ queryKey: [`/api/conversations/search?q=${encodeURIComponent(term)}`], enabled: term.length >= 3, staleTime: 0 });
  return (
    <section aria-labelledby="msg-search" className="space-y-3">
      <Label htmlFor="msg-search-input" id="msg-search" className="text-base">{t("msg.search")}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input id="msg-search-input" type="search" className="ps-10" value={q} onChange={(e) => setQ(e.target.value)} aria-describedby="msg-search-hint" />
      </div>
      <p id="msg-search-hint" className="text-base text-muted-foreground">{t("msg.search.hint")}</p>
      {term.length >= 3 && (
        <div role="status" aria-live="polite">
          {results.isLoading && <p className="text-muted-foreground">{t("msg.search.loading")}</p>}
          {results.data && results.data.length === 0 && <p className="text-lg">{t("msg.search.none")}</p>}
          {results.data && results.data.length > 0 && (
            <ul className="space-y-2">
              {results.data.map((h) => (
                <li key={h.messageId}>
                  <Link href={chatHref(h.pairingId, h.name)} className="block rounded-xl border-2 border-input bg-card p-3 hover:bg-secondary">
                    <span className="block text-lg font-semibold">{h.name}</span>
                    <span dir="auto" className="block text-lg">{h.excerpt}</span>
                    {h.at && <span className="block text-base text-muted-foreground">{timeAgo(h.at)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The inbox for a patient or an approved doctor: only their own conversations, newest first, with what is unread. */
export default function MessagesList({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const isDoctor = user.role === "doctor";
  const query = useQuery<Inbox>({ queryKey: ["/api/conversations"], refetchInterval: 20_000 });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">{t("pt.messages")}</h1>
        <p className="text-lg text-muted-foreground">{isDoctor ? t("msg.subtitle.doctor") : t("pt.msgs.subtitle")}</p>
      </div>
      <QueryState
        query={query}
        isEmpty={(d) => d.conversations.length === 0}
        empty={
          <EmptyBlock
            title={t("pt.msgs.emptyTitle")}
            action={isDoctor ? undefined : <Button asChild size="lg"><Link href="/symptoms">{t("home.findDoctor")}</Link></Button>}
          >
            {isDoctor ? t("msg.empty.doctor") : t("pt.msgs.emptyBody")}
          </EmptyBlock>
        }
        loadingLabel={t("pt.msgs.loading")}
      >
        {(d) => (
          <>
            <p role="status" className="text-lg font-medium">{d.unreadTotal > 0 ? t("msg.unreadTotal", { count: d.unreadTotal }) : t("msg.allRead")}</p>
            <ul className="space-y-3">{d.conversations.map((c) => <ConversationRow key={c.pairingId} c={c} />)}</ul>
            <SearchBox />
          </>
        )}
      </QueryState>
      <p className="text-base text-muted-foreground">{t("msg.notEmergency")}</p>
    </div>
  );
}
