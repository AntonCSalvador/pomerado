import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
  AutofillField,
  AutofillSlot,
  AutofillStep,
  AutofillStepRequest,
} from "../destinations/autofill-step.js";
import { wholeDateLayouts } from "../destinations/login-field-formats.js";
import {
  Unanswered,
  type PrivateQuestion,
  type SignInValue,
  type SignInValueHooks,
} from "../destinations/sign-in-recipe.js";
import type { WebsiteCredentials } from "./authentication.js";
import type { InputAsker, Question } from "./input-request.js";
import {
  chosenKind,
  heldField,
  kindNames,
  parsedAnswer,
  type AnsweredLoginField,
  type AnsweredLoginFields,
  type Asked,
  type Kept,
  type LoginIdentifierKind,
} from "./login-values.js";

export type { AnsweredLoginFields } from "./login-values.js";

/** A field whose rejected value the site may get a correction for. */
export type CorrectionField = AnsweredLoginField | "recovery_code";

/** The question for a value the login does not hold. */
const question = (asked: Asked, site: string, notice?: string): Question => {
  if (asked === "code")
    return {
      id: "code",
      type: "secret",
      secretKind: "one_time_code",
      prompt: `${notice === undefined ? "" : `${notice} `}Enter the sign-in code ${site} sent you.`,
    };
  if (asked === "recovery_code")
    return {
      id: "recovery_code",
      type: "secret",
      secretKind: "private_text",
      prompt: `Enter one of your ${site} recovery codes.`,
    };
  if (asked === "date_of_birth")
    return {
      id: "date_of_birth",
      type: "secret",
      secretKind: "private_text",
      prompt: `What's the date of birth on your ${site} account? Enter it as YYYY-MM-DD.`,
    };
  if (asked === "zip")
    return {
      id: "zip",
      type: "secret",
      secretKind: "private_text",
      prompt: `What's the ZIP or postal code on your ${site} account?`,
    };
  return {
    id: asked.join("_or_"),
    type: "text",
    maxLength: 320,
    prompt: `What's the ${asked.map((kind) => kindNames[kind]).join(" or ")} for your ${site} account?`,
  };
};

/**
 * Asks the owner, in place, for a value the login does not hold, as the same `system` source as
 * every login ask, and masks the answer both as typed and as kept before anything is filled. An
 * answer the field cannot take is asked again, twice at most. `keep` hears each kept answer.
 */
const makeFieldAsk =
  <E>(input: {
    readonly ask: InputAsker;
    readonly register: (slot: AutofillSlot, value: string) => Effect.Effect<void, E>;
    readonly site: string;
    readonly keep?: (kept: { readonly slot: Kept; readonly value: string }) => void;
  }) =>
  (
    asked: Asked,
    notice?: string,
  ): Effect.Effect<Unanswered | { readonly slot: Kept; readonly value: string }, E> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const questions = [question(asked, input.site, notice)];
        const response = yield* Effect.either(
          input.ask({ id: randomUUID(), source: "system", questions }),
        );
        if (response._tag === "Left") return new Unanswered(response.left);
        const answer = response.right[questions[0]?.id ?? "code"];
        if (answer?.type !== "text" && answer?.type !== "secret")
          return new Unanswered("answer_shape");
        const kept = parsedAnswer(asked, answer.value);
        if (kept === undefined) continue;
        yield* input.register(kept.slot, answer.value);
        if (kept.value !== answer.value) yield* input.register(kept.slot, kept.value);
        input.keep?.(kept);
        return kept;
      }
      return new Unanswered("answer_kind");
    });

/** Host-written: why the owner is asked for a code again. */
const codeRejectedNotice = "The site did not accept the last code, so it needs a new one.";

/** The longest prompt a question may have, as the input request allows. */
const promptLimit = 2_000;

/**
 * What the owner is asked for a private answer: the question the page shows, cut to leave room
 * for the site's origin; else that the recorded question could not be read; else the field's label.
 */
