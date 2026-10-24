import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Home, Stethoscope, CalendarDays, HeartPulse, LogOut, Siren, LifeBuoy, Settings as SettingsIcon,
  Inbox, UserCog, Users, Gauge, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import ConfirmAction from "@/components/confirm-action";
import { useTextSize, type TextSize } from "@/hooks/use-text-size";
import { useI18n, LOCALES, type Key, type Locale } from "@/lib/i18n";
import { NativeSelect } from "@/components/ui/native-select";
import { useAppConfig } from "@/hooks/use-app-config";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/hooks/use-auth";

interface NavItem {
  href: string;
  label: string;
  /** Translation keys (patient navigation). Other roles use `label` as-is. */
  labelKey?: Key;
  shortKey?: Key;
  /** One short word for the bottom tab bar, where four labels must fit side by side at any text size. */
  short?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Route prefixes that should light this item up (it "owns" these screens). */
  owns?: string[];
  /** Highlight only on this exact path (a Home item whose path is a prefix of its siblings'). */
  exact?: boolean;
}

// A patient gets exactly four places to go. Everything else lives one tap
// inside one of them (My Health is a hub, My Doctors holds messages), so no
// one has to remember where a feature is hiding.
const PATIENT_NAV: NavItem[] = [
  { href: "/", label: "Home", labelKey: "nav.home", icon: Home },
  { href: "/care-team", label: "My Doctors", labelKey: "nav.doctors", shortKey: "nav.doctors.short", short: "Doctors", icon: Stethoscope, owns: ["/doctors", "/messages", "/chat", "/symptoms", "/match-results"] },
  { href: "/appointments", label: "Appointments", labelKey: "nav.appointments", shortKey: "nav.appointments.short", short: "Visits", icon: CalendarDays },
  {
    href: "/my-health",
    label: "My Health",
    labelKey: "nav.health",
    shortKey: "nav.health.short",
    short: "Health",
    icon: HeartPulse,
    owns: ["/medications", "/prescriptions", "/pharmacy", "/timeline", "/documents", "/handoff", "/assistant", "/care-circle", "/profile"],
  },
];

function navForRole(role: AuthUser["role"]): NavItem[] {
  if (role === "patient") return PATIENT_NAV;
  if (role === "doctor") {
    return [
      { href: "/doctor", label: "Home", icon: Home, exact: true },
      { href: "/doctor/requests", label: "Requests", icon: Inbox },
      { href: "/doctor/patients", label: "Patients", icon: Users, owns: ["/chat"] },
      { href: "/doctor/appointments", label: "Appointments", icon: CalendarDays },
      { href: "/doctor/availability", label: "My hours", icon: Clock },
    ];
  }
  if (role === "caregiver") return [{ href: "/caregiver", label: "Care Circle", icon: Gauge }];
  return [{ href: "/admin", label: "Doctor applications", icon: UserCog }];
}

function isActive(item: NavItem, location: string): boolean {
  if (item.href === "/" || item.exact) return location === item.href;
  if (location === item.href || location.startsWith(item.href + "/")) return true;
  return !!item.owns?.some((p) => location === p || location.startsWith(p + "/"));
}

const TEXT_SIZES: { value: TextSize; key: Key }[] = [
  { value: "normal", key: "settings.size.normal" },
  { value: "large", key: "settings.size.large" },
  { value: "xlarge", key: "settings.size.xlarge" },
];
const SAMPLE_CLASS: Record<TextSize, string> = { normal: "text-xl", large: "text-3xl", xlarge: "text-4xl" };

