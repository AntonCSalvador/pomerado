import { expect, it } from "vitest";
import {
  signInOriginDecision,
  signInOriginReview,
  workspaceOriginDecision,
  workspaceOriginReview,
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

it("asks only for the outcomes and labels each kind decides, privately", () => {
  const path = [{ role: "site" as const, origin: "https://app.example.com", pathname: "/login", stage: "entry" as const }];
  const workspace = workspaceOriginReview({
    siteOrigin: "https://app.example.com",
    parent: "example.com",
    candidateOrigin: "https://acme.example.com",
    path,
    sentBefore: "identifier",
    intent: "Read the account's invoices.",
  });
  expect(workspace).toMatchObject({
    kind: "workspace_origin",
    outcomes: ["allow", "deny"],
    labels: ["workspace", "shared_host"],
    private: true,
  });
  const provider = signInOriginReview({
    siteOrigin: "https://app.example.com",
    providerOrigin: "https://id.example.net",
    path,
    screen: { fields: [] },
    intent: "Read the account's invoices.",
  });
  expect(provider).toMatchObject({ kind: "sign_in_origin", outcomes: ["allow", "deny"], private: true });
  expect(provider.labels).toBeUndefined();
});
