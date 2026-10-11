import { Effect, Either } from "effect";
import {
  validateAnswer,
  type InputRequest,
  type ValidAnswer,
  type ValidAnswers,
} from "../runtime/input-request.js";

/**
 * What a later ask must match to reuse an answer: its id, type, screened prompt, and its screened
 * options or a confirm's screened follow-up.
 */
export interface ScriptQuestionKey {
  readonly id: string;
  readonly type: "choice" | "multi_choice" | "text" | "confirm";
  readonly prompt: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
  readonly followUp?: { readonly prompt: string; readonly defaultText?: string };
}

/**
 * One answer the owner gave a script's question in this build, which a later ask may reuse: the
 * screened question and the answer as the asker returned it.
 */
export interface KeptScriptAnswer {
  readonly question: ScriptQuestionKey;
  readonly answer: ValidAnswer;
}

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
      if (question.type === "secret" || question.type === "credential") return undefined;
      const key = { id: question.id, type: question.type, prompt: yield* screen(question.prompt) };
      if (question.type === "choice" || question.type === "multi_choice") {
        const options = yield* Effect.forEach(question.options, (option) =>
          screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
        );
        return { ...key, options } satisfies ScriptQuestionKey;
      }
      if (question.type !== "confirm" || question.followUp === undefined)
        return key satisfies ScriptQuestionKey;
      const { prompt, defaultText } = question.followUp;
      const followUp = {
        prompt: yield* screen(prompt),
        ...(defaultText === undefined ? {} : { defaultText: yield* screen(defaultText) }),
      };
      return { ...key, followUp } satisfies ScriptQuestionKey;
    }),
  );

const sameQuestion = (left: ScriptQuestionKey, right: ScriptQuestionKey) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * The kept answers a script's ask may reuse, in a fresh answer's shape, or undefined to ask the
 * owner. Every question needs a kept answer to the same question, and the answer must still be
 * valid for the question as asked now. One question that is a code, a secret or a login, or that
 * has no such answer, asks the owner again. Any step may reuse a kept answer, the one that got it
 * included, as often as the question comes back and however long ago the owner gave it, whether
 * or not a step entered a commit since.
 */
export const reusedScriptAnswers = (
  asked: InputRequest,
  keys: readonly (ScriptQuestionKey | undefined)[],
  kept: readonly KeptScriptAnswer[],
): ValidAnswers | undefined => {
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const entry =
      key === undefined
        ? undefined
        : kept.find((candidate) => sameQuestion(candidate.question, key));
    if (key === undefined || entry === undefined) return undefined;
    values[key.id] = entry.answer.value;
  }
  const valid = validateAnswer(asked, values);
  return Either.isLeft(valid) ? undefined : valid.right;
};

/**
 * The kept answers without any to these screened prompts. Only the owner's latest answer to a
 * prompt stands, as in Guardian's trusted answers, so an answer the owner gave since to a question
 * with the same prompt, whoever asked it, means the next script ask asks again.
 */
export const forgetScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  prompts: readonly string[],
): readonly KeptScriptAnswer[] =>
  kept.filter((entry) => !prompts.includes(entry.question.prompt));

/**
 * The kept answers once the owner answered a script's question afresh: its reusable answers
 * replace any kept for the same prompt.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (ScriptQuestionKey | undefined)[],
  answers: ValidAnswers,
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    return key === undefined || answer === undefined ? [] : [{ question: key, answer }];
  });
  return [
    ...forgetScriptAnswers(kept, latest.map((entry) => entry.question.prompt)),
    ...latest,
  ];
};
