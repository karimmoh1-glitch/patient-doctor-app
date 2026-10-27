import { devIdentityKey, signAssertion } from "../server/identity";

/** What the application would send for this identity, signed with the (publicly known) development key the test databases are given. */
export function assertionFor(who: { userId?: string; system?: boolean }): string {
  return signAssertion(who.system ? { system: true } : who.userId ? { userId: who.userId } : undefined, devIdentityKey()) ?? "";
}
