import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth, SESSION_NOTICE_KEY, type AuthUser } from "@/hooks/use-auth";
import { useSimpleMode } from "@/hooks/use-simple-mode";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Login from "@/pages/login";
import Signup from "@/pages/signup";
import AppShell from "@/components/app-shell";
import ErrorBoundary from "@/components/error-boundary";
import { lazy, Suspense, useEffect, useRef } from "react";
import { useDocumentTitle } from "@/lib/route-titles";
import { I18nProvider, hasChosenLocale, useI18n } from "@/lib/i18n";
import { apiRequest } from "@/lib/queryClient";
import { WELCOME_KEY } from "@/pages/signup";
import PublicLayout from "@/components/public-layout";
import HomeDashboard from "@/pages/home-dashboard";

const DoctorApplication = lazy(() => import("@/pages/doctor-application"));
const GetStarted = lazy(() => import("@/pages/get-started"));
const JoinDoctor = lazy(() => import("@/pages/join-doctor"));
const FindDoctors = lazy(() => import("@/pages/find-doctors"));
const LegalPage = lazy(() => import("@/pages/legal"));
const Welcome = lazy(() => import("@/pages/welcome"));
const Notifications = lazy(() => import("@/pages/notifications"));
const DoctorProfile = lazy(() => import("@/pages/doctor-profile"));
const AdminActivity = lazy(() => import("@/pages/admin-activity"));
const AdminDashboard = lazy(() => import("@/pages/admin-dashboard"));
const DoctorHome = lazy(() => import("@/pages/doctor-home"));
const DoctorRequests = lazy(() => import("@/pages/doctor-requests"));
const DoctorPatients = lazy(() => import("@/pages/doctor-patients"));
const DoctorPatientWorkspace = lazy(() => import("@/pages/doctor-patient-workspace"));
const DoctorAppointments = lazy(() => import("@/pages/doctor-appointments"));
const DoctorAvailability = lazy(() => import("@/pages/doctor-availability"));
const ForgotPassword = lazy(() => import("@/pages/forgot-password"));
const ResetPassword = lazy(() => import("@/pages/reset-password"));
const SymptomEntry = lazy(() => import("@/pages/symptom-entry"));
const MatchResults = lazy(() => import("@/pages/match-results"));
const ChatPage = lazy(() => import("@/pages/chat"));
const Sos = lazy(() => import("@/pages/sos"));

const SimpleHome = lazy(() => import("@/pages/simple-home"));
const DoctorsDirectory = lazy(() => import("@/pages/doctors-directory"));
const CareTeam = lazy(() => import("@/pages/care-team"));
const Appointments = lazy(() => import("@/pages/appointments"));
const AppointmentDetail = lazy(() => import("@/pages/appointment-detail"));
const MessagesList = lazy(() => import("@/pages/messages-list"));
const Medications = lazy(() => import("@/pages/medications"));
const Prescriptions = lazy(() => import("@/pages/prescriptions"));
const Pharmacy = lazy(() => import("@/pages/pharmacy"));
const Timeline = lazy(() => import("@/pages/timeline"));
const Documents = lazy(() => import("@/pages/documents"));
const Assistant = lazy(() => import("@/pages/assistant"));
const Profile = lazy(() => import("@/pages/profile"));
const CareCircle = lazy(() => import("@/pages/care-circle"));
const AcceptCareCircleInvite = lazy(() => import("@/pages/accept-care-circle-invite"));
const HealthHandoff = lazy(() => import("@/pages/health-handoff"));
const CaregiverDashboard = lazy(() => import("@/pages/caregiver-dashboard"));
const MyHealth = lazy(() => import("@/pages/my-health"));
const Help = lazy(() => import("@/pages/help"));

// Doctor/admin-only screens are lazy-loaded: a patient session (the demo's
// primary path) never pulls this code into its bundle at all.

function RouteLoading() {
  const { t } = useI18n();
  return (
    <div role="status" aria-live="polite" className="flex min-h-screen items-center justify-center text-lg text-muted-foreground">
      {t("common.loading")}
    </div>
  );
}

