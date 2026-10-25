import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getLocale, translate } from "@/lib/i18n";

/** Fired when a request that carried a login token comes back 401: the session ended. */
export const SESSION_EXPIRED_EVENT = "pdapp:session-expired";

/**
 * The request never reached the server (offline, dropped connection, server
 * down). Distinguished from an error *response* so the UI can say "check your
 * connection" rather than blaming the user's input, and so it's safe to retry.
 */
export class NetworkError extends Error {
  constructor() {
    super(
      typeof navigator !== "undefined" && navigator.onLine === false
        ? translate(getLocale(), "neterr.offline")
        : translate(getLocale(), "neterr.unreachable"),
    );
    this.name = "NetworkError";
  }
}

// The browser's own time zone travels with every request so the server can
// work out "today" and "next dose" as the person actually lives them.
function timezoneHeader(): Record<string, string> {
  try {
    return { "X-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch {
    return {};
  }
}

function getAuthHeaders(): Record<string, string> {
  try {
    const stored = localStorage.getItem("pdapp_auth");
    if (stored) {
      const auth = JSON.parse(stored);
      if (auth?.token) return { Authorization: `Bearer ${auth.token}`, ...timezoneHeader() };
    }
  } catch {
    // Corrupt or inaccessible storage: behave as signed out rather than crash.
  }
  return {};
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const hadToken = !!(init.headers as Record<string, string> | undefined)?.Authorization;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new NetworkError();
  }
  if (res.status === 401 && hadToken) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return res;
}

async function throwIfResNotOk(res: Response) {
  if (res.ok) return;
  let message = res.statusText || translate(getLocale(), "common.error.generic");
  try {
    const data = await res.json();
    if (data?.message) message = data.message;
  } catch {
    // non-JSON error body (e.g. a proxy/HTML error page) — keep the fallback
  }
  throw new Error(message);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...getAuthHeaders(),
  };
  if (data) {
    headers["Content-Type"] = "application/json";
  }

  const res = await request(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await request(queryKey.join("/") as string, {
      headers: getAuthHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 30000,
      // Only a dropped connection is worth retrying automatically; a 4xx/5xx
      // answer is a real answer and retrying it just delays the message.
      retry: (failureCount, error) => error instanceof NetworkError && failureCount < 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    },
    mutations: {
      retry: false,
    },
  },
});
