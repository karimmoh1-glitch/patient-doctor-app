// Centralised, explicit switches for behaviour that must never be on by
// accident in a real deployment.

/**
 * Demo mode enables simulated integrations (e.g. the fake pharmacy
 * "advance order" control) and demo data conveniences. It is on for local
 * development and tests, and in any other environment only when
 * DEMO_MODE=true is set deliberately — so a real deployment cannot expose
 * controls that let a patient mark their own order "delivered".
 */
export function isDemoMode(): boolean {
  if (process.env.DEMO_MODE === "false") return false; // explicit opt-out wins (used by tests too)
  return (
    process.env.DEMO_MODE === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  );
}

/**
 * Patient health information may only be sent to a third-party AI provider
 * when the operator has affirmatively confirmed the legal basis (for example
 * a signed BAA / zero-retention agreement). An API key alone is not consent.
 */
export function canSendPhiToAiProvider(): boolean {
  return !!process.env.OPENAI_API_KEY && process.env.AI_PHI_PROCESSING_CONFIRMED === "true";
}
