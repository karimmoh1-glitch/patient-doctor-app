// Human page names, used for the browser tab/title (WCAG 2.4.2) and so a
// screen reader announces where you've landed after each navigation.
const TITLES: [prefix: string, title: string][] = [
  ["/care-circle/accept", "Accept an invitation"],
  ["/care-circle", "Family and helpers"],
  ["/care-team", "My doctors"],
  ["/appointments", "Appointments"],
  ["/my-health", "My health"],
  ["/medications", "Today's medicines"],
  ["/prescriptions", "Prescriptions"],
  ["/pharmacy", "Pharmacy"],
  ["/timeline", "Health timeline"],
  ["/documents", "Documents"],
  ["/handoff", "Share a summary"],
  ["/assistant", "Questions about my care"],
  ["/profile", "Profile and privacy"],
  ["/messages", "Messages"],
  ["/chat", "Conversation"],
  ["/symptoms", "Find a doctor"],
  ["/match-results", "Doctors for you"],
  ["/doctors", "Find a doctor"],
  ["/help", "Help"],
  ["/sos", "Emergency"],
  ["/login", "Sign in"],
  ["/signup", "Create an account"],
  ["/forgot-password", "Reset your password"],
  ["/reset-password", "Choose a new password"],
  ["/apply-as-doctor", "Apply as a doctor"],
  ["/doctor/requests", "Requests"],
  ["/doctor/patients", "Patients"],
  ["/doctor/appointments", "Appointments"],
  ["/doctor/availability", "My hours"],
  ["/doctor", "Home"],
  ["/caregiver", "Care Circle"],
  ["/admin", "Doctor applications"],
];

export function titleForPath(path: string): string {
  if (path === "/") return "Home";
  const hit = TITLES.find(([prefix]) => path === prefix || path.startsWith(prefix + "/"));
  return hit ? hit[1] : "Page not found";
}
