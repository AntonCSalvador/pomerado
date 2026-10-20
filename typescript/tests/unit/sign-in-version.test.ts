// Failure modes covered: a version one account's sign-in recorded publishes a selector, page, entry
// URL or marker that names that account, in a path or a host label, or copies a masked contact or
// number; a marker a signed-out page shows, or a URL path alone that a sign-in page has, passes; a
// step, or an account page the marker opens, that signs out passes; an entry URL that is one
// authorization request, or carries credentials, passes; an entry URL, page or popup on another
// site or over http, or a workspace step without a workspace relation for the site, passes; a
// recipe no host reads, such as one with no steps or a workspace page that names a host, passes; a
// workspace step under a valid relation is refused; a one-time entry URL the host already asked
// about is refused, for its spent values too.
import { describe, expect, it } from "vitest";
import {
  checkSignInVersion,
  type SignInVersion,
  type SignInVersionInput,
} from "../../src/mint/sign-in-version.js";

const site = "https://www.example.com";

const version: SignInVersion = {
  entryUrl: "https://www.example.com/login",
  recipe: {
    version: 1,
    steps: [
      {
        page: "https://www.example.com/login",
        fields: [{ selector: "#email", accepts: ["email"] }],
        submit: "button[type=submit]",
      },
      {
        page: "https://login.example.com/password",
        fields: [{ selector: "#password", slot: "password" }],
        submit: "#sign-in",
      },
    ],
    signedIn: { selector: "[data-testid=account-menu]", openPath: "/account" },
  },
};

/** A version whose sign-in continues on each login's own workspace host on the site's domain. */
const workspaceVersion: SignInVersion = {
  ...version,
  recipe: {
    version: 4,
    workspace: { parent: "example.com" },
    steps: [
      version.recipe.steps[0]!,
      {
        origin: "workspace",
        page: "/password",
        fields: [{ selector: "#password", slot: "password" }],
        submit: "#next",
      },
    ],
    signedIn: version.recipe.signedIn,
  },
};

const signedOut = {
  url: "https://www.example.com/login?return=%2Faccount",
  dom: '<!doctype html><html><body><form><input id="email"><button type="submit">Next</button></form></body></html>',
};

const input = (
  change: (base: SignInVersion) => SignInVersion = (base) => base,
  extra: Partial<SignInVersionInput> = {},
): SignInVersionInput => ({
  siteOrigin: site,
  version: change(version),
  signedOutSnapshots: [signedOut],
  ...extra,
});

/** The version with one step's parts replaced. */
const withStep = (
  index: number,
  parts: Partial<SignInVersion["recipe"]["steps"][number]>,
): ((base: SignInVersion) => SignInVersion) => (base) => ({
  ...base,
  recipe: {
    ...base.recipe,
    steps: base.recipe.steps.map((step, at) => (at === index ? { ...step, ...parts } : step)),
  } as SignInVersion["recipe"],
});

const withMarker =
  (signedIn: SignInVersion["recipe"]["signedIn"]) =>
  (base: SignInVersion): SignInVersion => ({ ...base, recipe: { ...base.recipe, signedIn } });