// Keeps the person's language choice and their account in step: an explicit
// choice on this device wins and is saved to the account; on a new device the
// account's saved language is applied.
function LocaleSync({ user }: { user: AuthUser | null }) {
  const { locale, setLocale } = useI18n();
  useEffect(() => {
    if (!user?.language) return;
    if (hasChosenLocale()) {
      if (user.language !== locale) apiRequest("PATCH", "/api/auth/me/preferences", { language: locale }).catch(() => {});
    } else if (user.language !== locale) {
      setLocale(user.language as typeof locale);
    }
    // Only when the signed-in person changes; later changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  useEffect(() => {
    function onChange(e: Event) {
      if (user) apiRequest("PATCH", "/api/auth/me/preferences", { language: (e as CustomEvent).detail }).catch(() => {});
    }
    window.addEventListener("avela:locale", onChange);
    return () => window.removeEventListener("avela:locale", onChange);
  }, [user]);
  return null;
}

interface ShellProps {
  user: AuthUser;
  refreshUser: () => Promise<void>;
  signOut: () => void;
  simpleMode: boolean;
  setSimpleMode: (value: boolean) => void;
}

function Authenticated({ user, signOut, simpleMode, setSimpleMode, children }: ShellProps & { children: React.ReactNode }) {
  return (
    <AppShell user={user} onSignOut={signOut} simpleMode={simpleMode} onSetSimpleMode={setSimpleMode}>
      {children}
    </AppShell>
  );
}

// Small helper so every gated route reads the same way: render for the
// right role, otherwise bounce to Landing rather than duplicating the
// ternary at each Route below.
function Gate({ user, role, ...shellProps }: { user: AuthUser | null; role: string | string[] } & Omit<ShellProps, "user"> & { children: React.ReactNode }) {
  const roles = Array.isArray(role) ? role : [role];
  if (!user || !roles.includes(user.role)) return <Blocked user={user} />;
  return <Authenticated user={user} {...shellProps} />;
}

// Clinical screens for doctors. A doctor who isn't approved yet is sent to
// their application: nothing clinical is reachable, even by typing the address.
function DoctorGate({ user, ...shellProps }: { user: AuthUser | null } & Omit<ShellProps, "user"> & { children: React.ReactNode }) {
  if (!user || user.role !== "doctor") return <Blocked user={user} />;
  if (user.doctorStatus !== "approved") return <Redirect to="/doctor/application" />;
  return <Authenticated user={user} {...shellProps} />;
}

export const RETURN_TO_KEY = "pdapp_return_to";

// Where someone lands when a screen isn't for them. Signed out: the sign-in
// page, remembering where they were headed so they return there afterwards.
// Signed in but the wrong kind of account: their own home, not a confusing
// marketing page at the wrong address.
function Blocked({ user }: { user: AuthUser | null }) {
  if (!user) {
    try {
      // Only after a session *expired* — never after someone chose to sign
      // out, or the next person to use a shared phone would be sent to the
      // previous person's page.
      const here = window.location.pathname + window.location.search;
      if (sessionStorage.getItem(SESSION_NOTICE_KEY) === "expired" && here !== "/" && here !== "/login") {
        sessionStorage.setItem(RETURN_TO_KEY, here);
      }
    } catch {
      // Remembering the destination is a courtesy only.
    }
    return <Redirect to="/login" />;
  }
  return <Redirect to="/" />;
}

function HomeForRole({ user, simpleMode, ...rest }: ShellProps) {
  if (user.role === "doctor") {
    return (
      <Authenticated user={user} simpleMode={simpleMode} {...rest}>
        {user.doctorStatus === "approved" ? <DoctorHome user={user} /> : <DoctorApplication user={user} onApproved={rest.refreshUser} />}
      </Authenticated>
    );
  }
  if (user.role === "admin") {
    return <Authenticated user={user} simpleMode={simpleMode} {...rest}><AdminDashboard /></Authenticated>;
  }
  if (user.role === "caregiver") {
    return <Authenticated user={user} simpleMode={simpleMode} {...rest}><CaregiverDashboard user={user} /></Authenticated>;
  }
  return (
    <Authenticated user={user} simpleMode={simpleMode} {...rest}>
      {simpleMode ? <SimpleHome user={user} /> : <HomeDashboard user={user} />}
    </Authenticated>
  );
}

