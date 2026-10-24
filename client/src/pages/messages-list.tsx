import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
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
  const { data: messages } = useQuery<ChatMessage[]>({ queryKey: [`/api/pairings/${pairing.id}/messages`] });
  const last = messages?.[messages.length - 1];
  const name = pairing.doctor?.name ?? "Doctor";

  return (
    <li>
      <Link
        href={`/chat/${pairing.id}?with=${encodeURIComponent(name)}`}
        className="flex min-h-20 items-center gap-4 rounded-xl border-2 border-input bg-card p-4 hover:bg-secondary"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xl font-semibold">{name}</span>
          <span className="block text-muted-foreground">{pairing.doctor?.specialty}</span>
          <span className="mt-1 block truncate text-lg">
            {last ? `${last.senderUserId === user.id ? "You: " : ""}${last.body}` : <em className="text-muted-foreground">No messages yet</em>}
          </span>
        </span>
        {last && <span className="shrink-0 text-muted-foreground">{timeAgo(last.createdAt)}</span>}
        <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default function MessagesList({ user }: { user: AuthUser }) {
  const query = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Messages</h1>
        <p className="text-lg text-muted-foreground">For questions that can wait. Doctors reply when they can, which may take a day or more.</p>
      </div>
      <QueryState
        query={query}
        isEmpty={(all) => !all.some((p) => p.status === "accepted")}
        empty={
          <EmptyBlock title="You can message a doctor once they accept you" action={<Button asChild size="lg"><Link href="/symptoms">Find a doctor</Link></Button>}>
            When a doctor accepts your request, your conversation with them will be here.
          </EmptyBlock>
        }
        loadingLabel="Loading your messages"
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
