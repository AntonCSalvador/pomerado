import { Effect, Either } from "effect";
import { expect, it } from "vitest";
import type { AutofillInspection, AutofillSignedInCheck } from "../../src/destinations/autofill-step.js";
import type { SignInRecipe, SignInRequest } from "../../src/destinations/sign-in-recipe.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import type { InputAnswers, Question } from "../../src/runtime/input-request.js";
import { sameSite } from "../../src/runtime/same-site.js";
import {
  signInForRun,
  SignInRunFailed,
  type SignInReplayBrowser,
  type WorkspaceOriginEvent,
} from "../../src/runtime/sign-in-replay.js";
import { askingValueHooks } from "../../src/runtime/sign-in-values.js";
import { approvedSignInOrigins } from "../../src/runtime/workspace-origin.js";
import { localSignInLogin } from "../../src/standalone/authentication.js";

// A run's sign-in on a synthetic workspace SaaS: the identifier screen is on the shared host
// app.example.com, and the site then sends each account to its own workspace host for the
// password (acme. or globex.), or to a cross-site identity provider. Every host is synthetic.

const site = "https://app.example.com";
const acme = "https://acme.example.com";
const globex = "https://globex.example.com";
const evil = "https://evil.example.com";
const provider = "https://id.example.net";
const password = "synthetic-password";
const accounts: Record<string, string> = { "ada-owner": acme, "grace-owner": globex };

interface SiteOptions {
  /** Where the identifier screen sends the account for its password. */
  readonly passwordOn?: (username: string) => string;
  /** Leftover state: opening the entry lands on this page of another tenant. */
  readonly leftover?: string;
  /** Whether clearing the site's data removes the leftover state. */
  readonly clearable?: boolean;
  /** The session is already signed in on this workspace. */
  readonly signedInOn?: string;
  /** The sign-in origins the host trusts besides the site. */
  readonly authenticationOrigins?: readonly string[];
}

const screens: Record<string, readonly string[]> = {
  "/login": ["#username", "#next"],
  "/login/password": ["#password", "#sign-in"],
  "/signin": ["#password", "#sign-in"],
  "/home": [],
};

