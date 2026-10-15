import { expect, it } from "vitest";
import {
  providerReachedBySite,
  signInOriginDecision,
  workspaceOriginDecision,
  type SignInNavigation,
  type SignInPathEntry,
} from "../../src/guardian/sign-in-origin-reviews.js";

const rationale = "The site's own sign-in sent this account there.";

it.each([
  [{ outcome: "allow", label: "workspace" }, "workspace"],
  [{ outcome: "allow", label: "shared_host" }, "shared_host"],
  // An allow that does not say which kind of host it is trusts nothing.
  [{ outcome: "allow" }, "deny"],
  [{ outcome: "allow", label: "something_else" }, "deny"],
  [{ outcome: "deny" }, "deny"],
  [{ outcome: "deny", label: "workspace" }, "deny"],
  [{ outcome: "deny", label: "unrecognized" }, "deny"],
  [{ outcome: "allow", label: "unrecognized" }, "deny"],
] as const)("a workspace_origin decision %o is %s", (decision, expected) => {
  expect(workspaceOriginDecision({ rationale, ...decision })).toBe(expected);
});

it.each([
  [{ outcome: "allow" }, "allow"],
  [{ outcome: "deny" }, "deny"],
  [{ outcome: "escalate" }, "deny"],
] as const)("a sign_in_origin decision %o is %s", (decision, expected) => {
  expect(signInOriginDecision({ rationale, ...decision })).toBe(expected);
});

const provider = "https://id.example.net";
const entry = (
  role: SignInPathEntry["role"],
  origin: string,
  via: SignInNavigation,
): SignInPathEntry => ({ role, origin, pathname: "/login", stage: "screen", via });
const site = entry("site", "https://app.example.com", "agent_navigation");

it.each([
  ["redirect", true],
  ["form_submit", true],
  ["link", false],
  ["agent_navigation", false],
  ["unknown", false],
] as const)("a provider first reached by %s is reached by the site: %s", (via, expected) => {
  expect(providerReachedBySite([site, entry("provider", provider, via)], provider)).toBe(expected);
});

it("refuses a provider the path never reached", () => {
  expect(providerReachedBySite([site, entry("provider", "https://id.example.org", "redirect")], provider)).toBe(
    false,
  );
});

it("judges a provider by the first entry on its origin only", () => {
  // Reached by a link first, a later redirect back to it does not make the site lead there.
  expect(
    providerReachedBySite(
      [site, entry("provider", provider, "link"), site, entry("provider", provider, "redirect")],
      provider,
    ),
  ).toBe(false);
  expect(
    providerReachedBySite(
      [site, entry("provider", provider, "redirect"), entry("provider", provider, "agent_navigation")],
      provider,
    ),
  ).toBe(true);
});
