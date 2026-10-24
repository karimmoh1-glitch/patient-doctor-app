import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, Pill, ClipboardList, Truck, FileText, MessageCircle, ListChecks } from "lucide-react";
import { formatDate, formatTime } from "@/lib/format";

interface TimelineEvent {
  date: string;
  kind: "appointment" | "prescription" | "medication" | "pharmacy" | "document" | "message" | "follow_up";
  title: string;
  subtitle?: string;
  link?: string;
}

const ICONS: Record<TimelineEvent["kind"], React.ComponentType<{ className?: string }>> = {
  appointment: CalendarDays,
  prescription: ClipboardList,
  medication: Pill,
  pharmacy: Truck,
  document: FileText,
  message: MessageCircle,
  follow_up: ListChecks,
};

// A restrained, purposeful color per event type — not decoration, a
// scanning aid so a dense day (visit + prescription + pharmacy update) is
// still easy to tell apart at a glance.
const MARKER_STYLES: Record<TimelineEvent["kind"], string> = {
  appointment: "bg-primary",
  prescription: "bg-violet-500",
  medication: "bg-sky-500",
  pharmacy: "bg-amber-500",
  document: "bg-slate-400",
  message: "bg-emerald-500",
  follow_up: "bg-rose-500",
};

export default function Timeline() {
  const { data: events, isLoading } = useQuery<TimelineEvent[]>({ queryKey: ["/api/timeline"] });

  const grouped = new Map<string, TimelineEvent[]>();
  for (const e of events || []) {
    const key = formatDate(e.date);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Health timeline</h1>
        <p className="text-sm text-muted-foreground">Your care, all in one continuous story.</p>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!isLoading && (events?.length ?? 0) === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">Nothing here yet. As you connect with doctors, get prescriptions, and track medications, your story will appear here.</p>
        </div>
      )}

      <div className="space-y-8">
        {Array.from(grouped.entries()).map(([day, dayEvents], groupIndex) => (
          <div key={day} className="relative border-l-2 border-border pl-6">
            <p className="mb-3 text-base font-semibold text-muted-foreground">{day}</p>
            <div className="space-y-5">
              {dayEvents.map((e, i) => {
                const Icon = ICONS[e.kind];
                const content = (
                  <div className="relative flex gap-3">
                    <span className={`absolute -left-[29px] flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-background ${MARKER_STYLES[e.kind]}`}>
                      <Icon className="h-3 w-3 text-white" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-lg font-semibold leading-snug">{e.title}</p>
                      {e.subtitle && <p className="text-base text-muted-foreground">{e.subtitle}</p>}
                      <p className="text-sm text-muted-foreground">{formatTime(e.date)}</p>
                    </div>
                  </div>
                );
                return e.link ? (
                  <Link key={i} href={e.link} className="block rounded-md transition-colors hover:bg-black/[0.02]">{content}</Link>
                ) : (
                  <div key={i}>{content}</div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