const fakeSite = (options: SiteOptions = {}) => {
  const state = {
    at: new URL(`${site}/login`),
    signedInOn: options.signedInOn,
    leftover: options.leftover,
  };
  const fills: string[] = [];
  const checkedOn: (string | undefined)[] = [];
  const listeners = new Set<(request: SignInRequest) => void>();
  const authenticationOrigins = options.authenticationOrigins ?? [];
  const trusted = (url: URL) => sameSite(site, url) || authenticationOrigins.includes(url.origin);
  const shows = (selector: string) => (screens[state.at.pathname] ?? []).includes(selector);
  const page = () => `${state.at.origin}${state.at.pathname}`;
  const browser: SignInReplayBrowser<Error> = {
    inspect: (step) =>
      Effect.sync(() => {
        const selectors = [...step.fields.map((field) => field.selector), ...(step.submit === undefined ? [] : [step.submit])];
        if (selectors.length === 0 || !selectors.every(shows)) return { outcome: "refused" as const, reason: "not_found" as const };
        if (!trusted(state.at)) return { outcome: "refused" as const, reason: "credential_target_refused" as const };
        const target = {
          ownerUrl: page(),
          documentOrigin: state.at.origin,
          actions: [page()],
          methods: ["post"],
          editable: true,
          control: "text" as const,
          empty: true,
        };
        const inspection: AutofillInspection = {
          url: page(),
          page: page(),
          targets: { fields: step.fields.map(() => target), submit: step.submit === undefined ? null : target },
          siteOrigin: site,
          authenticationOrigins: [...authenticationOrigins],
          screen: {
            origin: state.at.origin,
            fields: step.fields.map((field) => ({
              tag: "input",
              role: null,
              formMethod: "post",
              type: "text",
              name: null,
              id: null,
              autocomplete: null,
              inputmode: null,
              label: "Field",
              placeholder: null,
              ariaLabel: null,
              text: null,
              slot: field.slot,
            })),
            submit: null,
            buttons: [],
          },
        };
        return inspection;
      }),
    fill: ({ step, values }) =>
      Effect.sync(() => {
        const filledOn = page();
        fills.push(filledOn);
        const request: SignInRequest = {
          url: filledOn,
          method: "POST",
          body: new URLSearchParams(values.map((value, index) => [`field${index}`, value])).toString(),
          channel: "navigation",
          frame: "main",
          resourceType: "document",
        };
        for (const listener of [...listeners]) listener(request);
        if (state.at.pathname === "/login") {
          const username = values[0] ?? "";
          const next = options.passwordOn?.(username) ?? `${accounts[username] ?? site}/login/password`;
          state.at = new URL(next);
        } else if (screens[state.at.pathname]?.includes("#password") === true && values[0] === password) {
          // A provider sends the session back to the site; a workspace keeps it.
          const home = sameSite(site, state.at) ? state.at.origin : site;
          state.signedInOn = home;
          state.at = new URL(`${home}/home`);
        }
        return {
          outcome: "filled" as const,
          fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
          submit: "clicked" as const,
          url: state.at.href,
        };
      }),
    confirm: (indicator, _screens, _challenges, openOrigin) =>
      Effect.sync((): AutofillSignedInCheck => {
        if (indicator.openPath !== undefined) {
          checkedOn.push(openOrigin);
          state.at = new URL(indicator.openPath, openOrigin ?? site);
        }
        const url = state.at.href;
        return state.at.pathname === "/home" && state.at.origin === state.signedInOn
          ? { signedIn: true, url }
          : { signedIn: false, failed: "indicator_not_visible", url };
      }),
    onRequest: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    authenticationOrigins,
    open: (url) =>
      Effect.sync(() => {
        state.at =
          state.leftover !== undefined
            ? new URL(state.leftover)
            : state.signedInOn !== undefined
              ? new URL(`${state.signedInOn}/home`)
              : new URL(url);
      }),
    markerVisible: () => Effect.succeed(false),
    clearSiteData: () =>
      Effect.sync(() => {
        if (options.clearable === true) state.leftover = undefined;
      }),
  };
  return { browser, state, fills, checkedOn };
};

const identifierStep = {
  page: `${site}/login`,
  fields: [{ selector: "#username", accepts: ["username" as const] }],
  submit: "#next",
};
const workspaceRecipe: SignInRecipe = {
  version: 4,
  workspace: { parent: "example.com" },
  steps: [
    identifierStep,
    {
      origin: "workspace",
      page: "/login/password",
      fields: [{ selector: "#password", slot: "password" }],
      submit: "#sign-in",
    },
  ],
  signedIn: { selector: "#account", openPath: "/home" },
};
const providerRecipe: SignInRecipe = {
  version: 4,
  signInOrigins: [provider],
  steps: [
    identifierStep,
    { page: `${provider}/signin`, fields: [{ selector: "#password", slot: "password" }], submit: "#sign-in" },
  ],
  signedIn: { selector: "#account" },
};

const owner = (username: string) =>
  makeInputAsker((request) =>
    Effect.succeed(
      Object.fromEntries(
        request.questions.map((question: Question) => [
          question.id,
          question.type === "credential" ? { username, password, saveLogin: false } : "",
        ]),
      ) as InputAnswers,
    ),
  );

const signIn = (
  recipe: SignInRecipe,
  fake: ReturnType<typeof fakeSite>,
  username = "ada-owner",
  workspaceOrigin?: string,
  events: WorkspaceOriginEvent[] = [],
) => {
  const secrets = makeRunSecrets();
  const ask = owner(username);
  return Effect.runPromise(
    Effect.either(
      signInForRun({
        recipe,
        entryUrl: `${site}/login`,
        browser: fake.browser,
        login: localSignInLogin({ ask, register: secrets.register, siteOrigin: site }),
        values: askingValueHooks({ ask, register: secrets.register, site: "app.example.com", siteOrigin: site }),
        carries: secrets.carries,
        site: "app.example.com",
        siteOrigin: site,
        ...(workspaceOrigin === undefined ? {} : { workspaceOrigin }),
        onWorkspaceEvent: (event) => events.push(event),
        timing: { stepWaitMs: 60, pollMs: 2 },
      }),
    ),
  );
};

