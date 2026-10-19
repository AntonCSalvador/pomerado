import { Effect, Either, Option, Schema } from "effect";
import {
  ChoiceAnswer,
  ConfirmAnswer,
  MultiChoiceAnswer,
  optionsRepeatedBy,
  QuestionId,
  validateAnswer,
  type InputRequest,
  type Question,
  type ValidAnswer,
  type ValidAnswers,
} from "../runtime/input-request.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";

/** The question types whose answers a later step may reuse: never a code, a secret or a login. */
const ReusableType = Schema.Literal("choice", "multi_choice", "text", "confirm");
const reusable = Schema.is(ReusableType);

/**
 * What a later ask must match to reuse an answer: the same id, type, screened prompt, and screened
 * options or a confirm's screened follow-up.
 */
const KeptQuestion = Schema.Struct({
  id: Schema.String,
  type: ReusableType,
  prompt: Schema.String,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  followUp: Schema.optional(
    Schema.Struct({ prompt: Schema.String, defaultText: Schema.optional(Schema.String) }),
  ),
});
type KeptQuestion = typeof KeptQuestion.Type;

/**
 * One answer the owner gave in this build, to the agent's own question or a script's, which a
 * later script ask may reuse: the screened question, the answer as the asker returned it, and the
 * decision it settles. An agent question's decision is its id; a script question's is the
 * `decision` its declaration names, if any.
 */
export const KeptScriptAnswer = Schema.Struct({
  question: KeptQuestion,
  answer: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
  decision: Schema.optional(QuestionId),
});
export type KeptScriptAnswer = typeof KeptScriptAnswer.Type;

/**
 * Each question's match key, its texts screened as the owner saw them, or undefined for a question
 * no later step may reuse: a code, a secret or a login.
 */
export const scriptQuestionKeys = <E>(
  asked: InputRequest,
  screen: (text: string) => Effect.Effect<string, E>,
) =>
  Effect.forEach(asked.questions, (question) =>
    Effect.gen(function* () {
      const { type } = question;
      if (!reusable(type)) return undefined;
      const key = { id: question.id, type, prompt: yield* screen(question.prompt) };
      if (question.type === "choice" || question.type === "multi_choice") {
        const options = yield* Effect.forEach(question.options, (option) =>
          screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
        );
        return { ...key, options } satisfies KeptQuestion;
      }
      if (question.type !== "confirm" || question.followUp === undefined)
        return key satisfies KeptQuestion;
      const { prompt, defaultText } = question.followUp;
      const followUp = {
        prompt: yield* screen(prompt),
        ...(defaultText === undefined ? {} : { defaultText: yield* screen(defaultText) }),
      };
      return { ...key, followUp } satisfies KeptQuestion;
    }),
  );

const sameQuestion = (left: KeptQuestion, right: KeptQuestion) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Each asked question's decision key, by its declaration: the `decision` it names, if any. */
export const declaredDecisions = (
  asked: InputRequest,
  declared: ScriptQuestionDeclarations | undefined,
): readonly (string | undefined)[] =>
  asked.questions.map((question) => {
    const declaration =
      declared !== undefined && Object.hasOwn(declared, question.id)
        ? declared[question.id]
        : undefined;
    const decision =
      declaration !== undefined && "decision" in declaration ? declaration.decision : undefined;
    return typeof decision === "string" ? decision : undefined;
  });

/** The answer as one asked question takes it, or undefined when it no longer fits. */
const validFor = (asked: InputRequest, question: Question, value: unknown) => {
  const valid = validateAnswer({ ...asked, questions: [question] }, { [question.id]: value });
  return Either.isLeft(valid) ? undefined : valid.right[question.id];
};

/** The one offered option a label names, by `optionsRepeatedBy`'s folding; else undefined. */
const optionNamed = (key: KeptQuestion, label: string | undefined) => {
  if (label === undefined || key.options === undefined) return undefined;
  const [named, ...more] = optionsRepeatedBy(key.options, label);
  return more.length === 0 ? named?.id : undefined;
};

/**
 * An earlier answer to the same decision as the question asked now takes it: the same type, each
 * option the owner picked found among the page's options by its label (ids differ: a script's
 * options get the host's ids at ask time), the owner's own text kept only where the question takes
 * it or it names exactly one option, a note left out, and a confirm's follow-up only when the
 * earlier question had the same one. Undefined when any part does not carry over.
 */
