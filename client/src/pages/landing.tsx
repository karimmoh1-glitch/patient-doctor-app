import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <div className="max-w-xl space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight">Tell us what's wrong. We'll find your doctor.</h1>
        <p className="text-lg text-muted-foreground">
          Type or speak your symptoms and your state, and MedConnect matches you with licensed doctors
          near you — ready to connect.
        </p>
      </div>
      <div className="flex gap-3">
        <Link href="/signup">
          <Button size="lg">Get started as a patient</Button>
        </Link>
        <Link href="/login">
          <Button size="lg" variant="outline">
            Log in
          </Button>
        </Link>
      </div>
      <Link href="/apply-as-doctor" className="text-sm text-primary underline-offset-4 hover:underline">
        Are you a doctor? Apply to join MedConnect
      </Link>
      <p className="max-w-md text-xs text-muted-foreground">
        MedConnect is not for medical emergencies. If this is an emergency, call 911 or go to your
        nearest emergency room.
      </p>
    </div>
  );
}
