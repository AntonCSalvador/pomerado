import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { fillAutofillStep } from "../destinations/autofill-fill.js";
import { autofillMarkerVisible } from "../destinations/autofill-marker.js";
import {
  checkAutofillSignedIn,
  inspectAutofillStep,
  openAutofillLogin,
  type AutofillInspection,
  type AutofillPage,
  type AutofillStep,
} from "../destinations/autofill-step.js";
import { rememberTyping } from "../destinations/autofill-typed-page.js";
import type { CredentialKeyboard } from "../destinations/credential-keyboard.js";
import type {
  SignInBrowser,
  SignInLogin,
  SignInRequest,
} from "../destinations/sign-in-recipe.js";
import { MintFailure } from "../mint/contracts.js";
import type { CredentialRejectedField, WebsiteCredentials } from "../runtime/authentication.js";
import { credentialMessage, credentialPrompt } from "../runtime/credential-prompts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { InputRequestFailure, type InputAsker } from "../runtime/input-request.js";
import type { SignInReplayBrowser } from "../runtime/sign-in-replay.js";

/**
 * Whether the host typed a sign-in value into the session browser's page. It lasts for the
 * session, since page code may have kept what was typed for any later screen.
 */
export interface SessionTyping {
  typed: boolean;
}

/**
 * The local host's sign-in browser on the session's page, for a build's recorder and a run's
 * replay: core's inspection, fill and signed-in check, with the page's requests from the
 * executor, the entry page's load and the recorded rejection markers. Once the host typed into
 * the page, each later screen is judged as typed into (`rememberTyping`); `typing` carries that
 * across every build and run on the same browser. `trusted` adds the origins the caller trusted for
 * sign-in during a build to `authenticationOrigins`, read at each call, so one counts from the
 * next call on.
 */
export const makeSignInBrowser = (options: {
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  readonly siteOrigin: string;
  readonly authenticationOrigins: readonly string[];
  readonly trusted?: () => readonly string[];
  readonly onRequest: (listener: (request: SignInRequest) => void) => () => void;
  readonly typing: SessionTyping;
}): SignInBrowser<never> & Pick<SignInReplayBrowser<Error>, "open" | "markerVisible"> => {
  const { page, siteOrigin, typing } = options;
  const signInOrigins = () =>
    options.trusted === undefined
      ? options.authenticationOrigins
      : [...new Set([...options.authenticationOrigins, ...options.trusted()])];
  const calls = rememberTyping({
    inspect: (request) =>
      inspectAutofillStep({
        ...request,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
      }),
    fill: (input: {
      readonly step: AutofillStep;
      readonly inspection: AutofillInspection;
      readonly values: readonly string[];
    }) =>
      fillAutofillStep({ ...input, page, keyboard: options.keyboard }).pipe(
        // The session's record counts what `rememberTyping` counts: a fill that typed.
        Effect.tap((report) =>
          Effect.sync(() => {
            if (report.outcome !== "refused" && report.typed === true) typing.typed = true;
          }),
        ),
      ),
    typed: typing.typed,
  });
  return {
    inspect: calls.inspect,
    fill: calls.fill,
    confirm: (indicator, screens, challengeScreens) =>
      checkAutofillSignedIn({
        indicator,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
        screens,
        challengeScreens,
      }),
    onRequest: options.onRequest,
    get authenticationOrigins() {
      return signInOrigins();
    },
    open: (url) => openAutofillLogin({ page, url }),
    markerVisible: (selector, screenPage, popup) =>
      autofillMarkerVisible({
        selector,
        screenPage,
        popup,
        page,
        siteOrigin,
        authenticationOrigins: signInOrigins(),
      }),
  };
};

const loginFailure = (cause: unknown) =>
  new MintFailure({
    code: "Unavailable",
    ...(cause instanceof InputRequestFailure && cause.code === "NoResponse"
      ? { noResponse: { possibleCommit: false } }
      : {}),
    failureDetail: failureDetail("mint_host_dependency_failed", {
      operation: "standalone.login",
      phase: "sign_in_input",
      error: cause,
    }),
  });

/** A corrected login that repeated, twice, a value the site rejected, so nothing was sent. */
export const repeatedLoginFailure = (field: CredentialRejectedField) =>
  loginFailure(new Error(`The corrected login repeats the ${field} the site rejected`));

/**
 * The local host's login for one build: one `credential` question, asked when a screen first
 * needs it, and one more after the site rejected it. Nothing is saved, and the answer is masked
 * for the session (`register`) before any screen can send it.
 */
export const localSignInLogin = (options: {
  readonly ask: InputAsker;
  readonly register: (value: string) => void;
  readonly siteOrigin: string;
}): SignInLogin<MintFailure> => {
  let held: WebsiteCredentials | undefined;
  // The first ask may be declined: the owner has no account, or wants the public part only.
  const askLogin = (reason: "missing_credentials" | "invalid_credentials", username?: string) =>
    Effect.gen(function* () {
      const answers = yield* options
        .ask({
          id: randomUUID(),
          source: "system",
          notice: credentialMessage(reason),
          questions: [
            {
              id: "login",
              type: "credential",
              prompt: credentialPrompt(reason),
              fields: "username_password",
              reason,
              allowSave: false,
              siteOrigin: options.siteOrigin,
              ...(reason === "missing_credentials" ? { allowDecline: true } : {}),
              ...(username === undefined || username === "" ? {} : { username }),
            },
          ],
        })
        .pipe(Effect.mapError(loginFailure));
      const answer = answers["login"];
      if (answer?.type === "credential" && answer.value.declined !== undefined)
        return yield* new MintFailure({ code: "Unavailable", loginDeclined: answer.value.declined });
      if (
        answer?.type !== "credential" ||
        answer.value.username === undefined ||
        answer.value.password === undefined
      )
        return yield* loginFailure(new Error("The login answer holds no username and password"));
      options.register(answer.value.username);
      options.register(answer.value.password);
      held = { username: answer.value.username, password: answer.value.password };
      return held;
    });
  return {
    held: () => held,
    values: Effect.suspend(() =>
      held === undefined ? askLogin("missing_credentials") : Effect.succeed(held),
    ),
    correct: (_field, rejected) => askLogin("invalid_credentials", rejected.username),
  };
};
