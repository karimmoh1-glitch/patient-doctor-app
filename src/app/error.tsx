"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="max-w-md">
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-neutral-500 mb-6">
          {error.message || "An unexpected error occurred. Please try again."}
        </p>
        <button
          onClick={reset}
          className="rounded-full bg-blue-600 px-6 py-3 font-medium text-white shadow hover:bg-blue-700 transition"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
