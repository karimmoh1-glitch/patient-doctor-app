import { devIdentityKey, signAssertion, type SystemScope } from "../server/identity";

/** What the application would send for this identity, signed with the (publicly known) development key the test databases are given. */
export function assertionFor(who: { userId?: string; system?: boolean; scope?: SystemScope }): string {
  return signAssertion(who.system || who.scope ? { system: true, scope: who.scope } : who.userId ? { userId: who.userId } : undefined, devIdentityKey()) ?? "";
}
