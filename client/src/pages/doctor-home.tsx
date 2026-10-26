import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, CalendarX, ChevronRight, ClipboardCheck, Inbox, Pill, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/page-header";
import QueryState from "@/components/query-state";
import { formatRelativeDay, formatTime, greeting } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { appointmentTypeLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface Appt { id: string; type: string; scheduledAt: string; patientName: string; status: string }
interface DoctorDashboard {
  todaysAppointments: Appt[];
  upcomingAppointments: Appt[];
  pendingConnectionRequests: number;
  pendingAppointmentConfirmations: number;
  activePatients: number;
  activePrescriptionsWritten: number;
  draftPrescriptions: number;
  hasPublishedHours: boolean;
}

// A doctor's first screen is a short list of what needs them, then the day and
// the week ahead. Nothing here is invented: every row is a real record, and a
// quiet day says so.
export default function DoctorHome({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const query = useQuery<DoctorDashboard>({ queryKey: ["/api/dashboard/doctor"] });

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title={t("dhome.greeting", { greeting: greeting(), name: user.name.split(" ").pop() ?? "" })} description={t("dhome.subtitle")} />
      <QueryState query={query} loadingLabel={t("common.loading")}>
        {(d) => {
          const attention = [
            !d.hasPublishedHours && { href: "/doctor/availability", icon: CalendarX, text: t("dhome.att.noHours"), urgent: true },
            d.pendingConnectionRequests > 0 && { href: "/doctor/requests", icon: Inbox, text: t("dhome.att.requests", { count: d.pendingConnectionRequests }) },
            d.pendingAppointmentConfirmations > 0 && { href: "/doctor/appointments", icon: CalendarDays, text: t("dhome.att.confirm", { count: d.pendingAppointmentConfirmations }) },
            d.draftPrescriptions > 0 && { href: "/doctor/patients", icon: Pill, text: t("dhome.att.drafts", { count: d.draftPrescriptions }) },
          ].filter(Boolean) as { href: string; icon: typeof Inbox; text: string; urgent?: boolean }[];

          const row = (a: Appt, showDay: boolean) => (
            <li key={a.id} className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
              <div className="min-w-0">
                <p className="text-lg font-semibold">{a.patientName}</p>
                <p className="text-base text-muted-foreground">
                  {appointmentTypeLabel(t, a.type)} · {showDay ? formatRelativeDay(a.scheduledAt) : formatTime(a.scheduledAt)}
                </p>
              </div>
              <Button asChild size="sm" variant="outline"><Link href="/doctor/appointments">{t("dhome.manage")}</Link></Button>
            </li>
          );

          return (
            <>
              <section aria-labelledby="att-heading" className="space-y-3">
                <h2 id="att-heading" className="font-display text-2xl font-semibold">{t("dhome.att.title")}</h2>
                {attention.length === 0 ? (
                  <p className="rounded-2xl border border-border bg-card p-5 text-lg shadow-soft">{t("dhome.att.none")}</p>
                ) : (
                  <ul className="space-y-3">
                    {attention.map((a) => (
                      <li key={a.href + a.text}>
                        <Link href={a.href} className={`flex min-h-16 items-center gap-4 rounded-2xl border-2 bg-card p-4 shadow-soft hover:bg-secondary ${a.urgent ? "border-ochre" : "border-border"}`}>
                          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><a.icon className="h-6 w-6" aria-hidden="true" /></span>
                          <span className="min-w-0 flex-1 text-lg font-semibold">{a.text}</span>
                          <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground flip-rtl" aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  { icon: Users, label: t("dhome.activePatients"), value: d.activePatients, href: "/doctor/patients", cta: t("dhome.view") },
                  { icon: Inbox, label: t("dhome.pending"), value: d.pendingConnectionRequests, href: "/doctor/requests", cta: t("dhome.review") },
                  { icon: ClipboardCheck, label: t("dhome.rxActive"), value: d.activePrescriptionsWritten, href: "/doctor/patients", cta: t("dhome.view") },
                ].map((c) => (
                  <Card key={c.label}>
                    <CardHeader className="pb-2"><CardTitle as="h3" className="flex items-center gap-2 text-base font-medium text-muted-foreground"><c.icon className="h-4 w-4" aria-hidden="true" /> {c.label}</CardTitle></CardHeader>
                    <CardContent>
                      <p className="font-display text-3xl font-semibold">{c.value}</p>
                      <Button asChild variant="ghost" size="sm" className="-ms-3 text-primary"><Link href={c.href}>{c.cta}</Link></Button>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Card>
                <CardHeader><CardTitle as="h2" className="flex items-center gap-2 text-xl"><CalendarDays className="h-5 w-5 text-primary" aria-hidden="true" /> {t("dhome.today")}</CardTitle></CardHeader>
                <CardContent>
                  {d.todaysAppointments.length === 0 ? <p className="text-lg text-muted-foreground">{t("dhome.nothing")}</p> : <ul>{d.todaysAppointments.map((a) => row(a, false))}</ul>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle as="h2" className="text-xl">{t("dhome.upcoming")}</CardTitle></CardHeader>
                <CardContent>
                  {d.upcomingAppointments.length === 0 ? <p className="text-lg text-muted-foreground">{t("dhome.upcoming.none")}</p> : <ul>{d.upcomingAppointments.map((a) => row(a, true))}</ul>}
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-3">
                <Button asChild variant="outline"><Link href="/doctor/connect">{t("dconn.link")}</Link></Button>
                <Button asChild variant="outline"><Link href="/doctor/availability">{t("nav.d.hours")}</Link></Button>
                <Button asChild variant="outline"><Link href="/doctor/profile">{t("nav.d.profile")}</Link></Button>
              </div>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
