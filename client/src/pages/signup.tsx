import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import { US_STATES } from "@shared/specialties";

export default function Signup({
  onSignup,
}: {
  onSignup: (name: string, email: string, password: string, state: string) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!state) {
      setError("Please choose the state where you live. We use it to show you doctors who can treat you there.");
      return;
    }
    setLoading(true);
    try {
      await onSignup(name, email, password, state);
    } catch (err: any) {
      setError(err.message || "We couldn't create your account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <PublicLayout narrow>
      <h1 className="mb-2 text-3xl font-semibold">Create your account</h1>
      <p className="mb-6 text-lg text-muted-foreground">It takes about a minute. You can add more later.</p>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name" className="text-base">Your name</Label>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-base">Email address</Label>
          <Input id="email" type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="state" className="text-base">State where you live</Label>
          <NativeSelect id="state" value={state} onChange={(e) => setState(e.target.value)} required aria-describedby="state-help">
            <option value="">Choose your state</option>
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
          <p id="state-help" className="text-muted-foreground">Doctors can usually only treat people who are in the state where they are licensed.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password" className="text-base">Choose a password</Label>
          <PasswordField id="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} describedBy="password-help" />
          <p id="password-help" className="text-muted-foreground">At least 8 characters. A few words you will remember works well.</p>
        </div>
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? "Creating your account…" : "Create my account"}</Button>
      </form>
      <p className="mt-5 text-lg">
        Already have an account?{" "}
        <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4">Sign in</Link>
      </p>
    </PublicLayout>
  );
}
