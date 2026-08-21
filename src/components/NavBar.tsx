"use client";

import { useRouter } from "next/navigation";

export default function NavBar({ name, role }: { name: string; role: string }) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-6 py-4">
      <span className="font-bold text-blue-600">CareConnect</span>
      <div className="flex items-center gap-3 text-sm">
        <span className="text-neutral-500">
          {name} · {role === "PATIENT" ? "Patient" : "Doctor"}
        </span>
        <button
          onClick={logout}
          className="rounded-full border border-neutral-300 dark:border-neutral-700 px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
