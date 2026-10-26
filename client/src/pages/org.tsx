import { useState } from "react";
import { Link, Redirect } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import PageHeader from "@/components/page-header";
import QueryState, { EmptyBlock } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/form-field";
import ConfirmAction from "@/components/confirm-action";
import { Ltr } from "@/components/ltr";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { formatDate, formatDateTime } from "@/lib/format";
import { can, assignableRoles, ORG_ROLES, type OrgRole, type Permission } from "@shared/permissions";
import type { AuthUser } from "@/hooks/use-auth";

type Section = "dashboard" | "patients" | "appointments" | "tasks" | "staff" | "audit" | "settings";
const SECTIONS: { id: Section; permission: Permission; anyClinician?: boolean }[] = [
  { id: "dashboard", permission: "org.dashboard.view" },
  { id: "patients", permission: "org.patients.list", anyClinician: true },
  { id: "appointments", permission: "org.appointments.view" },
  { id: "tasks", permission: "org.tasks.view" },
  { id: "staff", permission: "org.staff.view" },
  { id: "audit", permission: "org.audit.view" },
  { id: "settings", permission: "org.settings.edit" },
];

interface Org { id: string; name: string; kind: string; country: "EG" | "US"; contactEmail: string | null; contactPhone: string | null; address: string | null; status: "unverified" | "verified" | "suspended"; role: OrgRole }

const key = (orgId: string, path: string) => `/api/orgs/${orgId}${path}`;

// ---------------------------------------------------------------------------------------------- start / pick

