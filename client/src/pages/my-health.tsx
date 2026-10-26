import { Link } from "wouter";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { Pill, ClipboardList, History, FileText, Users, ShieldCheck, ChevronRight, HeartPulse, BellRing } from "lucide-react";

type Icon = React.ComponentType<{ className?: string }>;

const SECTIONS: { id: string; headingKey: MessageKey; items: { href: string; labelKey: MessageKey; hintKey: MessageKey; icon: Icon }[] }[] = [
  {
    id: "mine",
    headingKey: "myhealth.sec.mine",
    items: [{ href: "/health-profile", labelKey: "hp.title", hintKey: "myhealth.hint.profileInfo", icon: HeartPulse }],
  },
  {
    id: "medicines",
    headingKey: "myhealth.sec.medicines",
    items: [
      { href: "/medications", labelKey: "health.todaysMedicines", hintKey: "myhealth.hint.medications", icon: Pill },
      { href: "/my-reminders", labelKey: "rem.nav", hintKey: "myhealth.hint.reminders", icon: BellRing },
      { href: "/prescriptions", labelKey: "health.prescriptions", hintKey: "myhealth.hint.prescriptions", icon: ClipboardList },
    ],
  },
  {
    id: "records",
    headingKey: "myhealth.sec.records",
    items: [
      { href: "/timeline", labelKey: "timeline.title", hintKey: "myhealth.hint.timeline", icon: History },
      { href: "/documents", labelKey: "docs.title", hintKey: "myhealth.hint.documents", icon: FileText },
    ],
  },
  {
    id: "people",
    headingKey: "myhealth.sec.people",
    items: [
      { href: "/care-circle", labelKey: "circle.title", hintKey: "myhealth.hint.circle", icon: Users },
      { href: "/profile", labelKey: "profile.title", hintKey: "myhealth.hint.profile", icon: ShieldCheck },
    ],
  },
];

export default function MyHealth() {
  const { t } = useI18n();
  const sections = SECTIONS;
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">{t("myhealth.title")}</h1>
        <p className="text-muted-foreground">{t("myhealth.intro")}</p>
      </div>
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`h-${section.id}`} className="space-y-3">
          <h2 id={`h-${section.id}`} className="text-xl font-semibold">{t(section.headingKey)}</h2>
          <ul className="space-y-3">
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="flex min-h-20 items-center gap-4 rounded-xl border-2 border-input bg-card p-4 transition-colors hover:bg-secondary"
                  >
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                      <Icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-semibold">{t(item.labelKey)}</span>
                      <span className="block text-muted-foreground">{t(item.hintKey)}</span>
                    </span>
                    <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground flip-rtl" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
