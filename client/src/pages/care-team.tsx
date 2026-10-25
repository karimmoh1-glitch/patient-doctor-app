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
import { useI18n } from "@/lib/i18n";
import { specialtyLabel } from "@/lib/labels";

interface Pairing {
  id: string;
  status: string;
  requestedAt: string;
  relationshipLabel: string | null;
  doctor: { id: string; name: string; specialty: string; state: string; bio: string | null; phone: string | null } | null;
}

export default function CareTeam() {
  const { t } = useI18n();
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
      toast({ title: t("pt.saveFail"), description: err.message, variant: "destructive" });
    }
  }

  // The link sits inside the sentence, so its position comes from the translation.
  const [privacyBefore, privacyAfter] = t("pt.team.privacy").split("{link}");

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">{t("pt.myDoctors")}</h1>
          <p className="text-muted-foreground">{t("pt.team.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline"><Link href="/messages"><MessageCircle aria-hidden="true" /> {t("pt.messages")}</Link></Button>
          <Button asChild><Link href="/symptoms"><Search aria-hidden="true" /> {t("home.findDoctor")}</Link></Button>
        </div>
      </div>

      <QueryState
        query={query}
        isEmpty={(all) => !all.some((p) => p.status === "accepted" || p.status === "requested")}
        empty={
          <EmptyBlock
            title={t("pt.team.noDoctor")}
            action={<Button asChild size="lg"><Link href="/symptoms">{t("home.findDoctor")}</Link></Button>}
          >
            {t("pt.team.noDoctorBody")}
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
                  <h2 id="connected-heading" className="text-xl font-semibold">{t("pt.team.yours")}</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    {accepted.map((p) => (
                      <Card key={p.id}>
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <CardTitle as="h3" className="text-xl">{p.doctor?.name ?? t("pt.doctor")}</CardTitle>
                            <StatusBadge kind="pairing" status={p.status} />
                          </div>
                          {editingId === p.id ? (
                            <div className="flex flex-wrap items-end gap-2">
                              <div className="space-y-1">
                                <Label htmlFor={`label-${p.id}`}>{t("pt.team.labelQ")}</Label>
                                <Input id={`label-${p.id}`} autoFocus value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} placeholder={t("pt.team.labelPh")} onKeyDown={(e) => e.key === "Enter" && saveLabel(p.id)} />
                              </div>
                              <Button onClick={() => saveLabel(p.id)}>{t("common.save")}</Button>
                              <Button variant="outline" onClick={() => setEditingId(null)}>{t("common.cancel")}</Button>
                            </div>
                          ) : (
                            <button
                              className="flex min-h-11 items-center gap-2 text-start text-base text-muted-foreground hover:text-foreground"
                              onClick={() => { setEditingId(p.id); setLabelDraft(p.relationshipLabel || ""); }}
                            >
                              {p.relationshipLabel || (p.doctor ? specialtyLabel(t, p.doctor.specialty) : "")}
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                              <span className="sr-only">{t("pt.team.changeLabel")}</span>
                            </button>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex flex-wrap gap-3">
                            {p.doctor?.phone && (
                              <Button asChild variant="outline">
                                <a href={`tel:${p.doctor.phone}`}><Phone aria-hidden="true" /> {t("pt.team.call")}</a>
                              </Button>
                            )}
                            <Button asChild variant="outline">
                              <Link href={`/chat/${p.id}?with=${encodeURIComponent(p.doctor?.name ?? t("pt.yourDoctor"))}`}><MessageCircle aria-hidden="true" /> {t("pt.team.message")}</Link>
                            </Button>
                            <Button asChild>
                              <Link href={`/appointments?book=${p.id}`}><CalendarPlus aria-hidden="true" /> {t("home.book")}</Link>
                            </Button>
                          </div>
                          <ConfirmAction
                            trigger={<Button variant="ghost" className="-ms-4 text-destructive hover:text-destructive">{t("pt.team.stop")}</Button>}
                            title={t("pt.team.stopTitle", { name: p.doctor?.name ?? "" })}
                            description={t("pt.team.stopBody", { name: p.doctor?.name ?? "" })}
                            confirmLabel={t("pt.team.stopYes")}
                            cancelLabel={t("pt.team.stopNo")}
                            destructive
                            onConfirm={() => act(`/api/pairings/${p.id}/end`, { title: t("status.pairing.ended"), description: t("pt.team.stoppedBody", { name: p.doctor?.name ?? "" }) }, t("pt.team.stopFail"))}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              )}

              {pending.length > 0 && (
                <section aria-labelledby="pending-heading" className="space-y-4">
                  <h2 id="pending-heading" className="text-xl font-semibold">{t("pt.team.waiting")}</h2>
                  <div className="grid gap-4 md:grid-cols-2">
                    {pending.map((p) => (
                      <Card key={p.id}>
                        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                          <div>
                            <CardTitle as="h3" className="text-xl">{p.doctor?.name ?? t("pt.doctor")}</CardTitle>
                            <CardDescription className="text-base">{p.doctor ? `${specialtyLabel(t, p.doctor.specialty)} · ${p.doctor.state}` : ""}</CardDescription>
                          </div>
                          <StatusBadge kind="pairing" status={p.status} />
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-muted-foreground">{t("pt.team.noAnswer")}</p>
                          <ConfirmAction
                            trigger={<Button variant="outline">{t("pt.team.cancelReq")}</Button>}
                            title={t("pt.team.cancelTitle")}
                            description={t("pt.team.cancelBody", { name: p.doctor?.name ?? "" })}
                            confirmLabel={t("pt.yesCancel")}
                            cancelLabel={t("pt.team.cancelNo")}
                            destructive
                            onConfirm={() => act(`/api/pairings/${p.id}/cancel`, { title: t("pt.team.cancelledTitle") }, t("pt.cancelFail"))}
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
        {privacyBefore}<Link href="/profile" className="font-medium text-primary underline underline-offset-4">{t("pt.team.privacyLink")}</Link>{privacyAfter}
      </p>
    </div>
  );
}