function AppContent() {
  const { user, login, demoLogin, signup, registerDoctor, refreshUser, acceptCareCircleInvite, signOut } = useAuth();
  const { simpleMode, setSimpleMode } = useSimpleMode();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (user && ["/login", "/signup", "/join/doctor", "/get-started"].includes(location)) {
      let target = "/";
      try {
        const saved = sessionStorage.getItem(RETURN_TO_KEY);
        sessionStorage.removeItem(RETURN_TO_KEY);
        // Only ever an in-app path — never an address someone else could plant.
        if (saved && saved.startsWith("/") && !saved.startsWith("//")) target = saved;
        // Someone who just created a patient account gets the short welcome first.
        if (user.role === "patient" && sessionStorage.getItem(WELCOME_KEY)) {
          sessionStorage.removeItem(WELCOME_KEY);
          target = "/welcome";
        }
      } catch {
        // fall back to home
      }
      setLocation(target);
    }
  }, [user, location, setLocation]);

  // A doctor waiting for review learns the outcome without signing out and in.
  useEffect(() => {
    if (user?.role !== "doctor" || user.doctorStatus === "approved") return;
    refreshUser();
    const onStatus = () => refreshUser();
    window.addEventListener("avela:doctor-status", onStatus);
    const timer = setInterval(refreshUser, 60_000);
    return () => {
      window.removeEventListener("avela:doctor-status", onStatus);
      clearInterval(timer);
    };
  }, [user?.id, user?.doctorStatus, refreshUser]);

  useDocumentTitle(location);

  // On every navigation: update the page title, and move keyboard/screen
  // reader focus to the new page's main area, so people who can't see the
  // screen change are told it did. (Skipped for the very first load.)
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    requestAnimationFrame(() => document.getElementById("main")?.focus({ preventScroll: false }));
  }, [location]);

  const shellProps = { signOut, simpleMode, setSimpleMode, refreshUser };

  return (
    <ErrorBoundary resetKey={location}>
    <LocaleSync user={user} />
    <Suspense fallback={<RouteLoading />}>
    <Switch>
      <Route path="/">{user ? <HomeForRole user={user} {...shellProps} /> : <Landing />}</Route>
      <Route path="/login">{user ? <HomeForRole user={user} {...shellProps} /> : <Login onLogin={login} onDemoLogin={demoLogin} />}</Route>
      <Route path="/signup">{user ? <HomeForRole user={user} {...shellProps} /> : <Signup onSignup={signup} />}</Route>
      <Route path="/get-started">{user ? <HomeForRole user={user} {...shellProps} /> : <GetStarted />}</Route>
      <Route path="/join/doctor">{user ? <HomeForRole user={user} {...shellProps} /> : <JoinDoctor onRegister={registerDoctor} />}</Route>
      <Route path="/apply-as-doctor"><Redirect to="/join/doctor" /></Route>
      <Route path="/find-doctors">{user?.role === "patient" ? <Redirect to="/doctors" /> : <FindDoctors />}</Route>
      <Route path="/about"><LegalPage page="about" /></Route>
      <Route path="/privacy"><LegalPage page="privacy" /></Route>
      <Route path="/terms"><LegalPage page="terms" /></Route>
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/care-circle/accept">
        <AcceptCareCircleInvite onAccept={acceptCareCircleInvite} />
      </Route>

      <Route path="/symptoms">
        <Gate user={user} role="patient" {...shellProps}><SymptomEntry /></Gate>
      </Route>
      <Route path="/match-results/:reportId">
        {(params) => <Gate user={user} role="patient" {...shellProps}><MatchResults reportId={params.reportId} /></Gate>}
      </Route>
      <Route path="/doctors">
        <Gate user={user} role="patient" {...shellProps}><DoctorsDirectory /></Gate>
      </Route>
      <Route path="/care-team">
        <Gate user={user} role="patient" {...shellProps}><CareTeam /></Gate>
      </Route>
      <Route path="/appointments/:id">
        {(params) => <Gate user={user} role="patient" {...shellProps}><AppointmentDetail id={params.id} /></Gate>}
      </Route>
      <Route path="/appointments">
        <Gate user={user} role="patient" {...shellProps}><Appointments /></Gate>
      </Route>
      <Route path="/messages">
        {user?.role === "patient" ? <Authenticated user={user} {...shellProps}><MessagesList user={user} /></Authenticated> : <Blocked user={user} />}
      </Route>
      <Route path="/medications">
        <Gate user={user} role="patient" {...shellProps}><Medications /></Gate>
      </Route>
      <Route path="/prescriptions">
        <Gate user={user} role="patient" {...shellProps}><Prescriptions /></Gate>
      </Route>
      <Route path="/pharmacy">
        <Gate user={user} role="patient" {...shellProps}><Pharmacy /></Gate>
      </Route>
      <Route path="/timeline">
        <Gate user={user} role="patient" {...shellProps}><Timeline /></Gate>
      </Route>
      <Route path="/documents">
        <Gate user={user} role="patient" {...shellProps}><Documents /></Gate>
      </Route>
      <Route path="/assistant">
        <Gate user={user} role="patient" {...shellProps}><Assistant /></Gate>
      </Route>
      <Route path="/handoff">
        <Gate user={user} role="patient" {...shellProps}><HealthHandoff /></Gate>
      </Route>
      <Route path="/care-circle">
        <Gate user={user} role="patient" {...shellProps}><CareCircle /></Gate>
      </Route>
      <Route path="/profile">
        {user?.role === "patient" ? <Authenticated user={user} {...shellProps}><Profile user={user} /></Authenticated> : <Blocked user={user} />}
      </Route>
      <Route path="/my-health">
        <Gate user={user} role="patient" {...shellProps}><MyHealth /></Gate>
      </Route>
      <Route path="/help">
        {user && ["patient", "doctor", "caregiver"].includes(user.role)
          ? <Authenticated user={user} {...shellProps}><Help /></Authenticated>
          : <PublicLayout><Help signedIn={false} /></PublicLayout>}
      </Route>
      <Route path="/welcome">
        <Gate user={user} role="patient" {...shellProps}>{user && <Welcome name={user.name} />}</Gate>
      </Route>
      <Route path="/notifications">
        {user?.role === "patient" || (user?.role === "doctor" && user.doctorStatus === "approved")
          ? <Authenticated user={user} {...shellProps}><Notifications /></Authenticated>
          : <Blocked user={user} />}
      </Route>
      <Route path="/sos">
        <Gate user={user} role="patient" {...shellProps}><Sos /></Gate>
      </Route>

      <Route path="/chat/:id">
        {(params) =>
          user?.role === "patient" || user?.role === "doctor" ? (
            <Authenticated user={user} {...shellProps}>
              <ChatPage pairingId={params.id} user={user} backHref={user.role === "doctor" ? "/doctor/patients" : "/messages"} />
            </Authenticated>
          ) : (
            <Blocked user={user} />
          )
        }
      </Route>

      <Route path="/caregiver">
        {user?.role === "caregiver" ? <Authenticated user={user} {...shellProps}><CaregiverDashboard user={user} /></Authenticated> : <Blocked user={user} />}
      </Route>

      <Route path="/doctor/requests">
        <DoctorGate user={user} {...shellProps}><DoctorRequests /></DoctorGate>
      </Route>
      <Route path="/doctor/patients/:pairingId">
        {(params) => <DoctorGate user={user} {...shellProps}><DoctorPatientWorkspace pairingId={params.pairingId} /></DoctorGate>}
      </Route>
      <Route path="/doctor/patients">
        <DoctorGate user={user} {...shellProps}><DoctorPatients /></DoctorGate>
      </Route>
      <Route path="/doctor/availability">
        <DoctorGate user={user} {...shellProps}><DoctorAvailability /></DoctorGate>
      </Route>
      <Route path="/doctor/appointments">
        <DoctorGate user={user} {...shellProps}><DoctorAppointments /></DoctorGate>
      </Route>
      <Route path="/doctor/profile">
        <DoctorGate user={user} {...shellProps}><DoctorProfile /></DoctorGate>
      </Route>
      <Route path="/doctor/application">
        {user?.role === "doctor" ? <Authenticated user={user} {...shellProps}><DoctorApplication user={user} onApproved={refreshUser} /></Authenticated> : <Blocked user={user} />}
      </Route>
      <Route path="/doctor">
        {user?.role === "doctor" ? <HomeForRole user={user} {...shellProps} /> : <Blocked user={user} />}
      </Route>

      <Route path="/admin/activity">
        <Gate user={user} role="admin" {...shellProps}><AdminActivity /></Gate>
      </Route>
      <Route path="/admin">
        <Gate user={user} role="admin" {...shellProps}><AdminDashboard /></Gate>
      </Route>
      <Route component={NotFound} />
    </Switch>
    </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TooltipProvider>
          <Toaster />
          <AppContent />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
