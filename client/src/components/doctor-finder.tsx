import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { BadgeCheck, CalendarClock, ChevronDown, Languages, MapPin, MessageCircle, Phone, Search, UserRound, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import StatusBadge from "@/components/status-badge";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import { formatRelativeDay } from "@/lib/format";
import { languageName, modalityLabel, specialtyLabel } from "@/lib/labels";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
import { CLINICIAN_LANGUAGES, MODALITIES } from "@shared/languages";

interface DoctorListing {
  id: string;
  name: string;
  specialty: string;
  state: string;
  bio: string | null;
  clinic: string | null;
  languages: string[];
  modalities: string[];
  yearsExperience: number | null;
  reviewedByAvela: boolean;
  nextAvailable: string | null;
  isDemoProfile?: boolean;
}
interface Pairing { id: string; status: string; doctor: { id: string } | null }

const MODALITY_ICON = { phone: Phone, messaging: MessageCircle, in_person: UserRound } as const;

/**
 * Searchable doctor directory. In "public" mode anyone can browse and the
 * action is to create an account; in "patient" mode the action is to ask the
 * doctor to connect. Filters run on the server against real profiles; nothing
 * here is made up, and a doctor with no published hours says so.
 */
export default function DoctorFinder({ mode, defaultState }: { mode: "public" | "patient"; defaultState?: string | null }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [language, setLanguage] = useState("");
  const [modality, setModality] = useState("");
  const [state, setState] = useState(defaultState ?? "");
  const [available, setAvailable] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // The first three filters are always shown; the rest start collapsed on a phone, to keep the page short.
  const [moreOpen, setMoreOpen] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches);

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (specialty) p.set("specialty", specialty);
    if (language) p.set("language", language);
    if (modality) p.set("modality", modality);
    if (state) p.set("state", state);
    if (available) p.set("available", "true");
    const qs = p.toString();
    return `/api/doctors${qs ? `?${qs}` : ""}`;
  }, [q, specialty, language, modality, state, available]);

  const doctors = useQuery<DoctorListing[]>({ queryKey: [url] });
  const pairings = useQuery<Pairing[]>({ queryKey: ["/api/pairings"], enabled: mode === "patient" });
  const statusByDoctor = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pairings.data ?? []) if (p.doctor) m.set(p.doctor.id, p.status);
    return m;
  }, [pairings.data]);

  const filtered = !!(q || specialty || language || modality || state || available);
  function clearFilters() {
    setQ(""); setSpecialty(""); setLanguage(""); setModality(""); setState(""); setAvailable(false);
  }

  async function connect(doctorProfileId: string) {
    setConnectingId(doctorProfileId);
    try {
      await apiRequest("POST", "/api/pairings", { doctorProfileId });
      queryClient.invalidateQueries({ queryKey: ["/api/pairings"] });
      toast({ title: t("dir.requestSent"), description: t("dir.requestSent.body") });
    } catch (err: any) {
      toast({ title: t("dir.requestFailed"), description: err.message, variant: "destructive" });
    } finally {
      setConnectingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <form role="search" aria-label={t("dir.filters")} onSubmit={(e) => e.preventDefault()} className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-soft">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="doc-search" className="text-base">{t("dir.search")}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="doc-search" className="ps-10" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-specialty" className="text-base">{t("dir.specialty")}</Label>
            <NativeSelect id="doc-specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
              <option value="">{t("dir.any")}</option>
              {SPECIALTIES.map((s) => <option key={s} value={s}>{specialtyLabel(t, s)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-language" className="text-base">{t("dir.language")}</Label>
            <NativeSelect id="doc-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="">{t("dir.any")}</option>
              {CLINICIAN_LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.native}</option>)}
            </NativeSelect>
          </div>
        </div>
        <details open={moreOpen} onToggle={(e) => setMoreOpen((e.currentTarget as HTMLDetailsElement).open)} className="group rounded-xl border border-border">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 text-base font-semibold hover:bg-secondary">
            {t("dir.more")}
            <ChevronDown className="h-5 w-5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="doc-modality" className="text-base">{t("dir.modality")}</Label>
            <NativeSelect id="doc-modality" value={modality} onChange={(e) => setModality(e.target.value)}>
              <option value="">{t("dir.any")}</option>
              {MODALITIES.map((m) => <option key={m} value={m}>{modalityLabel(t, m)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-state" className="text-base">{t("dir.state")}</Label>
            <NativeSelect id="doc-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">{t("dir.anyState")}</option>
              {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </NativeSelect>
          </div>
          <div className="flex items-end">
            <label className="flex min-h-12 cursor-pointer items-center gap-3 text-base font-medium">
              <input type="checkbox" className="h-6 w-6 shrink-0 accent-[#0E5A4F]" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
              {t("dir.availableOnly")}
            </label>
          </div>
          </div>
        </details>
        {filtered && (
          <Button type="button" variant="outline" size="sm" onClick={clearFilters}><X aria-hidden="true" /> {t("dir.clear")}</Button>
        )}
      </form>

      <QueryState query={doctors} loadingLabel={t("dir.loading")}>
        {(list) => (
          <>
            <p role="status" className="text-muted-foreground">{t("dir.count", { count: list.length })}</p>
            {list.length === 0 ? (
              <EmptyBlock
                title={t("dir.empty.title")}
                action={
                  <div className="flex flex-wrap justify-center gap-3">
                    {filtered && <Button variant="outline" onClick={clearFilters}>{t("dir.clear")}</Button>}
                    {mode === "patient" ? (
                      <Button asChild><Link href="/symptoms">{t("dir.empty.describe")}</Link></Button>
                    ) : (
                      <Button asChild><Link href="/signup">{t("dir.empty.signup")}</Link></Button>
                    )}
                  </div>
                }
              >
                {t("dir.empty.body")}
              </EmptyBlock>
            ) : (
              <ul className="grid gap-5 lg:grid-cols-2">
                {list.map((d) => {
                  const status = statusByDoctor.get(d.id);
                  const connected = status === "requested" || status === "accepted";
                  return (
                    <li key={d.id}>
                      <Card className="h-full">
                        <CardHeader>
                          <CardTitle as="h2" className="font-display text-2xl leading-snug">{d.name}</CardTitle>
                          <CardDescription className="text-base">
                            {specialtyLabel(t, d.specialty)}
                            {d.clinic ? ` · ${d.clinic}` : ""}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <ul className="space-y-1.5 text-base">
                            <li className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> {t("dir.licensedIn", { state: d.state })}</li>
                            {d.languages.length > 0 && (
                              <li className="flex items-center gap-2"><Languages className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <span><span className="sr-only">{t("dir.language")}: </span>{d.languages.map((c) => <span key={c} lang={c} className="me-2">{languageName(c)}</span>)}</span>
                              </li>
                            )}
                            {d.yearsExperience !== null && d.yearsExperience > 0 && (
                              <li className="text-muted-foreground">{t("dir.experience", { count: d.yearsExperience })}</li>
                            )}
                          </ul>
                          {d.modalities.length > 0 && (
                            <ul className="flex flex-wrap gap-2" aria-label={t("dir.modality")}>
                              {d.modalities.map((m) => {
                                const Icon = MODALITY_ICON[m as keyof typeof MODALITY_ICON] ?? UserRound;
                                return <li key={m}><Badge variant="outline" className="gap-1.5"><Icon className="h-4 w-4" aria-hidden="true" />{modalityLabel(t, m)}</Badge></li>;
                              })}
                            </ul>
                          )}
                          {d.bio && <p className="text-base">{d.bio}</p>}
                          <p className="flex items-start gap-2 text-base">
                            <CalendarClock className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            {d.nextAvailable ? t("dir.next", { when: formatRelativeDay(d.nextAvailable) }) : t("dir.noTimes")}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {d.reviewedByAvela && <Badge variant="secondary" className="gap-1.5"><BadgeCheck className="h-4 w-4" aria-hidden="true" />{t("dir.reviewed")}</Badge>}
                            {d.isDemoProfile && <Badge variant="outline">{t("dir.demoProfile")}</Badge>}
                          </div>
                          <div>
                            {mode === "public" ? (
                              <Button asChild size="lg"><Link href="/signup">{t("dir.signupToConnect")}<span className="sr-only">: {d.name}</span></Link></Button>
                            ) : connected && status ? (
                              <StatusBadge kind="pairing" status={status} />
                            ) : (
                              <Button size="lg" disabled={connectingId === d.id} onClick={() => connect(d.id)}>
                                {connectingId === d.id ? t("dir.sending") : t("dir.ask")}<span className="sr-only">: {d.name}</span>
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
            {list.some((d) => d.reviewedByAvela) && <p className="max-w-2xl text-base text-muted-foreground">{t("dir.reviewedNote")}</p>}
          </>
        )}
      </QueryState>
    </div>
  );
}
