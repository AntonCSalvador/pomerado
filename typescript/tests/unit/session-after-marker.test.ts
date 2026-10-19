import { expect, it } from "vitest";
import type { AutofillRecipe } from "../../src/destinations/autofill-recipe.js";
import type { AutofillSignedInCheck } from "../../src/destinations/autofill-step.js";
import { sessionAfterMarker } from "../../src/runtime/autofill-replay-pages.js";

// Once the marker confirmed the latest sign-in, a page whose marker names no path and doesn't show
// reads signed out; every other page reads as `sessionOnPage` reads it.

const origin = "https://example.test";
const steps = [
  { page: `${origin}/login`, fields: [{ selector: "#password", slot: "password" as const }] },
];
const noPath: AutofillRecipe = { version: 2, steps, signedIn: { selector: "#identity" } };
const accountPath: AutofillRecipe = {
  version: 2,
  steps,
  signedIn: { selector: "#identity", urlPath: "/account" },
};
const missingAt = (url: string): AutofillSignedInCheck => ({
  signedIn: false,
  failed: "indicator_not_visible",
  url,
});

it.each([
  {
    page: "a marker's own path's page elsewhere",
    check: missingAt(`${origin}/welcome`),
    recipe: accountPath,
    markerConfirmed: true,
    session: "unknown",
  },
  {
    page: "a page off the site",
    check: { signedIn: false, failed: "off_site", url: "https://elsewhere.test/pay" } as const,
    recipe: noPath,
    markerConfirmed: true,
    session: "unknown",
  },
  {
    page: "a page without a no-path marker, before the marker confirmed a sign-in",
    check: missingAt(`${origin}/account`),
    recipe: noPath,
    markerConfirmed: false,
    session: "unknown",
  },
  {
    page: "a page without a no-path marker, once the marker confirmed the sign-in",
    check: missingAt(`${origin}/account`),
    recipe: noPath,
    markerConfirmed: true,
    session: "signed_out",
  },
])("reads $page as $session", ({ check, recipe, markerConfirmed, session }) => {
  expect(sessionAfterMarker(check, recipe, markerConfirmed)).toBe(session);
});
