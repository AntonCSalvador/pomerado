import { Effect, Either } from "effect";
import {
  validateAnswer,
  type InputRequest,
  type ValidAnswer,
  type ValidAnswers,
} from "../runtime/input-request.js";
import type { CommitEvidence } from "../runtime/run-outcome.js";

/**
 * How long after the owner answers a script's question a later step of the same build may reuse
 * the answer instead of asking again.
 */
export const scriptAnswerReuseMs = 30 * 60_000;

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
 * One answer the owner gave a script's question in this build, which a later step may reuse: the
 * screened question, the answer as the asker returned it, and when and in which execution the
 * owner gave it.
 */
export interface KeptScriptAnswer {
  readonly executionId: string;
  readonly answeredAtMs: number;
  readonly question: ScriptQuestionKey;
  readonly answer: ValidAnswer;
}

/** The step a script's ask runs in, and when it asks. */
export interface ScriptAskStep {
  readonly executionId: string;
  readonly nowMs: number;
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
const fresh = (entry: KeptScriptAnswer, nowMs: number) =>
  nowMs - entry.answeredAtMs < scriptAnswerReuseMs;

/**
 * The kept answers a later step's ask may reuse, in a fresh answer's shape, with the kept answers
 * after it, or undefined to ask the owner. Every question needs an answer an execution other than
 * this one kept less than `scriptAnswerReuseMs` ago for the same question, and the answer must
 * still be valid for the question as asked now. One question that is a code, a secret or a login,
 * or that has no such answer, asks the owner again. A reused answer then counts as this
 * execution's, so each execution reuses it at most once: a step that asks again, as before a
 * second try at its commit, asks the owner.
 */
export const reusedScriptAnswers = (
  asked: InputRequest,
  keys: readonly (ScriptQuestionKey | undefined)[],
  kept: readonly KeptScriptAnswer[],
  step: ScriptAskStep,
): { readonly answers: ValidAnswers; readonly kept: readonly KeptScriptAnswer[] } | undefined => {
  const values: Record<string, unknown> = {};
  const matched = new Set<KeptScriptAnswer>();
  for (const key of keys) {
    const entry =
      key === undefined
        ? undefined
        : kept.find(
            (candidate) =>
              candidate.executionId !== step.executionId &&
              fresh(candidate, step.nowMs) &&
              sameQuestion(candidate.question, key),
          );
    if (key === undefined || entry === undefined) return undefined;
    values[key.id] = entry.answer.value;
    matched.add(entry);
  }
  const valid = validateAnswer(asked, values);
  if (Either.isLeft(valid)) return undefined;
  return {
    answers: valid.right,
    kept: kept.map((entry) =>
      matched.has(entry) ? { ...entry, executionId: step.executionId } : entry,
    ),
  };
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
 * replace any kept for the same prompt, and answers older than `scriptAnswerReuseMs` go.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (ScriptQuestionKey | undefined)[],
  answers: ValidAnswers,
  step: ScriptAskStep,
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    return key === undefined || answer === undefined
      ? []
      : [{ executionId: step.executionId, answeredAtMs: step.nowMs, question: key, answer }];
  });
  return [
    ...forgetScriptAnswers(
      kept.filter((entry) => fresh(entry, step.nowMs)),
      latest.map((entry) => entry.question.prompt),
    ),
    ...latest,
  ];
};

/**
 * Whether no earlier step of the build has entered a commit or may have: each finished act step,
 * of any label, must have reported its declared commit steps and entered none (`not_entered`), and
 * each finished step Guardian labelled a write must be one of them. A missing report, a script that
 * declares no commit step, or a write in any other step counts as may have.
 */
export const scriptCommitsUnsent = (facts: {
  readonly actSteps: readonly {
    readonly executionId: string;
    readonly commit?: CommitEvidence | undefined;
  }[];
  readonly writeSteps: readonly string[];
}) =>
  facts.actSteps.every((step) => step.commit === "not_entered") &&
  facts.writeSteps.every((executionId) =>
    facts.actSteps.some((step) => step.executionId === executionId),
  );
