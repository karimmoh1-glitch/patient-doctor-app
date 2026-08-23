import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import type { AuthUser } from "@/hooks/use-auth";

function navForRole(role: AuthUser["role"]): { href: string; label: string }[] {
  if (role === "patient") {
    return [
      { href: "/symptoms", label: "Find a doctor" },
      { href: "/pairings", label: "My connections" },
    ];
  }
  if (role === "doctor") {
    return [{ href: "/doctor", label: "Requests" }];
  }
  return [{ href: "/admin", label: "Doctor applications" }];
}

export default function AppShell({
  user,
  onSignOut,
  children,
}: {
  user: AuthUser;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const links = navForRole(user.role);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/" className="text-lg font-semibold text-primary">
            MedConnect
          </Link>
          <nav className="flex items-center gap-1">
            {links.map((link) => (
              <Link key={link.href} href={link.href}>
                <Button variant={location === link.href ? "secondary" : "ghost"} size="sm">
                  {link.label}
                </Button>
              </Link>
            ))}
            {user.role === "patient" && (
              <Link href="/sos">
                <Button variant="destructive" size="sm">
                  SOS
                </Button>
              </Link>
            )}
            <span className="mx-2 text-sm text-muted-foreground">{user.name}</span>
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
