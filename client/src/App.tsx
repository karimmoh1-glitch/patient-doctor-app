import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth, type AuthUser } from "@/hooks/use-auth";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Login from "@/pages/login";
import Signup from "@/pages/signup";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import DoctorApplication from "@/pages/doctor-application";
import SymptomEntry from "@/pages/symptom-entry";
import MatchResults from "@/pages/match-results";
import Pairings from "@/pages/pairings";
import ChatPage from "@/pages/chat";
import Sos from "@/pages/sos";
import DoctorDashboard from "@/pages/doctor-dashboard";
import AdminDashboard from "@/pages/admin-dashboard";
import AppShell from "@/components/app-shell";
import { useEffect } from "react";

function Authenticated({ user, signOut, children }: { user: AuthUser; signOut: () => void; children: React.ReactNode }) {
  return (
    <AppShell user={user} onSignOut={signOut}>
      {children}
    </AppShell>
  );
}

function HomeForRole({ user, signOut }: { user: AuthUser; signOut: () => void }) {
  if (user.role === "doctor") {
    return (
      <Authenticated user={user} signOut={signOut}>
        <DoctorDashboard />
      </Authenticated>
    );
  }
  if (user.role === "admin") {
    return (
      <Authenticated user={user} signOut={signOut}>
        <AdminDashboard />
      </Authenticated>
    );
  }
  return (
    <Authenticated user={user} signOut={signOut}>
      <SymptomEntry />
    </Authenticated>
  );
}

function AppContent() {
  const { user, login, signup, signOut } = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    if (user && (location === "/login" || location === "/signup")) {
      setLocation("/");
    }
  }, [user, location, setLocation]);

  return (
    <Switch>
      <Route path="/">{user ? <HomeForRole user={user} signOut={signOut} /> : <Landing />}</Route>
      <Route path="/login">{user ? <HomeForRole user={user} signOut={signOut} /> : <Login onLogin={login} />}</Route>
      <Route path="/signup">{user ? <HomeForRole user={user} signOut={signOut} /> : <Signup onSignup={signup} />}</Route>
      <Route path="/apply-as-doctor" component={DoctorApplication} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/symptoms">
        {user?.role === "patient" ? (
          <Authenticated user={user} signOut={signOut}>
            <SymptomEntry />
          </Authenticated>
        ) : (
          <Landing />
        )}
      </Route>
      <Route path="/match-results/:reportId">
        {(params) =>
          user?.role === "patient" ? (
            <Authenticated user={user} signOut={signOut}>
              <MatchResults reportId={params.reportId} />
            </Authenticated>
          ) : (
            <Landing />
          )
        }
      </Route>
      <Route path="/pairings">
        {user?.role === "patient" ? (
          <Authenticated user={user} signOut={signOut}>
            <Pairings />
          </Authenticated>
        ) : (
          <Landing />
        )}
      </Route>
      <Route path="/doctor">
        {user?.role === "doctor" ? (
          <Authenticated user={user} signOut={signOut}>
            <DoctorDashboard />
          </Authenticated>
        ) : (
          <Landing />
        )}
      </Route>
      <Route path="/chat/:id">
        {(params) =>
          user?.role === "patient" || user?.role === "doctor" ? (
            <Authenticated user={user} signOut={signOut}>
              <ChatPage pairingId={params.id} user={user} backHref={user.role === "doctor" ? "/doctor" : "/pairings"} />
            </Authenticated>
          ) : (
            <Landing />
          )
        }
      </Route>
      <Route path="/sos">
        {user?.role === "patient" ? (
          <Authenticated user={user} signOut={signOut}>
            <Sos />
          </Authenticated>
        ) : (
          <Landing />
        )}
      </Route>
      <Route path="/admin">
        {user?.role === "admin" ? (
          <Authenticated user={user} signOut={signOut}>
            <AdminDashboard />
          </Authenticated>
        ) : (
          <Landing />
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