function SettingsDialog({
  user, open, onOpenChange, simpleMode, onSetSimpleMode, onSignOut,
}: {
  user: AuthUser; open: boolean; onOpenChange: (v: boolean) => void;
  simpleMode: boolean; onSetSimpleMode?: (v: boolean) => void; onSignOut: () => void;
}) {
  const { size, setSize } = useTextSize();
  const { t, locale, setLocale } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-2xl">{t("settings.title")}</DialogTitle>
          <DialogDescription className="text-base">{t("settings.signedInAs", { name: user.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          <div role="radiogroup" aria-label={t("settings.textSize")} className="space-y-2">
            <p className="text-base font-semibold">{t("settings.textSize")}</p>
            <div className="grid grid-cols-3 gap-3">
              {TEXT_SIZES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={size === option.value}
                  onClick={() => setSize(option.value)}
                  className={cn(
                    "flex min-h-20 flex-col items-center justify-center rounded-xl border-2 px-2 py-2",
                    size === option.value ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card hover:bg-secondary",
                  )}
                >
                  <span className={cn("font-semibold leading-none", SAMPLE_CLASS[option.value])} aria-hidden="true">Aa</span>
                  <span className="mt-1 text-sm">{t(option.key)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="language" className="text-base font-semibold">{t("settings.language")}</Label>
            <NativeSelect id="language" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}{l.note ? ` (${l.note})` : ""}</option>
              ))}
            </NativeSelect>
          </div>

          {user.role === "patient" && onSetSimpleMode && (
            <div className="flex items-center justify-between gap-4 rounded-xl border-2 border-input p-4">
              <div>
                <Label htmlFor="simple-mode" className="text-base font-semibold">{t("settings.simple")}</Label>
                <p className="text-muted-foreground">{t("settings.simpleHelp")}</p>
              </div>
              <Switch id="simple-mode" checked={simpleMode} onCheckedChange={onSetSimpleMode} />
            </div>
          )}

          <ConfirmAction
            trigger={<Button variant="outline" size="lg" className="w-full"><LogOut aria-hidden="true" /> {t("settings.signOut")}</Button>}
            title={t("settings.signOut.title")}
            description={t("settings.signOut.body")}
            confirmLabel={t("settings.signOut.yes")}
            cancelLabel={t("settings.signOut.no")}
            onConfirm={onSignOut}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DemoBanner() {
  const config = useAppConfig();
  const { t } = useI18n();
  if (!config?.demoMode) return null;
  return (
    <p role="note" className="bg-secondary px-4 py-2 text-center text-base font-medium text-foreground">
      {t("demo.banner")}
    </p>
  );
}

function TopBar({ user, onOpenSettings, large }: { user: AuthUser; onOpenSettings: () => void; large?: boolean }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card">
      <div className={cn("mx-auto flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-5", large ? "max-w-xl" : "max-w-6xl")}>
        <Link href="/" className="hidden min-h-12 items-center gap-2 text-lg font-semibold text-primary sm:flex">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Stethoscope className="h-5 w-5" aria-hidden="true" />
          </span>
          <span>Avela</span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {user.role === "patient" && (
            <>
              <Button asChild variant="destructive" size="sm">
                <Link href="/sos"><Siren aria-hidden="true" /> {t("top.emergency")}</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/help"><LifeBuoy aria-hidden="true" /> {t("top.help")}</Link>
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={onOpenSettings} aria-label={t("top.settings")} className="px-3 md:px-4">
            <SettingsIcon aria-hidden="true" /> <span className="hidden md:inline">{t("top.settings")}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

function SideNav({ items, location }: { items: NavItem[]; location: string }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("nav.main")} className="hidden w-60 shrink-0 border-r border-border bg-card p-3 md:block">
      <ul className="space-y-2">
        {items.map((item) => {
          const active = isActive(item, location);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-xl px-4 text-lg font-semibold",
                  active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                {item.labelKey ? t(item.labelKey) : item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function BottomNav({ items, location }: { items: NavItem[]; location: string }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("nav.main")} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card md:hidden">
      <ul className="mx-auto grid max-w-xl" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(item, location);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-[4.5rem] min-w-0 flex-col items-center justify-center gap-1 px-1 text-center text-sm font-semibold leading-tight",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className={cn("flex h-[32px] w-[56px] items-center justify-center rounded-full", active && "bg-secondary")}>
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <span aria-hidden="true">{item.shortKey ? t(item.shortKey) : item.short ?? (item.labelKey ? t(item.labelKey) : item.label)}</span>
                <span className="sr-only">{item.labelKey ? t(item.labelKey) : item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default function AppShell({
  user,
  onSignOut,
  simpleMode = false,
  onSetSimpleMode,
  children,
}: {
  user: AuthUser;
  onSignOut: () => void;
  simpleMode?: boolean;
  onSetSimpleMode?: (value: boolean) => void;
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const items = navForRole(user.role);
  const showBottomNav = items.length > 1;

  const skipLink = (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
    >
      {t("skip")}
    </a>
  );

  const settings = (
    <SettingsDialog
      user={user}
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      simpleMode={simpleMode}
      onSetSimpleMode={onSetSimpleMode}
      onSignOut={onSignOut}
    />
  );

  // Simple Mode is a deliberately different layout, not a shrunk one: one
  // calm column with the same Emergency and Help always in reach.
  if (user.role === "patient" && simpleMode) {
    return (
      <div className="min-h-screen bg-background">
        {skipLink}
        <DemoBanner />
        <TopBar user={user} onOpenSettings={() => setSettingsOpen(true)} large />
        <main id="main" tabIndex={-1} className="px-5 py-8 outline-none">{children}</main>
        {settings}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {skipLink}
      <DemoBanner />
      <TopBar user={user} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="mx-auto flex max-w-6xl">
        {showBottomNav && <SideNav items={items} location={location} />}
        <main id="main" tabIndex={-1} className={cn("min-w-0 flex-1 px-4 py-6 outline-none md:px-8 md:py-8", showBottomNav && "pb-28 md:pb-8")}>
          {children}
        </main>
      </div>
      {showBottomNav && <BottomNav items={items} location={location} />}
      {settings}
    </div>
  );
}
