// Not a strength meter: it blocks the passwords people are actually attacked
// with (the most common ones, and ones built from their own email or name),
// while still allowing a memorable phrase of ordinary words.
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "12345678", "123456789", "1234567890", "11111111", "00000000", "qwertyui", "qwerty123",
  "qwertyuiop", "iloveyou", "admin123", "welcome1", "welcome123", "letmein1", "abc12345", "abcd1234", "asdfghjk", "zxcvbnm1", "monkey123",
  "dragon123", "football1", "baseball1", "sunshine1", "princess1", "trustno1", "changeme", "changeme123", "avela123", "demopass123", "demopass123!",
  "123123123", "987654321", "a1b2c3d4", "master123", "login123", "hello123", "whatever1",
]);

export function weakPasswordReason(password: string, who: { email?: string; name?: string } = {}): string | null {
  const p = password.toLowerCase();
  if (COMMON.has(p) || COMMON.has(p.replace(/[^a-z0-9]/g, ""))) return "That password is one of the most common ones. Please choose a few words you'll remember instead.";
  if (/^(.)\1+$/.test(p)) return "Please don't use one character repeated.";
  const local = who.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && p.includes(local)) return "Your password shouldn't contain your email address.";
  const first = who.name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && p === first) return "Your password shouldn't be your name.";
  return null;
}
