import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarDays, Pill, MessageCircle, ListChecks, Phone, Search, ChevronRight, Siren } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatusBadge from "@/components/status-badge";
import QueryState from "@/components/query-state";
import { greeting, formatRelativeDay, formatClock, timeAgo } from "@/lib/format";
import { EMERGENCY_NUMBER, EMERGENCY_TEL } from "@/lib/emergency";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { appointmentTypeLabel } from "@/lib/labels";
import type { AuthUser } from "@/hooks/use-auth";

interface DashboardData {
  upcomingAppointment: { id: string; doctorName: string; type: string; scheduledAt: string; status: string } | null;
  nextMedicationReminder: { medicationName: string; time: string } | null;
  dosesRemainingToday: number;
  recentDoctorMessage: { pairingId: string; doctorName: string; body: string; createdAt: string; fromDoctor: boolean } | null;
  outstandingFollowUp: { id: string; title: string; detail: string | null } | null;
  activePrescriptionsCount: number;
  careTeamCount: number;
}

const STATUS_HELP: Record<string, MessageKey> = {
  requested: "home.status.requested",
  confirmed: "home.status.confirmed",
};

function ToDoRow({ href, icon: Icon, title, detail }: { href: string; icon: React.ComponentType<{ className?: string }>; title: string; detail?: string }) {
  return (
    <li>
      <Link href={href} className="flex min-h-[4.5rem] items-center gap-4 rounded-xl border-2 border-input bg-card p-4 hover:bg-secondary">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-semibold">{title}</span>
          {detail && <span className="block text-muted-foreground">{detail}</span>}
        </span>
        <ChevronRight className="h-6 w-6 shrink-0 text-muted-foreground flip-rtl" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default function HomeDashboard({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const query = useQuery<DashboardData>({ queryKey: ["/api/dashboard"] });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h1 className="font-display text-3xl font-semibold md:text-4xl">{greeting()}, {user.name.split(" ")[0]}.</h1>

      <QueryState query={query} loadingLabel={t("home.loading")}>
        {(data) => {
          const todo: React.ReactNode[] = [];
          if (data.outstandingFollowUp) {
            todo.push(<ToDoRow key="fu" href="/timeline" icon={ListChecks} title={data.outstandingFollowUp.title} detail={data.outstandingFollowUp.detail ?? t("home.fromDoctor")} />);
          }
          if (data.nextMedicationReminder && data.dosesRemainingToday > 0) {
            todo.push(
              <ToDoRow
                key="med"
                href="/medications"
                icon={Pill}
                title={t("home.take", { name: data.nextMedicationReminder.medicationName })}
                detail={t("home.nextDose", { time: formatClock(data.nextMedicationReminder.time), count: data.dosesRemainingToday })}
              />,
            );
          }
          if (data.recentDoctorMessage?.fromDoctor) {
            todo.push(
              <ToDoRow key="msg" href={`/chat/${data.recentDoctorMessage.pairingId}`} icon={MessageCircle}
                title={t("home.messageFrom", { name: data.recentDoctorMessage.doctorName })} detail={timeAgo(data.recentDoctorMessage.createdAt)} />,
            );
          }

          return (
            <>
              <section aria-labelledby="next-heading">
                <Card className="border-2 border-primary">
                  <CardHeader className="pb-2">
                    <CardTitle id="next-heading" className="flex items-center gap-2 text-lg">
                      <CalendarDays className="h-5 w-5 text-primary" aria-hidden="true" /> {t("home.next")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {data.upcomingAppointment ? (
                      <>
                        <div>
                          <p className="text-2xl font-semibold">{formatRelativeDay(data.upcomingAppointment.scheduledAt)}</p>
                          <p className="text-lg">{t("home.visitWith", { type: appointmentTypeLabel(t, data.upcomingAppointment.type), name: data.upcomingAppointment.doctorName })}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <StatusBadge kind="appointment" status={data.upcomingAppointment.status} />
                          <span className="text-muted-foreground">{STATUS_HELP[data.upcomingAppointment.status] ? t(STATUS_HELP[data.upcomingAppointment.status]) : ""}</span>
                        </div>
                        <Button asChild size="lg"><Link href={`/appointments/${data.upcomingAppointment.id}`}>{t("home.getReady")}</Link></Button>
                      </>
                    ) : data.careTeamCount > 0 ? (
                      <>
                        <p className="text-lg">{t("home.noVisit")}</p>
                        <Button asChild size="lg"><Link href="/appointments">{t("home.book")}</Link></Button>
                      </>
                    ) : (
                      <>
                        <p className="text-lg">{t("home.startFinding")}</p>
                        <Button asChild size="lg"><Link href="/symptoms"><Search aria-hidden="true" /> {t("home.findDoctor")}</Link></Button>
                      </>
                    )}
                  </CardContent>
                </Card>
              </section>

              <section aria-labelledby="todo-heading" className="space-y-3">
                <h2 id="todo-heading" className="text-2xl font-semibold">{t("home.todo")}</h2>
                {todo.length > 0 ? (
                  <ul className="space-y-3">{todo}</ul>
                ) : (
                  <p className="rounded-xl border-2 border-input bg-card p-4 text-lg">{t("home.nothing")}</p>
                )}
              </section>

              <section aria-labelledby="help-heading" className="space-y-3">
                <h2 id="help-heading" className="text-2xl font-semibold">{t("home.help")}</h2>
                <ul className="space-y-3">
                  <ToDoRow href="/care-team" icon={Phone} title={t("home.contactDoctor")} detail={t("home.contactDoctor.detail")} />
                  <ToDoRow href="/help" icon={ListChecks} title={t("home.usingHelp")} />
                </ul>
                <Button asChild size="lg" variant="destructive" className="w-full sm:w-auto">
                  <a href={EMERGENCY_TEL}><Siren aria-hidden="true" /> {t("home.emergencyButton", { number: EMERGENCY_NUMBER })}</a>
                </Button>
              </section>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
