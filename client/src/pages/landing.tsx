import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import PublicLayout from "@/components/public-layout";
import { useAppConfig } from "@/hooks/use-app-config";

const STEPS = [
  { n: "1", title: "Tell us what you need", body: "Type it, or speak it. Say it in your own words." },
  { n: "2", title: "Choose a doctor", body: "We show doctors in your state who may be able to help, and why." },
  { n: "3", title: "Book a time", body: "Pick from times your doctor has set aside. You can change it later." },
];

export default function Landing() {
  const config = useAppConfig();
  return (
    <PublicLayout>
      <div className="space-y-10 py-4">
        <section className="space-y-5">
          <h1 className="text-4xl font-semibold leading-tight">Find a doctor and manage your care, simply.</h1>
          <p className="text-xl text-muted-foreground">
            Avela helps you find a doctor in your state, book a visit, and keep your medicines and appointments in one place. A family member can help, if you choose.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg"><Link href="/signup">Create an account</Link></Button>
            <Button asChild size="lg" variant="outline"><Link href="/login">I already have an account</Link></Button>
          </div>
        </section>

        <section aria-labelledby="how" className="space-y-4">
          <h2 id="how" className="text-2xl font-semibold">How it works</h2>
          <ol className="space-y-4">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-4 rounded-xl border-2 border-input bg-card p-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground" aria-hidden="true">{s.n}</span>
                <div>
                  <p className="text-xl font-semibold">{s.title}</p>
                  <p className="text-muted-foreground">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="honest" className="space-y-3 rounded-xl border-2 border-input bg-card p-5">
          <h2 id="honest" className="text-2xl font-semibold">What to know first</h2>
          <ul className="list-disc space-y-2 pl-6 text-lg">
            <li>You can phone or message a doctor once they accept your request.</li>
            <li>Doctors reply when they can. It may take a day or more.</li>
            <li>Video visits are not available in Avela yet.</li>
            <li>You choose what each doctor can see, and you can change your mind.</li>
          </ul>
        </section>

        {config?.demoMode && (
          <p role="note" className="rounded-xl border-2 border-dashed border-input p-4 text-muted-foreground">
            <strong>Demonstration site.</strong> The people, doctors and pharmacies here are made up, and no real medical service is provided.
          </p>
        )}
      </div>
    </PublicLayout>
  );
}
