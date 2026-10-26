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
 * Refuses to start a PRODUCTION server whose configuration could expose demo
 * accounts or simulated features to real people.
 *
 * Demo mode in production needs a second, deliberate switch,
 * DEMO_MODE_ACKNOWLEDGED=true, that says the service holds no real patient
 * data. Forgetting it stops the server instead of silently running a demo.
 * Anything other than "true" for DEMO_MODE (or nothing at all) means real mode.
 */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (env.DEMO_MODE === "true" && env.DEMO_MODE_ACKNOWLEDGED !== "true") {
    throw new Error(
      "DEMO_MODE=true in production also requires DEMO_MODE_ACKNOWLEDGED=true, which states that this deployment holds no real patient data. Refusing to start.",
    );
  }
  if (env.DEMO_MODE === "true") {
    console.warn("[DEMO MODE] This deployment is a demonstration: demo accounts and simulated features are enabled. It must never hold real patient data.");
  }
}

/**
 * Patient health information may only be sent to a third-party AI provider
 * when the operator has affirmatively confirmed the legal basis (for example
 * a signed BAA / zero-retention agreement). An API key alone is not consent.
 */
export function canSendPhiToAiProvider(): boolean {
  return !!process.env.OPENAI_API_KEY && process.env.AI_PHI_PROCESSING_CONFIRMED === "true";
}
