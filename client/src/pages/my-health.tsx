import { Link } from "wouter";
import { useAppConfig } from "@/hooks/use-app-config";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { Pill, ClipboardList, Truck, History, FileText, Sparkles, HeartHandshake, Users, ShieldCheck, ChevronRight } from "lucide-react";

type Icon = React.ComponentType<{ className?: string }>;

const SECTIONS: { id: string; headingKey: MessageKey; items: { href: string; labelKey: MessageKey; hintKey: MessageKey; icon: Icon }[] }[] = [
  {
    id: "medicines",
    headingKey: "myhealth.sec.medicines",
    items: [
      { href: "/medications", labelKey: "health.todaysMedicines", hintKey: "myhealth.hint.medications", icon: Pill },
      { href: "/prescriptions", labelKey: "health.prescriptions", hintKey: "myhealth.hint.prescriptions", icon: ClipboardList },
      { href: "/pharmacy", labelKey: "pharmacy.title", hintKey: "myhealth.hint.pharmacy", icon: Truck },
    ],
  },
  {
    id: "records",
    headingKey: "myhealth.sec.records",
    items: [
      { href: "/timeline", labelKey: "timeline.title", hintKey: "myhealth.hint.timeline", icon: History },
      { href: "/documents", labelKey: "docs.title", hintKey: "myhealth.hint.documents", icon: FileText },
      { href: "/handoff", labelKey: "myhealth.item.handoff", hintKey: "myhealth.hint.handoff", icon: HeartHandshake },
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
  {
    id: "organising",
    headingKey: "myhealth.sec.organising",
    items: [
      { href: "/assistant", labelKey: "assistant.title", hintKey: "myhealth.hint.assistant", icon: Sparkles },
    ],
  },
];

export default function MyHealth() {
  const config = useAppConfig();
  const { t } = useI18n();
  // Pharmacy ordering is a simulation; it only appears in a demonstration.
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.href !== "/pharmacy" || config?.demoMode),
  }));
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