describe("checkSignInVersion", () => {
  it("passes a version every account can replay", () => {
    expect(checkSignInVersion(input())).toEqual([]);
  });

  it.each([
    [
      "a method selector copying a masked phone number",
      withStep(1, {
        methods: [
          { method: "sms", selector: "text=Text ***-***-1234" },
          { method: "email", selector: "text=Email me a code" },
        ],
      }),
      [{ rule: "selector_names_contact", part: "recipe.steps[1].methods[0].selector" }],
    ],
    [
      "a field selector holding a long number",
      withStep(0, { fields: [{ selector: "input[name=member-84731922]", accepts: ["email"] }] }),
      [{ rule: "selector_names_contact", part: "recipe.steps[0].fields[0].selector" }],
    ],
    [
      "a rejection marker copying a masked address",
      withStep(0, { rejectedMarkers: [{ slot: "email", selector: "text=j•••@example.com not found" }] }),
      [{ rule: "selector_names_contact", part: "recipe.steps[0].rejectedMarkers[0].selector" }],
    ],
    [
      "a page path holding an account number",
      withStep(1, { page: "https://login.example.com/members/84731922/password" }),
      [{ rule: "page_names_contact", part: "recipe.steps[1].page" }],
    ],
    [
      "a marker holding a masked account",
      withMarker({ selector: "text=Checking ••1234" }),
      [{ rule: "indicator_holds_identity", part: "recipe.signedIn.selector" }],
    ],
  ] as const)("refuses %s", (_name, change, findings) => {
    expect(checkSignInVersion(input(change))).toEqual(findings);
  });

  it("refuses every part naming the recording account's identity, plain or percent-encoded", () => {
    const named = (base: SignInVersion): SignInVersion => ({
      ...withStep(0, { page: "https://www.example.com/login/jane%40example.com" })(base),
      entryUrl: "https://www.example.com/login?hint=jane%40example.com",
    });
    expect(
      checkSignInVersion(
        input(
          (base) => withMarker({ selector: "text=Jane Doe", openPath: "/account" })(named(base)),
          { identities: ["jane@example.com", "Jane Doe", "JD"] },
        ),
      ),
    ).toEqual([
      { rule: "page_names_contact", part: "entryUrl" },
      { rule: "page_names_contact", part: "recipe.steps[0].page" },
      { rule: "indicator_holds_identity", part: "recipe.signedIn.selector" },
    ]);
  });

  it("checks the masked pattern past the origin only, so a port is not a number", () => {
    const ported: SignInVersion = {
      ...version,
      entryUrl: "https://www.example.com:8443/login",
      recipe: {
        ...version.recipe,
        steps: [{ ...version.recipe.steps[0]!, page: "https://www.example.com:8443/login" }],
      },
    };
    expect(checkSignInVersion(input(() => ported))).toEqual([]);
  });

  it.each([
    [
      "a marker a signed-out page shows",
      withMarker({ selector: "#email" }),
      [{ rule: "marker_matches_signed_out_page", part: "recipe.signedIn" }],
    ],
    [
      "a URL path marker on the sign-in page",
      withMarker({ urlPath: "/login" }),
      [
        { rule: "marker_is_login_path", part: "recipe.signedIn.urlPath" },
        { rule: "marker_matches_signed_out_page", part: "recipe.signedIn" },
      ],
    ],
    [
      "a URL path marker on a later sign-in screen",
      withMarker({ urlPath: "/password" }),
      [{ rule: "marker_is_login_path", part: "recipe.signedIn.urlPath" }],
    ],
    [
      "an empty marker",
      withMarker({ openPath: "/account" }),
      [{ rule: "marker_missing", part: "recipe.signedIn" }],
    ],
  ] as const)("refuses %s", (_name, change, findings) => {
    expect(checkSignInVersion(input(change))).toEqual(findings);
  });

  it.each([
    ["a submit that signs out", withStep(1, { submit: "#signOutButton" }), "recipe.steps[1].submit"],
    ["a submit that logs off", withStep(1, { submit: "text=Log off" }), "recipe.steps[1].submit"],
    [
      "a method that signs out",
      withStep(1, { methods: [{ method: "sms", selector: "a.sign-out" }] }),
      "recipe.steps[1].methods[0].selector",
    ],
    ["a logout page", withStep(1, { page: "https://login.example.com/logout" }), "recipe.steps[1].page"],
  ] as const)("refuses %s", (_name, change, part) => {
    expect(checkSignInVersion(input(change))).toEqual([{ rule: "sign_out", part }]);
  });

  it("keeps a sign-out marker and a word that only contains log", () => {
    expect(
      checkSignInVersion(
        input((base) =>
          withMarker({ selector: "button:has-text('Sign out')" })(
            withStep(0, { submit: ".catalog-offers button" })(base),
          ),
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "an authorization request",
      "https://login.example.com/oauth2/authorize?client_id=web&state=Zm9vYmFyMTIzNDU2Nzg5MA",
      [{ rule: "one_time_url", part: "entryUrl" }],
    ],
    [
      "credentials",
      "https://user:secret@www.example.com/login",
      [{ rule: "url_credentials", part: "entryUrl" }],
    ],
    [
      "another site's origin",
      "https://www.example.org/login",
      [{ rule: "foreign_origin", part: "entryUrl" }],
    ],
    [
      "the site's host over http",
      "http://www.example.com/login",
      [{ rule: "insecure_origin", part: "entryUrl" }],
    ],
    [
      "another site's host over http",
      "http://www.example.org/login",
      [
        { rule: "insecure_origin", part: "entryUrl" },
        { rule: "foreign_origin", part: "entryUrl" },
      ],
    ],
  ] as const)("refuses an entry URL with %s", (_name, entryUrl, findings) => {
    expect(checkSignInVersion(input((base) => ({ ...base, entryUrl })))).toEqual(findings);
  });

  it("passes a one-time entry URL only once the host asked about it", () => {
    const authorize = (base: SignInVersion): SignInVersion => ({
      ...base,
      entryUrl:
        "https://login.example.com/oauth2/authorize?client_id=web&state=Zm9vYmFyMTIzNDU2Nzg5MA",
    });
    expect(checkSignInVersion(input(authorize, { entryUrlAsked: true }))).toEqual([]);
    expect(checkSignInVersion(input(authorize, { entryUrlAsked: false }))).toEqual([
      { rule: "one_time_url", part: "entryUrl" },
    ]);
  });

  it("reads an asked one-time entry URL's path alone for masked numbers", () => {
    const asked = (entryUrl: string) =>
      checkSignInVersion(input((base) => ({ ...base, entryUrl }), { entryUrlAsked: true }));
    // A random state of hex digits often holds four digits in a row.
    expect(asked("https://www.example.com/login?state=8f14e45fceea1670")).toEqual([]);
    expect(asked("https://www.example.com/login#state=8f14e45fceea1670")).toEqual([]);
    // A number in the path is still refused, and so is an identity value anywhere past the origin.
    const refused = [{ rule: "page_names_contact", part: "entryUrl" }];
    expect(asked("https://www.example.com/members/84731922/login?state=8f14e45fceea1670")).toEqual(
      refused,
    );
    const named = (base: SignInVersion): SignInVersion => ({
      ...base,
      entryUrl: "https://www.example.com/login?state=8f14e45fceea1670&u=jane",
    });
    expect(
      checkSignInVersion(input(named, { entryUrlAsked: true, identities: ["jane"] })),
    ).toEqual(refused);
  });

  it("refuses a step page over http under its own rule, apart from another site's origin", () => {
    expect(
      checkSignInVersion(input(withStep(1, { page: "http://login.example.com/password" }))),
    ).toEqual([{ rule: "insecure_origin", part: "recipe.steps[1].page" }]);
  });

  it("refuses a step page on another site's origin", () => {
    expect(
      checkSignInVersion(input(withStep(1, { page: "https://id.provider.example/sign-in" }))),
    ).toEqual([{ rule: "foreign_origin", part: "recipe.steps[1].page" }]);
  });

  it("passes a workspace step under the site's own workspace relation", () => {
    expect(checkSignInVersion(input(() => workspaceVersion))).toEqual([]);
  });

  it("refuses a workspace step without a workspace relation for the site", () => {
    const { workspace: _workspace, ...unrelated } = workspaceVersion.recipe as Extract<
      SignInVersion["recipe"],
      { version: 4 }
    >;
    // A recipe with no relation at all is one no host reads.
    expect(checkSignInVersion(input(() => ({ ...workspaceVersion, recipe: unrelated })))).toEqual([
      { rule: "invalid_recipe", part: "recipe" },
    ]);
    expect(
      checkSignInVersion(
        input(() => ({
          ...workspaceVersion,
          recipe: { ...unrelated, workspace: { parent: "example.org" } },
        })),
      ),
    ).toEqual([
      { rule: "workspace_parent", part: "recipe.workspace" },
      { rule: "foreign_origin", part: "recipe.steps[1].page" },
    ]);
  });

  it("checks a key-submit version's workspace relation as version 4's", () => {
    const keySubmit = (parent: string): SignInVersion => ({
      ...workspaceVersion,
      recipe: {
        version: 5,
        workspace: { parent },
        steps: [
          workspaceVersion.recipe.steps[0]!,
          {
            origin: "workspace",
            page: "/code",
            fields: [{ selector: "#code", slot: "code" }],
            submitKey: "Enter",
          },
        ],
        signedIn: version.recipe.signedIn,
      },
    });
    expect(checkSignInVersion(input(() => keySubmit("example.com")))).toEqual([]);
    expect(checkSignInVersion(input(() => keySubmit("example.org")))).toEqual([
      { rule: "workspace_parent", part: "recipe.workspace" },
      { rule: "foreign_origin", part: "recipe.steps[1].page" },
    ]);
  });

  it("refuses a recipe its schema refuses before any other check", () => {
    // Joined to a workspace origin, this page would land on another site's host.
    const hostInPath = withStep(1, { page: ".evil.test/x" })(workspaceVersion);
    const noSteps: SignInVersion = { ...version, recipe: { ...version.recipe, steps: [] } };
    for (const refused of [hostInPath, noSteps])
      expect(checkSignInVersion(input(() => refused))).toEqual([
        { rule: "invalid_recipe", part: "recipe" },
      ]);
  });

  it("refuses an account page the marker opens that signs out", () => {
    expect(
      checkSignInVersion(input(withMarker({ selector: "#account-menu", openPath: "/logout" }))),
    ).toEqual([{ rule: "sign_out", part: "recipe.signedIn.openPath" }]);
  });

  it("refuses an identity value in a host label below the site's domain", () => {
    const named: SignInVersion = {
      entryUrl: "https://jane.example.com/login",
      recipe: {
        version: 2,
        steps: [
          { ...version.recipe.steps[0]!, page: "https://jane.example.com/login" },
          {
            ...version.recipe.steps[1]!,
            popup: { opener: "primary", origin: "https://jane-sso.example.com" },
          },
        ],
        signedIn: version.recipe.signedIn,
      },
    };
    expect(checkSignInVersion(input(() => named, { identities: ["jane"] }))).toEqual([
      { rule: "page_names_contact", part: "entryUrl" },
      { rule: "page_names_contact", part: "recipe.steps[0].page" },
      { rule: "page_names_contact", part: "recipe.steps[1].popup.origin" },
    ]);
    // The site's own domain names no account, even when it shares a value's letters.
    expect(checkSignInVersion(input(() => named, { identities: ["example"] }))).toEqual([]);
  });

  it("refuses a popup on another site's origin", () => {
    const popup: SignInVersion = {
      ...version,
      recipe: {
        version: 2,
        steps: [
          {
            ...version.recipe.steps[0]!,
            popup: { opener: "primary", origin: "https://accounts.provider.example" },
          },
        ],
        signedIn: version.recipe.signedIn,
      },
    };
    expect(checkSignInVersion(input(() => popup))).toEqual([
      { rule: "foreign_origin", part: "recipe.steps[0].popup.origin" },
    ]);
  });
});
