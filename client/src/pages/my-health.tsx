import { Link } from "wouter";
import { useAppConfig } from "@/hooks/use-app-config";
import { Pill, ClipboardList, Truck, History, FileText, Sparkles, HeartHandshake, Users, ShieldCheck, ChevronRight } from "lucide-react";

const SECTIONS: { heading: string; items: { href: string; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] }[] = [
  {
    heading: "Medicines",
    items: [
      { href: "/medications", label: "Today's medicines", hint: "What to take, and when", icon: Pill },
      { href: "/prescriptions", label: "Prescriptions", hint: "From your doctors", icon: ClipboardList },
      { href: "/pharmacy", label: "Pharmacy", hint: "Practice ordering (demo only)", icon: Truck },
    ],
  },
  {
    heading: "Your records",
    items: [
      { href: "/timeline", label: "Health timeline", hint: "Everything, in date order", icon: History },
      { href: "/documents", label: "Documents", hint: "Reports and papers you saved", icon: FileText },
      { href: "/handoff", label: "Share a summary", hint: "Prepare a summary for a doctor or family", icon: HeartHandshake },
    ],
  },
  {
    heading: "People and privacy",
    items: [
      { href: "/care-circle", label: "Family and helpers", hint: "Who can see what you choose", icon: Users },
      { href: "/profile", label: "Profile & privacy", hint: "Your details and what doctors can see", icon: ShieldCheck },
    ],
  },
  {
    heading: "Help organising",
    items: [
      { href: "/assistant", label: "Questions about my care", hint: "Helps you find your own information. It does not give medical advice.", icon: Sparkles },
    ],
  },
];

export default function MyHealth() {
  const config = useAppConfig();
  // Pharmacy ordering is a simulation; it only appears in a demonstration.
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.href !== "/pharmacy" || config?.demoMode),
  }));
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl font-semibold">My health</h1>
        <p className="text-muted-foreground">Your medicines, records and who can see them.</p>
      </div>
      {sections.map((section) => (
        <section key={section.heading} aria-labelledby={`h-${section.heading}`} className="space-y-3">
          <h2 id={`h-${section.heading}`} className="text-xl font-semibold">{section.heading}</h2>
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
                      <span className="block text-lg font-semibold">{item.label}</span>
                      <span className="block text-muted-foreground">{item.hint}</span>
                    </span>
                    <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
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
