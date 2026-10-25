import { Link } from "wouter";
import { ArrowRight, Stethoscope, UserRound } from "lucide-react";
import PublicLayout from "@/components/public-layout";
import PageHeader from "@/components/page-header";
import { useI18n } from "@/lib/i18n";

// The first real choice. It decides which registration, which profile, which
// permissions and which workspace a person gets: it is not a cosmetic toggle.
export default function GetStarted() {
  const { t } = useI18n();
  const cards = [
    { href: "/signup", icon: UserRound, tone: "bg-secondary text-primary", title: t("landing.patient.title"), body: t("auth.start.patient"), cta: t("landing.patient.cta") },
    { href: "/join/doctor", icon: Stethoscope, tone: "bg-sand text-sand-foreground", title: t("landing.doctor.title"), body: t("auth.start.doctor"), cta: t("landing.doctor.cta") },
  ];
  return (
    <PublicLayout>
      <div className="space-y-8">
        <PageHeader title={t("auth.start.title")} description={t("auth.start.intro")} />
        <div className="grid gap-5 md:grid-cols-2">
          {cards.map((c) => (
            <Link key={c.href} href={c.href} className="group flex flex-col gap-4 rounded-3xl border-2 border-border bg-card p-7 shadow-soft transition-shadow hover:shadow-lift">
              <span className={`flex h-14 w-14 items-center justify-center rounded-2xl ${c.tone}`}><c.icon className="h-7 w-7" aria-hidden="true" /></span>
              <span className="font-display text-2xl font-semibold">{c.title}</span>
              <span className="text-lg text-muted-foreground">{c.body}</span>
              <span className="mt-auto inline-flex items-center gap-2 text-lg font-semibold text-primary">{c.cta} <ArrowRight className="h-5 w-5 flip-rtl" aria-hidden="true" /></span>
            </Link>
          ))}
        </div>
        <p className="text-lg">
          {t("auth.start.have")}{" "}
          <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">{t("public.signIn")}</Link>
        </p>
      </div>
    </PublicLayout>
  );
}
