import { getLocale, translate } from "@/lib/i18n";

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString(getLocale(), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString(getLocale(), { month: "short", day: "numeric", year: "numeric" });
}

export function formatTime(value: string | Date): string {
  return new Date(value).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
}

export function formatRelativeDay(value: string | Date): string {
  const date = new Date(value);
  const now = new Date();
  const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((dateDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return `Today, ${formatTime(date)}`;
  if (diffDays === 1) return `Tomorrow, ${formatTime(date)}`;
  if (diffDays === -1) return `Yesterday, ${formatTime(date)}`;
  return formatDateTime(date);
}

export function timeAgo(value: string | Date): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(value);
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return translate(getLocale(), "greeting.morning");
  if (hour < 18) return translate(getLocale(), "greeting.afternoon");
  return translate(getLocale(), "greeting.evening");
}

/** "20:00" -> "8:00 PM" in the viewer's locale. Server doses are stored as 24-hour HH:MM strings. */
export function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });
}
