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
import { titleForPath } from "@/lib/route-titles";
import { I18nProvider } from "@/lib/i18n";
import HomeDashboard from "@/pages/home-dashboard";

const DoctorApplication = lazy(() => import("@/pages/doctor-application"));
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
  return (
    <div role="status" aria-live="polite" className="flex min-h-screen items-center justify-center text-lg text-muted-foreground">
      Loading…
    </div>
  );
}

interface ShellProps {
  user: AuthUser;
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
    return <Authenticated user={user} simpleMode={simpleMode} {...rest}><DoctorHome user={user} /></Authenticated>;
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
  const { user, login, demoLogin, signup, acceptCareCircleInvite, signOut } = useAuth();
  const { simpleMode, setSimpleMode } = useSimpleMode();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (user && (location === "/login" || location === "/signup")) {
      let target = "/";
      try {
        const saved = sessionStorage.getItem(RETURN_TO_KEY);
        sessionStorage.removeItem(RETURN_TO_KEY);
        // Only ever an in-app path — never an address someone else could plant.
        if (saved && saved.startsWith("/") && !saved.startsWith("//")) target = saved;
      } catch {
        // fall back to home
      }
      setLocation(target);
    }
  }, [user, location, setLocation]);

  // On every navigation: update the page title, and move keyboard/screen
  // reader focus to the new page's main area, so people who can't see the
  // screen change are told it did. (Skipped for the very first load.)
  const firstRender = useRef(true);
  useEffect(() => {
    document.title = `${titleForPath(location)} · Avela`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    requestAnimationFrame(() => document.getElementById("main")?.focus({ preventScroll: false }));
  }, [location]);

  const shellProps = { signOut, simpleMode, setSimpleMode };

  return (
    <ErrorBoundary resetKey={location}>
    <Suspense fallback={<RouteLoading />}>
    <Switch>
      <Route path="/">{user ? <HomeForRole user={user} {...shellProps} /> : <Landing />}</Route>
      <Route path="/login">{user ? <HomeForRole user={user} {...shellProps} /> : <Login onLogin={login} onDemoLogin={demoLogin} />}</Route>
      <Route path="/signup">{user ? <HomeForRole user={user} {...shellProps} /> : <Signup onSignup={signup} />}</Route>
      <Route path="/apply-as-doctor" component={DoctorApplication} />
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
        <Gate user={user} role={["patient", "doctor", "caregiver"]} {...shellProps}><Help /></Gate>
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
        <Gate user={user} role="doctor" {...shellProps}><DoctorRequests /></Gate>
      </Route>
      <Route path="/doctor/patients/:pairingId">
        {(params) => <Gate user={user} role="doctor" {...shellProps}><DoctorPatientWorkspace pairingId={params.pairingId} /></Gate>}
      </Route>
      <Route path="/doctor/patients">
        <Gate user={user} role="doctor" {...shellProps}><DoctorPatients /></Gate>
      </Route>
      <Route path="/doctor/availability">
        <Gate user={user} role="doctor" {...shellProps}><DoctorAvailability /></Gate>
      </Route>
      <Route path="/doctor/appointments">
        <Gate user={user} role="doctor" {...shellProps}><DoctorAppointments /></Gate>
      </Route>
      <Route path="/doctor">
        {user?.role === "doctor" ? <Authenticated user={user} {...shellProps}><DoctorHome user={user} /></Authenticated> : <Blocked user={user} />}
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
