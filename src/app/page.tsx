import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function Home() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="max-w-lg">
        <h1 className="text-4xl font-bold tracking-tight text-blue-600">CareConnect</h1>
        <p className="mt-4 text-lg text-neutral-600 dark:text-neutral-300">
          Tell us what&rsquo;s wrong, by voice or text, and we&rsquo;ll connect you with
          a nearby doctor &mdash; or your own doctor, if you already have one.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/signup"
            className="rounded-full bg-blue-600 px-6 py-3 font-medium text-white shadow hover:bg-blue-700 transition"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="rounded-full border border-neutral-300 dark:border-neutral-700 px-6 py-3 font-medium hover:bg-neutral-100 dark:hover:bg-neutral-900 transition"
          >
            Log in
          </Link>
        </div>
      </div>
    </main>
  );
}