const answerPrompt = (siteOrigin: string, field: PrivateQuestion | undefined) => {
  const label = field?.label ?? null;
  if (field?.questionText !== undefined) {
    const suffix = ` (${siteOrigin})`;
    const room = promptLimit - suffix.length;
    const asked =
      field.questionText.length <= room
        ? field.questionText
        : `${field.questionText.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
    return `${asked}${suffix}`;
  }
  if (field?.questionUnread === true)
    return `Enter your security answer for ${siteOrigin}. The question it answers could not be read from the page.${label === null ? "" : ` The answer field reads "${label}".`}`;
  return label === null
    ? `Enter your private answer for ${siteOrigin}.`
    : `${label} (${siteOrigin})`;
};

/**
 * The local host's codes, recovery codes and private answers: it asks the owner each time one is
 * needed, and masks each answer for the session.
 */
export const askingValueHooks = (input: {
  readonly ask: InputAsker;
  readonly register: (value: string) => void;
  /** The site as a question names it: its host, without `www.`. */
  readonly site: string;
  readonly siteOrigin: string;
}): SignInValueHooks<never> => {
  const register = (_slot: AutofillSlot, value: string) => Effect.sync(() => input.register(value));
  const ask = makeFieldAsk({ ask: input.ask, register, site: input.site });
  return {
    ask: input.ask,
    register,
    code: ({ again }) =>
      ask("code", again === "rejected" ? codeRejectedNotice : undefined).pipe(
        Effect.map((kept): SignInValue | Unanswered =>
          kept instanceof Unanswered ? kept : { slot: "code", value: kept.value },
        ),
      ),
    recoveryCode: ask("recovery_code").pipe(
      Effect.map((kept): SignInValue | Unanswered =>
        kept instanceof Unanswered ? kept : { slot: "recovery_code", value: kept.value },
      ),
    ),
    privateAnswer: (field) =>
      Effect.gen(function* () {
        const response = yield* Effect.either(
          input.ask({
            id: randomUUID(),
            source: "system",
            questions: [
              {
                id: "private_answer",
                type: "secret",
                secretKind: "private_text",
                prompt: answerPrompt(input.siteOrigin, field),
                maxLength: 16_384,
              },
            ],
          }),
        );
        if (response._tag === "Left") return new Unanswered(response.left);
        const answer = response.right["private_answer"];
        if (answer?.type !== "secret") return new Unanswered("answer_shape");
        input.register(answer.value);
        return { slot: "private_answer", value: answer.value } satisfies SignInValue;
      }),
  };
};

/**
 * Whether a login's username is a username of its own. A login kept without one keeps its primary
 * identifier, an email address, phone number or account number, as its username and under its own
 * key, so a username equal to one of its identifiers is that identifier.
 */
const separateUsername = (login: WebsiteCredentials) =>
  login.username !== "" &&
  login.username !== login.email &&
  login.username !== login.phone &&
  login.username !== login.accountNumber;

/** What one step's values need besides the login. */
export interface StepValueContext {
  readonly credentials: WebsiteCredentials;
  /** The question each field's screen showed, by field, as the host inspected it. */
  readonly questions?: readonly (PrivateQuestion | undefined)[];
  /** Values the site rejected in this build, by field; never filled again. */
  readonly rejected?: Partial<Record<CorrectionField, ReadonlySet<string>>>;
  /** The corrections asked so far, by field: two at most. */
  readonly corrections?: Partial<Record<CorrectionField, number>>;
  /** A code after the site rejected the last: the codes it rejected and the asks so far. */
  readonly code?: {
    readonly again?: "rejected";
    readonly rejected: ReadonlySet<string>;
    readonly requests: { current: number };
  };
}

/**
 * A sign-in's values in field order: the login's username into a `username` slot, its password,
 * an identifier it holds or the owner gave, a date of birth or ZIP, and a code, recovery code or
 * private answer from `hooks`. What the login does not hold is asked of the owner in place, and
 * each answer is masked before any screen can send it. The identifiers, date of birth and ZIP the
 * owner gives are kept for the build (`given`). A rejected value is never filled again: its
 * correction is asked twice at most.
 */
export const makeSignInValues = <E>(hooks: SignInValueHooks<E>, site: string) => {
  let given: AnsweredLoginFields = {};
  const ask = makeFieldAsk({
    ask: hooks.ask,
    register: hooks.register,
    site,
    keep: (kept) => {
      if (kept.slot !== "code" && kept.slot !== "recovery_code")
        given = { ...given, [kept.slot]: kept.value };
    },
  });
  const correctedValue = (
    slot: CorrectionField,
    context: StepValueContext,
    request: () => Effect.Effect<Unanswered | SignInValue, E>,
  ) =>
    Effect.gen(function* () {
      const counts = context.corrections;
      if (counts === undefined) return new Unanswered("correction_history_unavailable");
      while ((counts[slot] ?? 0) < 2) {
        counts[slot] = (counts[slot] ?? 0) + 1;
        const answered = yield* request();
        if (
          answered instanceof Unanswered ||
          context.rejected?.[slot]?.has(answered.value) !== true
        )
          return answered;
      }
      return new Unanswered("field_corrections_exhausted", slot);
    });
  /** A field's value: the login's or the owner's, else asked; a rejected one is corrected. */
  const fieldValue = (slot: AnsweredLoginField, context: StepValueContext) =>
    Effect.gen(function* () {
      const requested: Asked = slot === "date_of_birth" || slot === "zip" ? slot : [slot];
      const rejected = context.rejected?.[slot] ?? new Set<string>();
      if (rejected.size === 0) {
        const held = heldField(slot, context.credentials, given);
        return held === undefined ? yield* ask(requested) : { slot, value: held };
      }
      const fresh = given[slot];
      if (fresh !== undefined && !rejected.has(fresh)) return { slot, value: fresh };
      return yield* correctedValue(slot, context, () => ask(requested));
    });
  /** A date of birth or ZIP, masked; a date in every whole-date layout a page may show it in. */
  const checkedValue = (slot: "date_of_birth" | "zip", context: StepValueContext) =>
    Effect.gen(function* () {
      const answered = yield* fieldValue(slot, context);
      if (answered instanceof Unanswered) return answered;
      const forms = slot === "zip" ? [answered.value] : wholeDateLayouts(answered.value);
      for (const form of forms) yield* hooks.register(slot, form);
      return { slot, value: answered.value };
    });
  /** An identifier besides the username: the login's or the owner's, else one the field takes. */
  const identifierValue = (
    field: AutofillField,
    slot: LoginIdentifierKind,
    context: StepValueContext,
  ) =>
    Effect.gen(function* () {
      if ((context.rejected?.[slot]?.size ?? 0) > 0) return yield* fieldValue(slot, context);
      const stored = heldField(slot, context.credentials, given);
      if (stored !== undefined) return { slot, value: stored };
      return yield* ask(
        (field.accepts ?? [slot]).filter(
          (kind): kind is LoginIdentifierKind => kind !== "username",
        ),
      );
    });
  /**
   * A code, asked again after a rejection twice at most, never one the site rejected. For a
   * screen of `boxes` code fields, one-character boxes, it is the code without the spaces and
   * hyphens it is often written with (`123 456`), masked as such, so what the host types and
   * rules out after a refusal is the code the site gets. One that then leaves other than one
   * character per box cannot be the screen's code, so none is filled (`code_shape`).
   */
  const codeValue = (context: StepValueContext, boxes = 1) =>
    Effect.gen(function* () {
      const code = context.code;
      while (true) {
        if (code?.again === "rejected") {
          if (code.requests.current >= 2) return new Unanswered("code_corrections_exhausted");
          code.requests.current += 1;
        }
        const answered = yield* hooks.code(code?.again === "rejected" ? { again: "rejected" } : {});
        if (answered instanceof Unanswered) return answered;
        const bare = answered.value.replaceAll(/[\s-]/gu, "");
        if (boxes > 1 && Array.from(bare).length !== boxes) return new Unanswered("code_shape");
        const value = boxes > 1 ? bare : answered.value;
        if (value !== answered.value) yield* hooks.register("code", value);
        if (code?.rejected.has(value) !== true) return { ...answered, value };
        if (code.again !== "rejected") return new Unanswered("code_already_rejected");
      }
    });
  const recoveryValue = (context: StepValueContext) =>
    (context.rejected?.recovery_code?.size ?? 0) === 0
      ? hooks.recoveryCode
      : correctedValue("recovery_code", context, () => hooks.recoveryCode);
  const valueFor = (
    field: AutofillField,
    index: number,
    context: StepValueContext,
  ): Effect.Effect<
    Unanswered | { readonly slot: AutofillField["slot"]; readonly value: string },
    E
  > => {
    const { slot } = field;
    if (slot === "password")
      return Effect.succeed(
        context.credentials.password === undefined
          ? new Unanswered("password_unavailable")
          : { slot, value: context.credentials.password },
      );
    if (slot === "code") return codeValue(context);
    if (slot === "recovery_code") return recoveryValue(context);
    if (slot === "username") return Effect.succeed({ slot, value: context.credentials.username });
    if (slot === "date_of_birth" || slot === "zip") return checkedValue(slot, context);
    if (slot === "private_answer") return hooks.privateAnswer(context.questions?.[index]);
    return identifierValue(field, slot, context);
  };
  return {
    /**
     * The step's values in field order, and the step with the kind each identifier field was sent,
     * which an answer to a field that takes several kinds decides; else why one is missing. A
     * step's code fields share one code, asked once, one character in each of its boxes; a code
     * that does not fit them fills none (`code_shape`).
     */
    valuesFor: (step: AutofillStep, context: StepValueContext) =>
      Effect.gen(function* () {
        const values: string[] = [];
        const fields: AutofillField[] = [];
        // A screen carries one code, asked once: several code fields are one-character boxes,
        // which take one of its characters each, in order.
        const boxes = step.fields.filter((field) => field.slot === "code").length;
        let characters: readonly string[] | undefined;
        let box = 0;
        for (const [index, field] of step.fields.entries()) {
          if (field.slot === "code" && boxes > 1) {
            if (characters === undefined) {
              const found = yield* codeValue(context, boxes);
              if (found instanceof Unanswered) return found;
              characters = Array.from(found.value);
            }
            values.push(characters[box] ?? "");
            box += 1;
            fields.push(field);
            continue;
          }
          const found = yield* valueFor(field, index, context);
          if (found instanceof Unanswered) return found;
          values.push(found.value);
          fields.push({ ...field, slot: found.slot });
        }
        return { values, step: { ...step, fields } };
      }),
    /**
     * The step as the host sends it: each identifier field takes the kind `chosenKind` picks.
     * Before the login is given, only the owner's answers count.
     */
    resolve: (
      step: AutofillStepRequest,
      credentials: WebsiteCredentials | undefined,
    ): AutofillStep => ({
      ...step,
      fields: step.fields.map((field) =>
        "slot" in field
          ? field
          : {
              ...field,
              slot: chosenKind(field.accepts, (kind) =>
                credentials === undefined
                  ? kind !== "username" && given[kind] !== undefined
                  : kind === "username"
                    ? separateUsername(credentials)
                    : heldField(kind, credentials, given) !== undefined,
              ),
            },
      ),
    }),
    /** The identifiers, date of birth and ZIP the owner gave in this build. */
    given: () => given,
  };
};
