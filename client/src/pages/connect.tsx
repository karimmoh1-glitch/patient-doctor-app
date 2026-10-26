import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Camera } from "lucide-react";
import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form-field";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate } from "@/lib/format";
import { languageName, specialtyLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

const PENDING_KEY = "avela.pending-connect";

interface Preview {
  expiresAt: string;
  alreadyConnected: boolean;
  organizations?: string[];
  doctor: { name: string; specialty: string; state: string; languages: string[]; clinic: string | null; licence: { how: string | null; checkedAt: string | null; validUntil: string | null } | null };
}
type Presented = { token: string } | { code: string };

/** A pending code is held only for this browser tab, so signing in does not lose it. It is removed as soon as it is used. */
export const pendingConnect = {
  get(): Presented | null {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      return raw ? (JSON.parse(raw) as Presented) : null;
    } catch {
      return null;
    }
  },
  set(p: Presented) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* the code can still be typed again */ }
  },
  clear() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* nothing to clear */ }
  },
};

function tokenFromText(text: string): string | null {
  const m = text.match(/#([A-Za-z0-9_-]{40,60})\s*$/);
  return m ? m[1] : null;
}

function Scanner({ onFound }: { onFound: (token: string) => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    (async () => {
      try {
        const Detector = (window as any).BarcodeDetector;
        const detector = new Detector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            for (const f of found) {
              const token = tokenFromText(String(f.rawValue));
              if (token) {
                onFound(token);
                return;
              }
            }
          } catch { /* keep looking */ }
          setTimeout(tick, 300);
        };
        tick();
      } catch {
        setError(t("conn.camera.denied"));
        setActive(false);
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [active, onFound, t]);
  if (typeof window === "undefined" || !("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) return <p className="text-base text-muted-foreground">{t("conn.camera.unsupported")}</p>;
  return (
    <div className="space-y-3">
      {!active ? <Button size="lg" variant="outline" onClick={() => { setError(null); setActive(true); }}><Camera aria-hidden="true" /> {t("conn.camera.start")}</Button> : (
        <>
          <video ref={video} className="w-full max-w-sm rounded-xl border-2 border-input" playsInline muted aria-label={t("conn.camera.label")} />
          <Button variant="outline" onClick={() => setActive(false)}>{t("conn.camera.stop")}</Button>
        </>
      )}
      {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
    </div>
  );
}

export default function Connect({ user }: { user: AuthUser | null }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [presented, setPresented] = useState<Presented | null>(null);
  const [typed, setTyped] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ pairingId: string; name: string } | null>(null);
  const [declined, setDeclined] = useState(false);

  // The token arrives in the URL fragment so it is never sent to a server by opening the page. Take it, then remove it from the address bar.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    let found: Presented | null = /^[A-Za-z0-9_-]{40,60}$/.test(fromHash) ? { token: fromHash } : pendingConnect.get();
    if (fromHash) history.replaceState(null, "", window.location.pathname);
    if (found) {
      pendingConnect.set(found);
      setPresented(found);
    }
  }, []);

  async function look(p: Presented) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await apiRequest("POST", "/api/pairing-invitations/preview", p);
      setPreview((await res.json()) as Preview);
      setPresented(p);
      pendingConnect.set(p);
    } catch (err: any) {
      setError(err.message);
      pendingConnect.clear();
      setPresented(null);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (user?.role === "patient" && presented && !preview && !busy && !error && !done) look(presented);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, presented]);

  async function confirm() {
    if (!presented) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest("POST", "/api/pairing-invitations/accept", { ...presented, confirm: true });
      const body = await res.json();
      pendingConnect.clear();
      queryClient.invalidateQueries();
      setDone({ pairingId: body.pairingId, name: preview?.doctor.name ?? "" });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    try { sessionStorage.setItem("pdapp_return_to", "/connect"); } catch { /* the code is still kept */ }
    return (
      <div className="mx-auto max-w-xl space-y-6 p-4">
        <PageHeader title={t("conn.title")} description={t("conn.signin.intro")} />
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/login">{t("conn.signin.login")}</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/signup">{t("conn.signin.signup")}</Link></Button>
        </div>
        <p className="text-base text-muted-foreground">{t("conn.signin.note")}</p>
      </div>
    );
  }
  if (user.role !== "patient") {
    return <div className="mx-auto max-w-xl p-4"><PageHeader title={t("conn.title")} description={t("conn.patientsOnly")} /></div>;
  }

  if (done) {
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <PageHeader title={t("conn.done.title", { name: done.name })} description={t("conn.done.body")} />
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href={`/chat/${done.pairingId}?with=${encodeURIComponent(done.name)}`}>{t("conn.done.message")}</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/care-team">{t("conn.done.team")}</Link></Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title={t("conn.title")} description={t("conn.intro")} />
      {declined && <p role="status" className="rounded-xl border-2 border-input bg-card p-4 text-lg">{t("conn.declined")}</p>}
      {preview ? (
        <section aria-labelledby="conn-who" className="space-y-4 rounded-2xl border-2 border-input bg-card p-5">
          <h2 id="conn-who" className="font-display text-2xl">{preview.doctor.name}</h2>
          <p className="text-lg">{specialtyLabel(t, preview.doctor.specialty)} · {preview.doctor.state}{preview.doctor.clinic ? ` · ${preview.doctor.clinic}` : ""}</p>
          {preview.doctor.languages.length > 0 && <p className="text-base text-muted-foreground">{t("conn.languages", { list: preview.doctor.languages.map(languageName).join(", ") })}</p>}
          <p className="flex items-start gap-2 rounded-xl bg-secondary p-3 text-base">
            <BadgeCheck className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <span>{preview.doctor.licence ? t("conn.licence.checked", { how: preview.doctor.licence.how ? t(`admin.verify.source.${preview.doctor.licence.how}` as MessageKey) : "", date: preview.doctor.licence.validUntil ? formatDate(preview.doctor.licence.validUntil) : "" }) : t("conn.licence.none")}</span>
          </p>
          <p className="text-base text-muted-foreground">{t("conn.licence.limits")}</p>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">{t("conn.permits.title")}</h3>
            <ul className="list-disc space-y-1 ps-6 text-lg"><li>{t("conn.permits.1")}</li><li>{t("conn.permits.2")}</li><li>{t("conn.permits.3")}</li></ul>
            <p className="text-base text-muted-foreground">{t("conn.permits.not")}</p>
          </div>
          {preview.organizations && preview.organizations.length > 0 && (
            <p className="rounded-xl border-2 border-input p-3 text-base">{t("conn.orgs", { list: preview.organizations.join(", ") })}</p>
          )}
          {preview.alreadyConnected && <p role="status" className="font-medium">{t("conn.already")}</p>}
          {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={confirm} disabled={busy}>{busy ? t("common.saving") : t("conn.confirm", { name: preview.doctor.name })}</Button>
            <Button size="lg" variant="outline" onClick={() => { pendingConnect.clear(); setPreview(null); setPresented(null); setDeclined(true); }} disabled={busy}>{t("conn.decline")}</Button>
          </div>
          <p className="text-base text-muted-foreground">{t("conn.expires", { date: new Date(preview.expiresAt).toLocaleTimeString() })}</p>
        </section>
      ) : (
        <section aria-labelledby="conn-enter" className="space-y-4 rounded-2xl border-2 border-input bg-card p-5">
          <h2 id="conn-enter" className="font-display text-2xl">{t("conn.enter.title")}</h2>
          <form onSubmit={(e) => { e.preventDefault(); setDeclined(false); look({ code: typed }); }} className="space-y-3" noValidate>
            <Field id="conn-code" label={t("conn.enter.label")} hint={t("conn.enter.hint")} error={error}>
              {(a) => <Input {...a} dir="ltr" className="text-2xl tracking-widest rtl:text-end" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={12} value={typed} onChange={(e) => setTyped(e.target.value)} />}
            </Field>
            <Button type="submit" size="lg" disabled={busy || typed.replace(/[^A-Za-z0-9]/g, "").length < 8}>{busy ? t("common.saving") : t("conn.enter.check")}</Button>
          </form>
          <Scanner onFound={(token) => { setDeclined(false); look({ token }); }} />
          <p className="text-base text-muted-foreground">{t("conn.nothingYet")}</p>
        </section>
      )}
    </div>
  );
}

void Ltr;