it("types the password on the workspace host the site sent this login to after its identifier", async () => {
  const fake = fakeSite();
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
});

it("replays the same recipe on another account's own workspace", async () => {
  const fake = fakeSite();
  expect(await signIn(workspaceRecipe, fake, "grace-owner")).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: globex }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${globex}/login/password`]);
});

it("admits the shared sign-in screen on the login's pinned workspace", async () => {
  // The site remembers the workspace and shows the identifier screen there.
  const fake = fakeSite({ leftover: `${acme}/login`, passwordOn: () => `${acme}/login/password` });
  const pinned = await signIn(workspaceRecipe, fake, "ada-owner", acme);
  expect(pinned).toEqual(Either.right({ alreadySignedIn: false, workspaceOrigin: acme }));
});

it("refuses another tenant's sign-in screen before this login sent anything, once the site's data is cleared", async () => {
  const fake = fakeSite({ leftover: `${evil}/login` });
  const events: WorkspaceOriginEvent[] = [];
  expect(await signIn(workspaceRecipe, fake, "ada-owner", undefined, events)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills).toEqual([]);
  // The refused origin goes only to the host's private event.
  expect(events).toEqual([
    { kind: "unrecognized_sibling", origin: evil },
    { kind: "unrecognized_sibling", origin: evil },
  ]);
});

it("learns the workspace again when the site sends a pinned login to another one", async () => {
  const fake = fakeSite();
  const events: WorkspaceOriginEvent[] = [];
  expect(await signIn(workspaceRecipe, fake, "grace-owner", acme, events)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: globex }),
  );
  expect(events).toEqual([{ kind: "relearned", from: acme, to: globex }]);
});

it("reopens the entry once after clearing the site's data, and then signs in on the login's own workspace", async () => {
  const fake = fakeSite({ leftover: `${evil}/login`, clearable: true });
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.right({ alreadySignedIn: false, workspaceOrigin: acme }),
  );
  expect(fake.fills).toEqual([`${site}/login`, `${acme}/login/password`]);
});

it("refuses a workspace password screen the site showed before the identifier went out", async () => {
  const fake = fakeSite({ leftover: `${evil}/login/password` });
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "workspace_unverified" })),
  );
  expect(fake.fills).toEqual([]);
});

it("opens the account page on the workspace a signed-in session is on, and pins it", async () => {
  const fake = fakeSite({ signedInOn: acme });
  expect(await signIn(workspaceRecipe, fake)).toEqual(
    Either.right({ alreadySignedIn: true, workspaceOrigin: acme }),
  );
  expect(fake.checkedOn).toEqual([acme]);
  expect(fake.fills).toEqual([]);
});

it("types on an approved identity provider, and refuses the same screen on any other origin", async () => {
  const origins = approvedSignInOrigins(providerRecipe, site);
  expect(origins).toEqual([provider]);
  const approved = fakeSite({ authenticationOrigins: origins, passwordOn: () => `${provider}/signin` });
  expect(await signIn(providerRecipe, approved)).toEqual(Either.right({ alreadySignedIn: false }));
  expect(approved.fills).toEqual([`${site}/login`, `${provider}/signin`]);

  const other = fakeSite({ authenticationOrigins: origins, passwordOn: () => "https://id.example.org/signin" });
  expect(await signIn(providerRecipe, other)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "credential_target_refused" })),
  );
  expect(other.fills).toEqual([`${site}/login`]);
});

it("refuses a workspace step whose relation names another registrable domain", async () => {
  const fake = fakeSite();
  const recipe: SignInRecipe = { ...workspaceRecipe, workspace: { parent: "example.org" } };
  expect(await signIn(recipe, fake)).toEqual(
    Either.left(new SignInRunFailed({ code: "RecipeFailed", reason: "screen_origin_changed" })),
  );
  expect(fake.fills).toEqual([`${site}/login`]);
});
