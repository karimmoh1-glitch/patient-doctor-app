import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Phone, MessageCircle, CalendarPlus, Pencil, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import StatusBadge from "@/components/status-badge";
import ConfirmAction from "@/components/confirm-action";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Pairing {
  id: string;
  status: string;
  requestedAt: string;
  relationshipLabel: string | null;
  doctor: { id: string; name: string; specialty: string; state: string; bio: string | null; phone: string | null } | null;
}

export default function CareTeam() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const query = useQuery<Pairing[]>({ queryKey: ["/api/pairings"] });

  async function act(path: string, success: { title: string; description?: string }, failure: string) {
    try {
      await apiRequest("PATCH", path);
      queryClient.invalidateQueries({ queryKey: ["/api/pairings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/appointments"] });
      toast(success);
    } catch (err: any) {
      toast({ title: failure, description: err.message, variant: "destructive" });
      throw err;
    }
  }

  async function saveLabel(id: string) {
    try {
      await apiRequest("PATCH", `/api/pairings/${id}/relationship-label`, { relationshipLabel: labelDraft.trim() || null });
      queryClient.invalidateQueries({ queryKey: ["/api/pairings"] });
      setEditingId(null);
    } catch (err: any) {
      toast({ title: "We couldn't save that", description: err.message, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">My doctors</h1>
          <p className="text-muted-foreground">The doctors who are looking after you.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline"><Link href="/messages"><MessageCircle aria-hidden="true" /> Messages</Link></Button>
          <Button asChild><Link href="/symptoms"><Search aria-hidden="true" /> Find a doctor</Link></Button>
        </div>
      </div>

      <QueryState
        query={query}
        isEmpty={(all) => !all.some((p) => p.status === "accepted" || p.status === "requested")}
        empty={
          <EmptyBlock
            title="You don't have a doctor yet"
            action={<Button asChild size="lg"><Link href="/symptoms">Find a doctor</Link></Button>}
          >
            Tell us what you need help with and we'll show you doctors in your state.
          </EmptyBlock>
        }
      >
        {(all) => {
          const accepted = all.filter((p) => p.status === "accepted");
          const pending = all.filter((p) => p.status === "requested");
          return (
            <>
              {accepted.length > 0 && (
                <section aria-labelledby="connected-heading" className="space-y-4">
                  <h2 id="connected-heading" className="text-xl font-semibold">Your doctors</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    {accepted.map((p) => (
                      <Card key={p.id}>
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <CardTitle as="h3" className="text-xl">{p.doctor?.name ?? "Doctor"}</CardTitle>
                            <StatusBadge kind="pairing" status={p.status} />
                          </div>
                          {editingId === p.id ? (
                            <div className="flex flex-wrap items-end gap-2">
                              <div className="space-y-1">
                                <Label htmlFor={`label-${p.id}`}>How would you describe this doctor?</Label>
                                <Input id={`label-${p.id}`} autoFocus value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} placeholder="For example: my family doctor" onKeyDown={(e) => e.key === "Enter" && saveLabel(p.id)} />
                              </div>
                              <Button onClick={() => saveLabel(p.id)}>Save</Button>
                              <Button variant="outline" onClick={() => setEditingId(null)}>Cancel</Button>
                            </div>
                          ) : (
                            <button
                              className="flex min-h-11 items-center gap-2 text-left text-base text-muted-foreground hover:text-foreground"
                              onClick={() => { setEditingId(p.id); setLabelDraft(p.relationshipLabel || ""); }}
                            >
                              {p.relationshipLabel || p.doctor?.specialty}
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              <span className="sr-only">Change how this doctor is described</span>
                            </button>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex flex-wrap gap-3">
                            {p.doctor?.phone && (
                              <Button asChild variant="outline">
                                <a href={`tel:${p.doctor.phone}`}><Phone aria-hidden="true" /> Call</a>
                              </Button>
                            )}
                            <Button asChild variant="outline">
                              <Link href={`/chat/${p.id}?with=${encodeURIComponent(p.doctor?.name ?? "your doctor")}`}><MessageCircle aria-hidden="true" /> Message</Link>
                            </Button>
                            <Button asChild>
                              <Link href={`/appointments?book=${p.id}`}><CalendarPlus aria-hidden="true" /> Book a visit</Link>
                            </Button>
                          </div>
                          <ConfirmAction
                            trigger={<Button variant="ghost" className="-ml-4 text-destructive hover:text-destructive">Stop sharing with this doctor</Button>}
                            title={`Stop sharing with ${p.doctor?.name}?`}
                            description={`${p.doctor?.name} will no longer be able to message you or see the symptoms you shared with them. Any visits you have booked with them will stay on your list until you cancel them. Your own records are not deleted. You can ask to connect again later.`}
                            confirmLabel="Yes, stop sharing"
                            cancelLabel="No, keep them"
                            destructive
                            onConfirm={() => act(`/api/pairings/${p.id}/end`, { title: "Sharing stopped", description: `${p.doctor?.name} can no longer see your information through Avela.` }, "We couldn't stop sharing")}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )}

              {pending.length > 0 && (
                <section aria-labelledby="pending-heading" className="space-y-4">
                  <h2 id="pending-heading" className="text-xl font-semibold">Waiting for a reply</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    {pending.map((p) => (
                      <Card key={p.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-xl">{p.doctor?.name ?? "Doctor"}</CardTitle>
                            <CardDescription className="text-base">{p.doctor?.specialty} · {p.doctor?.state}</CardDescription>
                          </div>
                          <StatusBadge kind="pairing" status={p.status} />
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-muted-foreground">This doctor hasn't answered yet. We don't know when they will.</p>
                          <ConfirmAction
                            trigger={<Button variant="outline">Cancel this request</Button>}
                            title="Cancel your request?"
                            description={`${p.doctor?.name} will no longer be able to see the symptoms you sent with it.`}
                            confirmLabel="Yes, cancel it"
                            cancelLabel="No, keep waiting"
                            destructive
                            onConfirm={() => act(`/api/pairings/${p.id}/cancel`, { title: "Request cancelled" }, "We couldn't cancel it")}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )}
            </>
          );
        }}
      </QueryState>

      <p className="text-muted-foreground">
        You decide what each doctor can see. Change it any time in{" "}
        <Link href="/profile" className="font-medium text-primary underline underline-offset-4">Profile &amp; Privacy</Link>.
      </p>
    </div>
  );
}
