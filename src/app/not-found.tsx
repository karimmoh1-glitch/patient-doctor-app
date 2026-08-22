import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="max-w-md">
        <h1 className="text-2xl font-bold mb-2">Page not found</h1>
        <p className="text-neutral-500 mb-6">
          The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.
        </p>
        <Link
          href="/"
          className="rounded-full bg-blue-600 px-6 py-3 font-medium text-white shadow hover:bg-blue-700 transition"
        >
          Back home
        </Link>
      </div>
    </main>
  );
}