function OrgForm({ initial, onSaved, submitLabel, orgId }: { initial?: Partial<Org>; onSaved: (o: Org) => void; submitLabel: string; orgId?: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [f, setF] = useState({ name: initial?.name ?? "", kind: initial?.kind ?? "clinic", country: initial?.country ?? "US", contactEmail: initial?.contactEmail ?? "", contactPhone: initial?.contactPhone ?? "", address: initial?.address ?? "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body = { name: f.name, kind: f.kind, country: f.country, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, address: f.address || null };
      const res = await apiRequest(orgId ? "PATCH" : "POST", orgId ? `/api/orgs/${orgId}` : "/api/orgs", body);
      toast({ title: t("hp.saved") });
      onSaved((await res.json()) as Org);
    } catch (err: any) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={save} noValidate className="space-y-4 rounded-2xl border-2 border-input bg-card p-5">
      <Field id="o-name" label={t("org.f.name")}>{(a) => <Input {...a} value={f.name} onChange={set("name")} maxLength={160} />}</Field>
      <Field id="o-kind" label={t("org.f.kind")}>
        {(a) => (
          <NativeSelect {...a} value={f.kind} onChange={set("kind")}>
            {["clinic", "hospital", "practice"].map((k) => <option key={k} value={k}>{t(`org.kind.${k}` as MessageKey)}</option>)}
          </NativeSelect>
        )}
      </Field>
      <Field id="o-country" label={t("org.f.country")}>
        {(a) => (
          <NativeSelect {...a} value={f.country} onChange={set("country")}>
            <option value="EG">{t("hp.country.EG")}</option><option value="US">{t("hp.country.US")}</option>
          </NativeSelect>
        )}
      </Field>
      <Field id="o-email" label={t("org.f.email")} optional>{(a) => <Input {...a} type="email" dir="ltr" value={f.contactEmail} onChange={set("contactEmail")} />}</Field>
      <Field id="o-phone" label={t("org.f.phone")} optional>{(a) => <Input {...a} type="tel" dir="ltr" value={f.contactPhone} onChange={set("contactPhone")} />}</Field>
      <Field id="o-address" label={t("org.f.address")} optional>{(a) => <Textarea {...a} rows={2} value={f.address} onChange={set("address")} />}</Field>
      {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
      <Button type="submit" size="lg">{submitLabel}</Button>
    </form>
  );
}

function Start({ user }: { user: AuthUser }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={t("org.title")} description={user.role === "doctor" ? t("org.start.intro") : t("org.none.staff")} />
      {user.role === "doctor" ? <OrgForm submitLabel={t("org.start.create")} onSaved={() => queryClient.invalidateQueries({ queryKey: ["/api/orgs"] })} /> : <EmptyBlock title={t("org.none.title")}>{t("org.none.body")}</EmptyBlock>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- sections

function Dashboard({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const q = useQuery<any>({ queryKey: [key(orgId, "/dashboard")], staleTime: 0 });
  return (
    <QueryState query={q} loadingLabel={t("hp.loading")}>
      {(d) => {
        const rows: [MessageKey, number][] = [];
        if (d.staff) rows.push(["org.d.staff", d.staff.total]);
        if (d.patients) rows.push(["org.d.patients", d.patients.count]);
        if (d.appointments) rows.push(["org.d.appts", d.appointments.next7Days], ["org.d.apptsRequested", d.appointments.requested], ["org.d.apptsConfirmed", d.appointments.confirmed]);
        if (d.tasks) rows.push(["org.d.tasksOpen", d.tasks.open], ["org.d.tasksOverdue", d.tasks.overdue], ["org.d.tasksUnassigned", d.tasks.unassigned], ["org.d.tasksDone", d.tasks.doneLast7Days]);
        return (
          <div className="space-y-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              {rows.map(([k, v]) => <div key={k} className="rounded-2xl border-2 border-input bg-card p-4"><dt className="text-base font-semibold text-muted-foreground">{t(k)}</dt><dd className="text-4xl font-semibold">{v}</dd></div>)}
            </dl>
            <p className="text-base text-muted-foreground">{t("org.d.real")}</p>
            <section aria-labelledby="out-of-scope" className="rounded-2xl border-2 border-dashed border-input p-4">
              <h2 id="out-of-scope" className="text-xl font-semibold">{t("org.scope.title")}</h2>
              <p className="mt-1 text-base text-muted-foreground">{t("org.scope.body")}</p>
            </section>
          </div>
        );
      }}
    </QueryState>
  );
}

function Patients({ orgId, role }: { orgId: string; role: OrgRole }) {
  const { t } = useI18n();
  const q = useQuery<{ id: string; name: string }[]>({ queryKey: [key(orgId, "/patients")], staleTime: 0 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-base text-muted-foreground">{t(role === "clinician" ? "org.p.noteClinician" : "org.p.note")}</p>
      <QueryState query={q} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("org.p.empty")} />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((p) => (
              <li key={p.id} className="space-y-3 rounded-2xl border-2 border-input bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xl font-semibold">{p.name}</h3>
                  {can(role, "org.notes.read") && <Button variant="outline" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>{t("org.p.notes")}<span className="sr-only">: {p.name}</span></Button>}
                </div>
                {open === p.id && <Notes orgId={orgId} patientId={p.id} canWrite={can(role, "org.notes.write")} />}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

function Notes({ orgId, patientId, canWrite }: { orgId: string; patientId: string; canWrite: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const path = key(orgId, `/patients/${patientId}/notes`);
  const q = useQuery<{ id: string; body: string; authorName: string; createdAt: string }[]>({ queryKey: [path], staleTime: 0 });
  const [body, setBody] = useState("");
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiRequest("POST", path, { body });
      setBody("");
      queryClient.invalidateQueries({ queryKey: [path] });
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-sand p-3 text-base text-sand-foreground">{t("org.n.internal")}</p>
      {canWrite && (
        <form onSubmit={add} className="space-y-2">
          <Field id={`n-${patientId}`} label={t("org.n.new")}>{(a) => <Textarea {...a} rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} />}</Field>
          <Button type="submit" disabled={!body.trim()}>{t("org.n.add")}</Button>
        </form>
      )}
      <QueryState query={q} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<p className="text-base text-muted-foreground">{t("org.n.empty")}</p>}>
        {(rows) => <ul className="space-y-2">{rows.map((n) => <li key={n.id} className="rounded-xl border border-border p-3"><p className="text-lg">{n.body}</p><p className="text-sm text-muted-foreground">{n.authorName} · {formatDateTime(n.createdAt)}</p></li>)}</ul>}
      </QueryState>
    </div>
  );
}

function Appointments({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const q = useQuery<{ id: string; patientName: string; doctorName: string; scheduledAt: string; durationMinutes: number; status: string; type: string }[]>({ queryKey: [key(orgId, "/appointments")], staleTime: 0 });
  return (
    <div className="space-y-4">
      <p className="text-base text-muted-foreground">{t("org.a.note")}</p>
      <QueryState query={q} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("org.a.empty")} />}>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3 text-lg">
                <span>{formatDateTime(a.scheduledAt)} · {a.patientName} · {a.doctorName}</span>
                <Badge variant={a.status === "confirmed" ? "default" : "secondary"}>{t(`org.a.status.${a.status}` as MessageKey)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

interface Task { id: string; patientUserId: string; patientName: string; title: string; dueDate: string | null; status: string; assignedToUserId: string | null; assignedToName: string | null; overdue: boolean }

function Tasks({ orgId, role, userId }: { orgId: string; role: OrgRole; userId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"open" | "done">("open");
  const path = key(orgId, `/tasks?status=${status}`);
  const q = useQuery<Task[]>({ queryKey: [path], staleTime: 0 });
  const patients = useQuery<{ id: string; name: string }[]>({ queryKey: [key(orgId, "/patients")], enabled: can(role, "org.tasks.manage") });
  const staff = useQuery<{ members: { userId: string; name: string; status: string }[] }>({ queryKey: [key(orgId, "/staff")], enabled: can(role, "org.tasks.manage") && can(role, "org.staff.view") });
  const [f, setF] = useState({ patientUserId: "", title: "", dueDate: "", assignedToUserId: "" });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith(key(orgId, "/tasks")) || String(x.queryKey[0]).endsWith("/dashboard") });
  const manage = can(role, "org.tasks.manage");
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiRequest("POST", key(orgId, "/tasks"), { patientUserId: f.patientUserId, title: f.title, dueDate: f.dueDate || null, assignedToUserId: f.assignedToUserId || null });
      setF({ patientUserId: f.patientUserId, title: "", dueDate: "", assignedToUserId: "" });
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  }
  async function change(id: string, body: object) {
    try {
      await apiRequest("PATCH", key(orgId, `/tasks/${id}`), body);
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
    }
  }
  return (
    <div className="space-y-6">
      <p className="rounded-xl bg-sand p-3 text-base text-sand-foreground">{t("org.t.note")}</p>
      {manage && (
        <form onSubmit={create} noValidate className="space-y-3 rounded-2xl border-2 border-input bg-card p-4" aria-label={t("org.t.add")}>
          <h3 className="text-xl font-semibold">{t("org.t.add")}</h3>
          <Field id="t-patient" label={t("org.t.patient")}>
            {(a) => (
              <NativeSelect {...a} value={f.patientUserId} onChange={(e) => setF((p) => ({ ...p, patientUserId: e.target.value }))}>
                <option value="">{t("org.t.choose")}</option>
                {(patients.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            )}
          </Field>
          <Field id="t-title" label={t("org.t.title")}>{(a) => <Input {...a} value={f.title} maxLength={200} onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} />}</Field>
          <Field id="t-due" label={t("org.t.due")} optional>{(a) => <Input {...a} type="date" value={f.dueDate} onChange={(e) => setF((p) => ({ ...p, dueDate: e.target.value }))} />}</Field>
          {staff.data && (
            <Field id="t-assign" label={t("org.t.assign")} optional>
              {(a) => (
                <NativeSelect {...a} value={f.assignedToUserId} onChange={(e) => setF((p) => ({ ...p, assignedToUserId: e.target.value }))}>
                  <option value="">{t("org.t.unassigned")}</option>
                  {staff.data!.members.filter((m) => m.status === "active").map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.userId === userId ? ` (${t("org.t.me")})` : ""}</option>)}
                </NativeSelect>
              )}
            </Field>
          )}
          {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
          <Button type="submit" disabled={!f.patientUserId || f.title.trim().length < 2}>{t("org.t.create")}</Button>
        </form>
      )}
      <div role="radiogroup" aria-label={t("cred.filter")} className="flex gap-2">
        {(["open", "done"] as const).map((s) => <Button key={s} role="radio" aria-checked={status === s} variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)}>{t(`org.t.status.${s}` as MessageKey)}</Button>)}
      </div>
      <QueryState query={q} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("org.t.empty")} />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((task) => (
              <li key={task.id} className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-xl font-semibold">{task.title}</h3>
                  {task.overdue && <Badge variant="destructive">{t("org.t.overdue")}</Badge>}
                </div>
                <p className="text-lg">{task.patientName}{task.dueDate ? ` · ${t("org.t.dueOn", { date: formatDate(task.dueDate) })}` : ""} · {task.assignedToName ? t("org.t.assignedTo", { name: task.assignedToName }) : t("org.t.unassigned")}</p>
                {manage && task.status === "open" && (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => change(task.id, { status: "done" })}>{t("org.t.markDone")}<span className="sr-only">: {task.title}</span></Button>
                    <Button variant="outline" onClick={() => change(task.id, { assignedToUserId: userId })}>{t("org.t.takeIt")}<span className="sr-only">: {task.title}</span></Button>
                    <Button variant="outline" onClick={() => change(task.id, { status: "cancelled" })}>{t("org.t.cancel")}<span className="sr-only">: {task.title}</span></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

interface Staff { members: { id: string; userId: string; name: string; email: string | null; role: OrgRole; status: string }[]; invitations: { id: string; email: string; role: OrgRole; expiresAt: string }[] }

function StaffSection({ orgId, role, userId }: { orgId: string; role: OrgRole; userId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<Staff>({ queryKey: [key(orgId, "/staff")], staleTime: 0 });
  const [email, setEmail] = useState("");
  const roles = assignableRoles(role);
  const [newRole, setNewRole] = useState<OrgRole>(roles.includes("coordinator") ? "coordinator" : roles[0] ?? "scheduler");
  const [link, setLink] = useState<{ link: string | null; emailAccepted: boolean; emailAllowed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [key(orgId, "/staff")] });
  async function inviteSomeone(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiRequest("POST", key(orgId, "/staff/invitations"), { email, role: newRole });
      setLink(await res.json());
      setEmail("");
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  }
  async function act(method: "PATCH" | "DELETE", path: string, body?: object) {
    try {
      await apiRequest(method, key(orgId, path), body);
      refresh();
    } catch (err: any) {
      toast({ title: t("hp.saveFailed"), description: err.message, variant: "destructive" });
      throw err;
    }
  }
  return (
    <div className="space-y-6">
      {can(role, "org.staff.invite") && (
        <form onSubmit={inviteSomeone} noValidate className="space-y-3 rounded-2xl border-2 border-input bg-card p-4" aria-label={t("org.s.invite")}>
          <h3 className="text-xl font-semibold">{t("org.s.invite")}</h3>
          <Field id="s-email" label={t("org.s.email")}>{(a) => <Input {...a} type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field id="s-role" label={t("org.s.role")}>
            {(a) => <NativeSelect {...a} value={newRole} onChange={(e) => setNewRole(e.target.value as OrgRole)}>{roles.map((r) => <option key={r} value={r}>{t(`org.role.${r}` as MessageKey)}</option>)}</NativeSelect>}
          </Field>
          <p className="text-base text-muted-foreground">{t(`org.role.${newRole}.can` as MessageKey)}</p>
          {error && <p role="alert" className="font-medium text-destructive">{error}</p>}
          <Button type="submit" disabled={!email.includes("@")}>{t("org.s.send")}</Button>
          {link && (
            <div role="status" className="space-y-1 rounded-xl bg-secondary p-3 text-base">
              <p>{link.emailAccepted ? t("org.s.emailAccepted") : link.emailAllowed ? t("org.s.emailNot") : t("org.s.emailUnverifiedOrg")}</p>
              {link.link && (<><p>{t("org.s.linkOnce")}</p><p className="break-all"><Ltr>{link.link}</Ltr></p></>)}
            </div>
          )}
        </form>
      )}
      <QueryState query={q} loadingLabel={t("hp.loading")}>
        {(s) => (
          <>
            <ul className="space-y-3">
              {s.members.map((m) => {
                const mine = m.userId === userId;
                const editable = m.status === "active" && assignableRoles(role).includes(m.role) && !mine;
                return (
                  <li key={m.id} className="space-y-2 rounded-2xl border-2 border-input bg-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xl font-semibold">{m.name}{mine ? ` (${t("org.t.me")})` : ""}</h3>
                      <span className="flex gap-2"><Badge variant="secondary">{t(`org.role.${m.role}` as MessageKey)}</Badge>{m.status !== "active" && <Badge variant="outline">{t("org.s.revoked")}</Badge>}</span>
                    </div>
                    {m.email && <p className="text-base text-muted-foreground"><Ltr>{m.email}</Ltr></p>}
                    {m.status === "active" && mine && !can(role, "org.staff.role") && (
                      <ConfirmAction
                        trigger={<Button variant="outline">{t("org.s.leave")}</Button>}
                        title={t("org.s.leave.title")} description={t("org.s.remove.body")} confirmLabel={t("org.s.remove.yes")} cancelLabel={t("common.cancel")} destructive
                        onConfirm={async () => { await apiRequest("DELETE", key(orgId, "/membership")); queryClient.invalidateQueries({ queryKey: ["/api/orgs"] }); window.location.assign("/org"); }}
                      />
                    )}
                    {can(role, "org.staff.role") && m.status === "active" && (editable || (mine && m.role !== "owner")) && (
                      <div className="flex flex-wrap items-center gap-2">
                        {editable && (
                          <NativeSelect aria-label={t("org.s.changeRole", { name: m.name })} value={m.role} onChange={(e) => act("PATCH", `/staff/${m.id}`, { role: e.target.value })} className="w-auto">
                            {ORG_ROLES.filter((r) => assignableRoles(role).includes(r) || r === m.role).map((r) => <option key={r} value={r}>{t(`org.role.${r}` as MessageKey)}</option>)}
                          </NativeSelect>
                        )}
                        <ConfirmAction
                          trigger={<Button variant="outline">{mine ? t("org.s.leave") : t("org.s.remove")}<span className="sr-only">: {m.name}</span></Button>}
                          title={mine ? t("org.s.leave.title") : t("org.s.remove.title", { name: m.name })} description={t("org.s.remove.body")} confirmLabel={t("org.s.remove.yes")} cancelLabel={t("common.cancel")} destructive
                          onConfirm={() => act("DELETE", `/staff/${m.id}`)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {s.invitations.length > 0 && (
              <section aria-labelledby="pending-inv" className="space-y-2">
                <h3 id="pending-inv" className="text-xl font-semibold">{t("org.s.pending")}</h3>
                <ul className="space-y-2">
                  {s.invitations.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-lg">
                      <span><Ltr>{i.email}</Ltr> · {t(`org.role.${i.role}` as MessageKey)} · {t("hp.assist.until", { date: formatDate(i.expiresAt) })}</span>
                      {can(role, "org.staff.revoke") && <Button variant="outline" onClick={() => act("DELETE", `/staff/invitations/${i.id}`)}>{t("dconn.revoke")}<span className="sr-only">: {i.email}</span></Button>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}

function Audit({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const [action, setAction] = useState("");
  const path = key(orgId, `/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`);
  const q = useQuery<{ id: string; action: string; targetType: string | null; createdAt: string; actorName: string | null }[]>({ queryKey: [path], staleTime: 0 });
  return (
    <div className="space-y-4">
      <p className="text-base text-muted-foreground">{t("org.au.note")}</p>
      <Field id="au-action" label={t("org.au.filter")} hint={t("org.au.filter.hint")} optional>{(a) => <Input {...a} dir="ltr" value={action} onChange={(e) => setAction(e.target.value)} placeholder="org.task" />}</Field>
      <QueryState query={q} loadingLabel={t("hp.loading")} isEmpty={(d) => d.length === 0} empty={<EmptyBlock title={t("org.au.empty")} />}>
        {(rows) => <ul className="divide-y divide-border rounded-2xl border border-border bg-card">{rows.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-lg"><span>{r.actorName ?? "—"}</span><Ltr><code>{r.action}</code></Ltr><span className="text-base text-muted-foreground">{formatDateTime(r.createdAt)}</span></li>)}</ul>}
      </QueryState>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- the page

export default function OrgPage({ user, orgId, section }: { user: AuthUser; orgId?: string; section?: string }) {
  const { t } = useI18n();
  const list = useQuery<Org[]>({ queryKey: ["/api/orgs"], staleTime: 0 });
  const detail = useQuery<Org>({ queryKey: [key(orgId ?? "none", "")], enabled: !!orgId, staleTime: 0, retry: false });
  const queryClient = useQueryClient();

  if (!orgId) {
    return (
      <QueryState query={list} loadingLabel={t("hp.loading")}>
        {(orgs) => (orgs.length === 0 ? <Start user={user} /> : <Redirect to={`/org/${orgs[0].id}`} />)}
      </QueryState>
    );
  }
  return (
    <QueryState query={detail} loadingLabel={t("hp.loading")}>
      {(org) => {
        const visible = SECTIONS.filter((s) => can(org.role, s.permission) || (s.anyClinician && org.role === "clinician"));
        const active = (SECTIONS.find((s) => s.id === section) && visible.some((v) => v.id === section) ? section : visible[0]?.id) as Section;
        return (
          <div className="mx-auto max-w-3xl space-y-6">
            <PageHeader title={org.name} description={`${t(`org.kind.${org.kind}` as MessageKey)} · ${t(`hp.country.${org.country}` as MessageKey)} · ${t(`org.role.${org.role}` as MessageKey)}`} />
            <p role="status" className={`rounded-xl border-2 p-3 text-base ${org.status === "verified" ? "border-primary/40 bg-secondary" : "border-ochre bg-sand text-sand-foreground"}`}>
              <Building2 className="me-2 inline h-5 w-5" aria-hidden="true" />{t(`org.status.${org.status}` as MessageKey)}
            </p>
            {(list.data?.length ?? 0) > 1 && (
              <nav aria-label={t("org.switch")} className="flex flex-wrap gap-2">
                {list.data!.map((o) => <Button key={o.id} asChild variant={o.id === org.id ? "default" : "outline"}><Link href={`/org/${o.id}`}>{o.name}</Link></Button>)}
              </nav>
            )}
            <nav aria-label={t("org.sections")} className="flex flex-wrap gap-2">
              {visible.map((s) => <Button key={s.id} asChild variant={active === s.id ? "default" : "outline"}><Link href={`/org/${org.id}/${s.id}`} aria-current={active === s.id ? "page" : undefined}>{t(`org.sec.${s.id}` as MessageKey)}</Link></Button>)}
            </nav>
            <h2 className="font-display text-2xl">{t(`org.sec.${active}` as MessageKey)}</h2>
            {active === "dashboard" && <Dashboard orgId={org.id} />}
            {active === "patients" && <Patients orgId={org.id} role={org.role} />}
            {active === "appointments" && <Appointments orgId={org.id} />}
            {active === "tasks" && <Tasks orgId={org.id} role={org.role} userId={user.id} />}
            {active === "staff" && <StaffSection orgId={org.id} role={org.role} userId={user.id} />}
            {active === "audit" && <Audit orgId={org.id} />}
            {active === "settings" && <OrgForm initial={org} orgId={org.id} submitLabel={t("common.save")} onSaved={() => { queryClient.invalidateQueries({ queryKey: [key(org.id, "")] }); queryClient.invalidateQueries({ queryKey: ["/api/orgs"] }); }} />}
          </div>
        );
      }}
    </QueryState>
  );
}
