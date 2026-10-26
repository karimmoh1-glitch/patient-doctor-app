import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Home, Stethoscope, CalendarDays, HeartPulse, LogOut, Siren, LifeBuoy, Settings as SettingsIcon,
  Inbox, UserCog, Users, Gauge, Clock, Bell, ClipboardCheck, UserRound, ScrollText, Plug, BadgeCheck,
  MessagesSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import ConfirmAction from "@/components/confirm-action";
import Logo from "@/components/logo";
import AccountControls from "@/components/account-controls";
import { useTextSize, type TextSize } from "@/hooks/use-text-size";
import { useI18n, LOCALES, type MessageKey, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/hooks/use-auth";

interface NavItem {
  href: string;
  labelKey: MessageKey;
  /** One short word for the bottom tab bar, where several labels must fit side by side at any text size. */
  shortKey?: MessageKey;
  icon: React.ComponentType<{ className?: string }>;
  /** Route prefixes that should light this item up (it "owns" these screens). */
  owns?: string[];
  /** Highlight only on this exact path (a Home item whose path is a prefix of its siblings'). */
  exact?: boolean;
  /** Not in the phone tab bar (which holds at most five), reachable from the screens that link to it. */
  sidebarOnly?: boolean;
}

// A patient gets exactly four places to go. Everything else lives one tap
// inside one of them (My Health is a hub, My Doctors holds messages), so no
// one has to remember where a feature is hiding.
const PATIENT_NAV: NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: Home },
  {
    href: "/care-team", labelKey: "nav.doctors", shortKey: "nav.doctors.short", icon: Stethoscope,
    owns: ["/doctors", "/messages", "/chat", "/symptoms", "/match-results"],
  },
  { href: "/appointments", labelKey: "nav.appointments", shortKey: "nav.appointments.short", icon: CalendarDays },
  {
    href: "/my-health", labelKey: "nav.health", shortKey: "nav.health.short", icon: HeartPulse,
    owns: ["/medications", "/prescriptions", "/timeline", "/documents", "/care-circle", "/profile", "/notifications"],
  },
];

const DOCTOR_NAV: NavItem[] = [
  { href: "/doctor", labelKey: "nav.d.home", icon: Home, exact: true },
  { href: "/doctor/requests", labelKey: "nav.d.requests", icon: Inbox },
  { href: "/doctor/patients", labelKey: "nav.d.patients", icon: Users },
  { href: "/doctor/messages", labelKey: "nav.d.messages", icon: MessagesSquare, owns: ["/chat"] },
  { href: "/doctor/appointments", labelKey: "nav.d.appointments", shortKey: "nav.d.appointments.short", icon: CalendarDays },
  { href: "/doctor/availability", labelKey: "nav.d.hours", shortKey: "nav.d.hours.short", icon: Clock },
  { href: "/doctor/profile", labelKey: "nav.d.profile", icon: UserRound, owns: ["/notifications"], sidebarOnly: true },
];

// Until an administrator approves them, a doctor has exactly one place to be:
// their own application. Nothing clinical is reachable (or shown).
const UNAPPROVED_DOCTOR_NAV: NavItem[] = [
  { href: "/doctor/application", labelKey: "nav.d.application", icon: ClipboardCheck },
];

function navFor(user: AuthUser): NavItem[] {
  if (user.role === "patient") return PATIENT_NAV;
  if (user.role === "doctor") return user.doctorStatus === "approved" ? DOCTOR_NAV : UNAPPROVED_DOCTOR_NAV;
  if (user.role === "caregiver") return [{ href: "/caregiver", labelKey: "nav.caregiver", icon: Gauge }];
  return [
    { href: "/admin", labelKey: "nav.admin", icon: UserCog, exact: true },
    { href: "/admin/activity", labelKey: "nav.admin.activity", icon: ScrollText },
    { href: "/admin/credentials", labelKey: "nav.admin.credentials", icon: BadgeCheck },
    { href: "/admin/integrations", labelKey: "nav.admin.integrations", icon: Plug },
  ];
}

