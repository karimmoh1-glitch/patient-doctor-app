import { Link } from "wouter";
import { CalendarCheck, Globe2, HeartPulse, MessageCircle, Pill, Search, ShieldCheck, Stethoscope, UserRound, Accessibility, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import PublicLayout from "@/components/public-layout";
import { useI18n, type MessageKey } from "@/lib/i18n";

// Decorative only: two arches (the Avela doorway) joined by a thin line, one
// for the person seeking care and one for the clinician. It is deliberately
// abstract: no invented doctors, patients, appointments or statistics.
function HeroArt() {
  return (
    <svg viewBox="0 0 480 440" className="h-auto w-full max-w-md" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sage" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#D5E5DC" />
          <stop offset="1" stopColor="#E9F0EB" />
        </linearGradient>
      </defs>
      <circle cx="240" cy="220" r="200" fill="#F4EBDD" />
      <path d="M70 380V210a95 95 0 0 1 190 0v170z" fill="url(#sage)" />
      <path d="M250 380V250a80 80 0 0 1 160 0v130z" fill="#0E5A4F" />
      <path d="M110 380V215a55 55 0 0 1 110 0v165" fill="none" stroke="#0E5A4F" strokeWidth="10" strokeLinecap="round" />
      <path d="M290 380V255a40 40 0 0 1 80 0v125" fill="none" stroke="#FBFAF6" strokeWidth="10" strokeLinecap="round" />
      <circle cx="165" cy="238" r="16" fill="#C58A3A" />
      <circle cx="330" cy="268" r="14" fill="#E0A94F" />
      <path d="M181 238C230 190 270 190 316 262" fill="none" stroke="#C58A3A" strokeWidth="3" strokeDasharray="2 9" strokeLinecap="round" />
      <path d="M40 380h400" stroke="#0E5A4F" strokeWidth="4" strokeLinecap="round" opacity=".25" />
    </svg>
  );
}

const STEPS: { icon: typeof Search; title: MessageKey; body: MessageKey }[] = [
  { icon: Search, title: "landing.step1.title", body: "landing.step1.body" },
  { icon: CalendarCheck, title: "landing.step2.title", body: "landing.step2.body" },
  { icon: HeartPulse, title: "landing.step3.title", body: "landing.step3.body" },
];

const FEATURES: { icon: typeof Search; title: MessageKey; body: MessageKey }[] = [
  { icon: Search, title: "landing.f1.title", body: "landing.f1.body" },
  { icon: CalendarCheck, title: "landing.f2.title", body: "landing.f2.body" },
  { icon: MessageCircle, title: "landing.f3.title", body: "landing.f3.body" },
  { icon: Pill, title: "landing.f4.title", body: "landing.f4.body" },
  { icon: Globe2, title: "landing.f5.title", body: "landing.f5.body" },
  { icon: Accessibility, title: "landing.f6.title", body: "landing.f6.body" },
];

export default function Landing() {
  const { t } = useI18n();
  return (
    <PublicLayout wide>
      <div className="space-y-20 pb-8 md:space-y-28">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="grid items-center gap-10 pt-2 md:grid-cols-[1.15fr_1fr] md:pt-8">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-1.5 text-base font-semibold text-primary">
              <Globe2 className="h-4 w-4" aria-hidden="true" /> {t("landing.eyebrow")}
            </p>
            <h1 id="hero-title" className="font-display text-5xl font-semibold leading-[1.05] md:text-6xl">
              {t("landing.title")}
            </h1>
            <p className="max-w-xl text-xl text-muted-foreground">{t("landing.subtitle")}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg"><Link href="/find-doctors"><Search aria-hidden="true" /> {t("landing.cta.find")}</Link></Button>
              <Button asChild size="lg" variant="outline"><Link href="/join/doctor"><Stethoscope aria-hidden="true" /> {t("landing.cta.join")}</Link></Button>
            </div>
            <p className="max-w-xl text-base text-muted-foreground">{t("landing.browseNote")}</p>
          </div>
          <div className="flex justify-center md:justify-end"><HeroArt /></div>
        </section>

        {/* Two clear paths */}
        <section aria-labelledby="paths-title" className="space-y-6">
          <h2 id="paths-title" className="font-display text-3xl font-semibold md:text-4xl">{t("landing.paths.title")}</h2>
          <div className="grid gap-5 md:grid-cols-2">
            <Link href="/signup" className="group flex flex-col gap-4 rounded-3xl border-2 border-border bg-card p-7 shadow-soft transition-shadow hover:shadow-lift">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-primary"><UserRound className="h-7 w-7" aria-hidden="true" /></span>
              <span className="font-display text-2xl font-semibold">{t("landing.patient.title")}</span>
              <span className="text-lg text-muted-foreground">{t("landing.patient.body")}</span>
              <span className="mt-auto inline-flex items-center gap-2 text-lg font-semibold text-primary">{t("landing.patient.cta")} <ArrowRight className="h-5 w-5 flip-rtl transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1" aria-hidden="true" /></span>
            </Link>
            <Link href="/join/doctor" className="group flex flex-col gap-4 rounded-3xl border-2 border-border bg-card p-7 shadow-soft transition-shadow hover:shadow-lift">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sand text-sand-foreground"><Stethoscope className="h-7 w-7" aria-hidden="true" /></span>
              <span className="font-display text-2xl font-semibold">{t("landing.doctor.title")}</span>
              <span className="text-lg text-muted-foreground">{t("landing.doctor.body")}</span>
              <span className="mt-auto inline-flex items-center gap-2 text-lg font-semibold text-primary">{t("landing.doctor.cta")} <ArrowRight className="h-5 w-5 flip-rtl transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1" aria-hidden="true" /></span>
            </Link>
          </div>
        </section>

        {/* How it works */}
        <section id="how" aria-labelledby="how-title" className="space-y-8">
          <h2 id="how-title" className="font-display text-3xl font-semibold md:text-4xl">{t("landing.how.title")}</h2>
          <ol className="grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-3xl bg-sand/60 p-7">
                <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-primary font-display text-xl font-semibold text-primary-foreground" aria-hidden="true">{i + 1}</span>
                <h3 className="mb-2 font-display text-2xl font-semibold">{t(s.title)}</h3>
                <p className="text-lg text-muted-foreground">{t(s.body)}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* What works today */}
        <section aria-labelledby="features-title" className="space-y-8">
          <div className="max-w-2xl space-y-2">
            <h2 id="features-title" className="font-display text-3xl font-semibold md:text-4xl">{t("landing.features.title")}</h2>
            <p className="text-lg text-muted-foreground">{t("landing.features.intro")}</p>
          </div>
          <ul className="grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-4">
                <span className="mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><f.icon className="h-6 w-6" aria-hidden="true" /></span>
                <div>
                  <h3 className="text-xl font-semibold">{t(f.title)}</h3>
                  <p className="text-muted-foreground">{t(f.body)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Trust, said plainly */}
        <section aria-labelledby="trust-title" className="grid gap-8 rounded-3xl bg-primary p-8 text-primary-foreground md:grid-cols-[1fr_1.2fr] md:p-12">
          <div className="space-y-4">
            <ShieldCheck className="h-10 w-10 text-[#E0A94F]" aria-hidden="true" />
            <h2 id="trust-title" className="font-display text-3xl font-semibold text-primary-foreground md:text-4xl">{t("landing.trust.title")}</h2>
            <p className="text-lg text-primary-foreground/90">{t("landing.trust.intro")}</p>
          </div>
          <ul className="space-y-4 text-lg">
            {(["landing.trust.1", "landing.trust.2", "landing.trust.3", "landing.trust.4", "landing.trust.5"] as const).map((k) => (
              <li key={k} className="flex gap-3"><span className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-[#E0A94F]" aria-hidden="true" /><span>{t(k)}</span></li>
            ))}
          </ul>
        </section>

        {/* What isn't here yet */}
        <section aria-labelledby="notyet-title" className="space-y-4">
          <h2 id="notyet-title" className="font-display text-2xl font-semibold md:text-3xl">{t("landing.notyet.title")}</h2>
          <p className="max-w-3xl text-lg text-muted-foreground">{t("landing.notyet.body")}</p>
        </section>

        {/* Final call */}
        <section aria-labelledby="final-title" className="space-y-5 rounded-3xl border-2 border-border bg-card p-8 text-center shadow-soft md:p-12">
          <h2 id="final-title" className="font-display text-3xl font-semibold md:text-4xl">{t("landing.final.title")}</h2>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild size="lg"><Link href="/signup">{t("landing.final.patient")}</Link></Button>
            <Button asChild size="lg" variant="outline"><Link href="/join/doctor">{t("landing.final.doctor")}</Link></Button>
          </div>
        </section>
      </div>
    </PublicLayout>
  );
}
