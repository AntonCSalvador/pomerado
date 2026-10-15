import { describe, expect, it } from "vitest";
import {
  admitScreenOrigin,
  approvedSignInOrigins,
  providerOrigin,
  signedInCheckOrigin,
  workspaceHost,
  workspaceRelation,
  workspaceToPin,
  type ScreenOriginContext,
} from "../../src/runtime/workspace-origin.js";

const site = "https://app.example.com";
const parent = "example.com";

describe("workspaceHost", () => {
  it.each(["https://acme.example.com", "https://globex.example.com", "https://a.b.example.com"])(
    "accepts the same-site sibling %s",
    (candidate) => {
      expect(workspaceHost(site, parent, candidate)).toBe(true);
    },
  );

  it.each([
    ["the site's own host", site, site, parent],
    ["an http origin", site, "http://acme.example.com", parent],
    ["an origin with user info", site, "https://user@acme.example.com", parent],
    ["an origin with a path", site, "https://acme.example.com/login", parent],
    ["a trailing slash", site, "https://acme.example.com/", parent],
    ["another registrable domain", site, "https://acme.example.org", parent],
    ["a look-alike domain", site, "https://acme.notexample.com", parent],
    ["another user's page on a private suffix", "https://a.github.io", "https://b.github.io", "a.github.io"],
    ["a site whose host is a bare suffix", "https://github.io", "https://b.github.io", "github.io"],
    ["a parent that is not the site's", site, "https://acme.example.com", "example.org"],
    ["a parent that is a suffix of the site's", site, "https://acme.example.com", "com"],
    ["text that is not an origin", site, "acme.example.com", parent],
  ])("refuses %s", (_case, siteOrigin, candidate, relationParent) => {
    expect(workspaceHost(siteOrigin, relationParent, candidate)).toBe(false);
  });
});

describe("providerOrigin", () => {
  it("accepts an exact cross-site https origin", () => {
    expect(providerOrigin(site, "https://id.example.net")).toBe(true);
  });

  it.each([
    "https://id.example.com",
    "http://id.example.net",
    "https://user@id.example.net",
    "https://id.example.net/signin",
    "not an origin",
  ])("refuses %s", (candidate) => {
    expect(providerOrigin(site, candidate)).toBe(false);
  });
});

describe("a recipe's relations for its site", () => {
  it("keeps a workspace relation only on the site's own registrable domain", () => {
    expect(workspaceRelation({ workspace: { parent } }, site)).toEqual({ parent });
    expect(workspaceRelation({ workspace: { parent: "example.org" } }, site)).toBeUndefined();
    expect(workspaceRelation({ workspace: { parent: "github.io" } }, "https://github.io")).toBeUndefined();
    expect(workspaceRelation({}, site)).toBeUndefined();
  });

  it("keeps only cross-site sign-in origins", () => {
    expect(
      approvedSignInOrigins(
        { signInOrigins: ["https://id.example.net", "https://auth.example.com"] },
        site,
      ),
    ).toEqual(["https://id.example.net"]);
  });
});

describe("admitScreenOrigin", () => {
  const relation = { parent };
  const context = (overrides: Partial<ScreenOriginContext> = {}): ScreenOriginContext => ({
    siteOrigin: site,
    relation,
    pinned: undefined,
    candidate: undefined,
    identifierSent: false,
    ...overrides,
  });
  const shared = { page: `${site}/login` };
  const workspace = { origin: "workspace" as const, page: "/login/password" };

  it("admits an exact screen on its own origin, or on the login's pinned workspace", () => {
    expect(admitScreenOrigin(context(), shared, site)).toEqual({ admitted: true });
    expect(
      admitScreenOrigin(context({ pinned: "https://acme.example.com" }), shared, "https://acme.example.com"),
    ).toEqual({ admitted: true });
  });

  it("refuses a workspace host on an exact screen when no workspace is pinned", () => {
    expect(admitScreenOrigin(context(), shared, "https://evil.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
    expect(
      admitScreenOrigin(context({ pinned: "https://acme.example.com" }), shared, "https://evil.example.com"),
    ).toEqual({ admitted: false, reason: "screen_origin_changed", sibling: true });
    expect(admitScreenOrigin(context({ relation: undefined }), shared, "https://evil.example.com")).toEqual(
      { admitted: false, reason: "screen_origin_changed", sibling: true },
    );
  });

  it("learns a workspace host only after the identifier went out on an exact screen", () => {
    expect(
      admitScreenOrigin(context({ identifierSent: true }), workspace, "https://acme.example.com"),
    ).toEqual({ admitted: true, learned: "https://acme.example.com" });
    expect(admitScreenOrigin(context(), workspace, "https://acme.example.com")).toEqual({
      admitted: false,
      reason: "workspace_unverified",
      sibling: true,
    });
    expect(
      admitScreenOrigin(context({ candidate: "https://acme.example.com" }), workspace, "https://acme.example.com"),
    ).toEqual({ admitted: true });
  });

  it("refuses a workspace screen without a valid relation, and off the site", () => {
    expect(
      admitScreenOrigin(
        context({ relation: undefined, identifierSent: true }),
        workspace,
        "https://acme.example.com",
      ),
    ).toMatchObject({ admitted: false, reason: "screen_origin_changed" });
    expect(
      admitScreenOrigin(context({ identifierSent: true }), workspace, "https://acme.example.org"),
    ).toEqual({ admitted: false, reason: "screen_origin_changed", sibling: false });
  });
});

describe("signedInCheckOrigin", () => {
  const base = {
    siteOrigin: site,
    relation: { parent },
    pinned: undefined,
    candidate: undefined,
    current: undefined,
    credentialsSent: false,
  };

  it("opens the account page where this login's workspace is", () => {
    expect(signedInCheckOrigin({ ...base, relation: undefined, current: "https://acme.example.com" })).toBe(site);
    expect(signedInCheckOrigin({ ...base, candidate: "https://acme.example.com" })).toBe(
      "https://acme.example.com",
    );
    expect(signedInCheckOrigin({ ...base, current: "https://acme.example.com" })).toBe(
      "https://acme.example.com",
    );
    // Another workspace than the pinned one counts only after this replay sent the credentials.
    const pinned = { ...base, pinned: "https://acme.example.com", current: "https://globex.example.com" };
    expect(signedInCheckOrigin(pinned)).toBe("https://acme.example.com");
    expect(signedInCheckOrigin({ ...pinned, credentialsSent: true })).toBe("https://globex.example.com");
    expect(signedInCheckOrigin(base)).toBe(site);
  });

  it("pins only a workspace host other than the site's", () => {
    expect(workspaceToPin(site, { parent }, "https://acme.example.com")).toBe("https://acme.example.com");
    expect(workspaceToPin(site, { parent }, site)).toBeUndefined();
    expect(workspaceToPin(site, undefined, "https://acme.example.com")).toBeUndefined();
  });
});