const decidedValue = (entry: KeptScriptAnswer, key: KeptQuestion): unknown => {
  const earlier = entry.question;
  if (earlier.type !== key.type) return undefined;
  const label = (id: string) => earlier.options?.find((option) => option.id === id)?.label;
  const value: unknown = entry.answer.value;
  switch (key.type) {
    case "text":
      return value;
    case "confirm": {
      const answer = Schema.decodeUnknownOption(ConfirmAnswer)(value);
      if (Option.isNone(answer)) return undefined;
      if (key.followUp === undefined) return { confirmed: answer.value.confirmed };
      return JSON.stringify(earlier.followUp) === JSON.stringify(key.followUp)
        ? answer.value
        : undefined;
    }
    case "choice": {
      const answer = Schema.decodeUnknownOption(ChoiceAnswer)(value);
      if (Option.isNone(answer)) return undefined;
      const choice = answer.value;
      if (typeof choice === "string") return optionNamed(key, label(choice));
      if ("option" in choice) return optionNamed(key, label(choice.option));
      return optionNamed(key, choice.other) ?? { other: choice.other };
    }
    case "multi_choice": {
      const answer = Schema.decodeUnknownOption(MultiChoiceAnswer)(value);
      if (Option.isNone(answer)) return undefined;
      const { options, other } =
        "options" in answer.value ? answer.value : { options: answer.value, other: undefined };
      const picks = [...options.map(label), ...(other === undefined ? [] : [other])];
      const ids = picks.map((picked) => optionNamed(key, picked));
      return ids.every((id) => id !== undefined) && new Set(ids).size === ids.length
        ? ids
        : undefined;
    }
  }
};

/**
 * What the owner already answered of a script's ask, and what is left to ask. A question takes a
 * kept answer to the same question (same id, type, screened prompt, and screened options or
 * follow-up), else the latest kept answer to the decision its declaration names, from the agent's
 * own question or a script's; either only while still valid for the question as asked now. Any
 * step may reuse it, the one that got it included, as often as the question comes back and however
 * long ago the owner gave it. A code, secret or login question is always left to ask.
 */
export const settledScriptAnswers = (
  asked: InputRequest,
  keys: readonly (KeptQuestion | undefined)[],
  kept: readonly KeptScriptAnswer[],
  decisions: readonly (string | undefined)[] = [],
): { readonly reused: ValidAnswers; readonly remaining: InputRequest | undefined } => {
  const reused: Record<string, ValidAnswer> = {};
  const left: Question[] = [];
  asked.questions.forEach((question, index) => {
    const key = keys[index];
    const decision = decisions[index];
    const same = key && kept.find((entry) => sameQuestion(entry.question, key));
    const decided =
      key && decision !== undefined
        ? kept.findLast((entry) => entry.decision === decision)
        : undefined;
    const answer =
      (same && validFor(asked, question, same.answer.value)) ??
      (key && decided && validFor(asked, question, decidedValue(decided, key)));
    if (answer === undefined) left.push(question);
    else reused[question.id] = answer;
  });
  return { reused, remaining: left.length === 0 ? undefined : { ...asked, questions: left } };
};

/**
 * The kept answers without any to these screened prompts. Only the owner's latest answer to a
 * prompt stands, as in Guardian's trusted answers, so an answer the owner gave since to a question
 * with the same prompt, whoever asked it, means the next script ask asks again.
 */
export const forgetScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  prompts: readonly string[],
): readonly KeptScriptAnswer[] => kept.filter((entry) => !prompts.includes(entry.question.prompt));

/**
 * The kept answers once the owner answered afresh: each reusable answer, with the decision it
 * settles, replaces any kept for the same prompt or the same decision.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (KeptQuestion | undefined)[],
  answers: ValidAnswers,
  decisions: readonly (string | undefined)[] = [],
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key, index): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    const decision = decisions[index];
    return key === undefined || answer === undefined
      ? []
      : [{ question: key, answer, ...(decision === undefined ? {} : { decision }) }];
  });
  const decided = new Set(latest.flatMap((entry) => entry.decision ?? []));
  return [
    ...forgetScriptAnswers(
      kept,
      latest.map((entry) => entry.question.prompt),
    ).filter((entry) => entry.decision === undefined || !decided.has(entry.decision)),
    ...latest,
  ];
};

/**
 * The kept answers once the owner answered the agent's own question: each settles the decision
 * named by its question's id, which a script's question may name to reuse it.
 */
export const keptAgentAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (KeptQuestion | undefined)[],
  answers: ValidAnswers,
): readonly KeptScriptAnswer[] =>
  keptScriptAnswers(kept, keys, answers, keys.map((key) => key?.id));
