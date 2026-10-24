import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import PublicLayout from "@/components/public-layout";
import PasswordField from "@/components/password-field";
import { SPECIALTIES, US_STATES } from "@shared/specialties";
import { parseErrorMessage } from "@/lib/api-error";

export default function DoctorApplication() {
  const [form, setForm] = useState({ name: "", email: "", password: "", licenseNumber: "", state: "", npiNumber: "", specialty: "", phone: "", bio: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/doctors/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name, email: form.email, password: form.password, licenseNumber: form.licenseNumber,
          licensedStates: [form.state], npiNumber: form.npiNumber || undefined, specialty: form.specialty, phone: form.phone, bio: form.bio,
        }),
      });
      if (!res.ok) throw new Error(await parseErrorMessage(res, "We couldn't send your application."));
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <PublicLayout narrow>
        <h1 className="mb-3 text-3xl font-semibold">Application received</h1>
        <p role="status" className="text-lg text-muted-foreground">
          An administrator will review your details before your profile is shown to patients. We can't say how long that takes. You can't sign in until it is approved; we'll email you at {form.email} when it is decided.
        </p>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout narrow>
      <h1 className="mb-2 text-3xl font-semibold">Apply as a doctor</h1>
      <p className="mb-6 text-lg text-muted-foreground">
        Your application is reviewed by a person before your profile goes live. Your licence details are checked by hand; they are not looked up automatically.
      </p>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name" className="text-base">Full name</Label>
          <Input id="name" autoComplete="name" value={form.name} onChange={(e) => set("name")(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email" className="text-base">Email address</Label>
          <Input id="email" type="email" autoComplete="username" value={form.email} onChange={(e) => set("email")(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password" className="text-base">Choose a password</Label>
          <PasswordField id="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={8} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="license" className="text-base">Medical licence number</Label>
          <Input id="license" value={form.licenseNumber} onChange={(e) => set("licenseNumber")(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="npi" className="text-base">NPI number (if you have one)</Label>
          <Input id="npi" value={form.npiNumber} onChange={(e) => set("npiNumber")(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="state" className="text-base">State you are licensed in</Label>
          <NativeSelect id="state" value={form.state} onChange={(e) => set("state")(e.target.value)} required>
            <option value="">Choose a state</option>
            {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="specialty" className="text-base">Your speciality</Label>
          <NativeSelect id="specialty" value={form.specialty} onChange={(e) => set("specialty")(e.target.value)} required>
            <option value="">Choose a speciality</option>
            {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone" className="text-base">Phone number patients can call after you accept them</Label>
          <Input id="phone" type="tel" autoComplete="tel" value={form.phone} onChange={(e) => set("phone")(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bio" className="text-base">A short introduction (optional)</Label>
          <Textarea id="bio" value={form.bio} onChange={(e) => set("bio")(e.target.value)} rows={4} />
        </div>
        {error && <p role="alert" className="rounded-lg border-2 border-destructive p-3 font-medium text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={loading}>{loading ? "Sending…" : "Send my application"}</Button>
      </form>
    </PublicLayout>
  );
}
