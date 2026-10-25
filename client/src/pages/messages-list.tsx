import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface Pairing {
  id: string;
  status: string;
  doctor: { id: string; name: string; specialty: string } | null;
}

interface ChatMessage {
  id: string;
  senderUserId: string;
  body: string;
  createdAt: string;
}

function ThreadRow({ pairing, user }: { pairing: Pairing; user: AuthUser }) {
  const { t } = useI18n();
  const { data: messages } = useQuery<ChatMessage[]>({ queryKey: [`/api/pairings/${pairing.id}/messages`] });
  const last = messages?.[messages.length - 1];
  const name = pairing.doctor?.name ?? t("pt.doctor");

  return (
    <li>
      <Link
        href={`/chat/${pairing.id}?with=${encodeURIComponent(name)}`}
        className="flex min-h-20 items-center gap-4 rounded-xl border-2 border-input bg-card p-4 hover:bg-secondary"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-semibold">{name}</span>
          <span className="block text-muted-foreground">{pairing.doctor ? specialtyLabel(t, pairing.doctor.specialty) : ""}</span>
          <span className="mt-1 block truncate text-lg">
            {last ? (last.senderUserId === user.id ? t("pt.msgs.you", { body: last.body }) : last.body) : <em className="text-muted-foreground">{t("pt.msgs.none")}</em>}
          </span>
        </span>
        {last && <span className="shrink-0 text-muted-foreground">{timeAgo(last.createdAt)}</span>}
        <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground flip-rtl" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default function MessagesList({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const query = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">{t("pt.messages")}</h1>
        <p className="text-lg text-muted-foreground">{t("pt.msgs.subtitle")}</p>
      </div>
      <QueryState
        query={query}
        isEmpty={(all) => !all.some((p) => p.status === "accepted")}
        empty={
          <EmptyBlock title={t("pt.msgs.emptyTitle")} action={<Button asChild size="lg"><Link href="/symptoms">{t("home.findDoctor")}</Link></Button>}>
            {t("pt.msgs.emptyBody")}
          </EmptyBlock>
        }
        loadingLabel={t("pt.msgs.loading")}
      >
        {(all) => (
          <ul className="space-y-3">
            {all.filter((p) => p.status === "accepted").map((p) => <ThreadRow key={p.id} pairing={p} user={user} />)}
          </ul>
        )}
      </QueryState>
    </div>
  );
}