function isActive(item: NavItem, location: string): boolean {
  if (item.href === "/" || item.exact) return location === item.href;
  if (location === item.href || location.startsWith(item.href + "/")) return true;
  return !!item.owns?.some((p) => location === p || location.startsWith(p + "/"));
}

const TEXT_SIZES: { value: TextSize; key: MessageKey }[] = [
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

          <AccountControls user={user} onSignOut={onSignOut} />

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


// The bell shows an unread count only when there is one, and always carries a
// text alternative: the count is never conveyed by colour or the badge alone.
function NotificationsLink() {
  const { t } = useI18n();
  const { data } = useQuery<{ unread: number }>({ queryKey: ["/api/notifications/unread-count"], refetchInterval: 60_000 });
  const unread = data?.unread ?? 0;
  return (
    <Button asChild variant="outline" size="sm" className="relative px-2.5">
      <Link href="/notifications" aria-label={t("top.notifications.unread", { count: unread } as never)}>
        <Bell aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute -end-1.5 -top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-destructive px-1.5 text-sm font-bold leading-none text-destructive-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Link>
    </Button>
  );
}

function TopBar({ user, onOpenSettings, large }: { user: AuthUser; onOpenSettings: () => void; large?: boolean }) {
  const { t } = useI18n();
  const clinical = user.role === "patient" || (user.role === "doctor" && user.doctorStatus === "approved");
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur-sm">
      <div className={cn("mx-auto flex flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2 sm:px-5", large ? "max-w-xl" : "max-w-6xl")}>
        <Logo hideTextOnPhone className="me-auto" />
        {/* Emergency and Help are always one tap away. On a phone they get a full-width row of two big buttons. */}
        {user.role === "patient" && (
          <div className="order-last grid w-full grid-cols-2 gap-2 sm:order-none sm:flex sm:w-auto">
            <Button asChild variant="destructive" size="sm" className="min-h-12 sm:min-h-11">
              <Link href="/sos"><Siren aria-hidden="true" /> {t("top.emergency")}</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="min-h-12 sm:min-h-11">
              <Link href="/help"><LifeBuoy aria-hidden="true" /> {t("top.help")}</Link>
            </Button>
          </div>
        )}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {clinical && <NotificationsLink />}
          <Button variant="outline" size="sm" onClick={onOpenSettings} aria-label={t("top.settings")} className="px-2.5 md:px-4">
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
    <nav aria-label={t("nav.main")} className="hidden w-64 shrink-0 border-e border-border bg-card/60 p-4 md:block">
      <ul className="space-y-1.5">
        {items.map((item) => {
          const active = isActive(item, location);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-xl px-4 text-lg font-semibold transition-colors",
                  active ? "bg-secondary text-primary" : "text-foreground hover:bg-muted",
                )}
              >
                <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                {t(item.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function BottomNav({ items: all, location }: { items: NavItem[]; location: string }) {
  const { t } = useI18n();
  const items = all.filter((i) => !i.sidebarOnly);
  return (
    <nav aria-label={t("nav.main")} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card md:hidden">
      <ul className="mx-auto grid max-w-xl" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(item, location);
          const Icon = item.icon;
          const full = t(item.labelKey);
          const short = item.shortKey ? t(item.shortKey) : full;
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
                <span aria-hidden="true">{short}</span>
                <span className="sr-only">{full}</span>
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
  const items = navFor(user);
  const showBottomNav = items.length > 1;

  const skipLink = (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
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
        <TopBar user={user} onOpenSettings={() => setSettingsOpen(true)} large />
        <main id="main" tabIndex={-1} className="px-5 py-8 outline-none">{children}</main>
        {settings}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {skipLink}
      <TopBar user={user} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="mx-auto flex max-w-6xl">
        {showBottomNav && <SideNav items={items} location={location} />}
        <main id="main" tabIndex={-1} className={cn("min-w-0 flex-1 px-4 py-6 outline-none md:px-8 md:py-10", showBottomNav && "pb-28 md:pb-10")}>
          {children}
        </main>
      </div>
      {showBottomNav && <BottomNav items={items} location={location} />}
      {settings}
    </div>
  );
}
