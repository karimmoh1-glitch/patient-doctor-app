import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInAs } from "./helpers";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const summary = results.violations.map((v) => `${v.impact}: ${v.id} (${v.nodes.length}) — ${v.help} e.g. ${v.nodes[0]?.target.join(" ")}`);
  if (summary.length) console.log(`[axe] ${label}\n  ` + summary.join("\n  "));
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`), `${label} has serious/critical accessibility violations`).toEqual([]);
}

test.describe("before signing in", () => {
  for (const path of ["/", "/login", "/signup", "/forgot-password", "/apply-as-doctor"]) {
    test(`${path} has no serious accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await scan(page, path);
    });
  }
});

test.describe("a signed-in patient", () => {
  const PAGES = [
    "/", "/care-team", "/appointments", "/my-health", "/help", "/sos", "/symptoms", "/messages",
    "/medications", "/prescriptions", "/pharmacy", "/timeline", "/documents", "/handoff",
    "/care-circle", "/profile", "/assistant", "/doctors",
  ];
  for (const path of PAGES) {
    test(`${path} has no serious accessibility violations`, async ({ page }) => {
      await signInAs(page, "patient@avela.dev");
      await page.goto(path);
      await scan(page, path);
    });
  }
});
