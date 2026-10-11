import { Effect, Either } from "effect";
import {
  validateAnswer,
  type InputRequest,
  type ValidAnswer,
  type ValidAnswers,
} from "../runtime/input-request.js";
import type { CommitEvidence } from "../runtime/run-outcome.js";

/**
 * How long after the owner answers a script's question a rerun of its step in the same build may
 * reuse the answer instead of asking again.
 */
export const scriptAnswerReuseMs = 30 * 60_000;

/** What a later ask must match to reuse an answer: its id, type, screened prompt and options. */
export interface ScriptQuestionKey {
  readonly id: string;
  readonly type: "choice" | "multi_choice" | "text" | "confirm";
  readonly prompt: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
}

/**
 * One answer the owner gave a script's question in this build, which a rerun of its step may
 * reuse: the screened question, the answer as the asker returned it, and when and in which
 * execution the owner gave it.
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
 * Each question's match key, its prompt and option labels screened as the owner saw them, or
 * undefined for a question no rerun may reuse: a code, a secret or a login.
 */
export const scriptQuestionKeys = <E>(
  asked: InputRequest,
  screen: (text: string) => Effect.Effect<string, E>,
) =>
  Effect.forEach(asked.questions, (question) =>
    Effect.gen(function* () {
      if (question.type === "secret" || question.type === "credential") return undefined;
      const prompt = yield* screen(question.prompt);
      if (question.type !== "choice" && question.type !== "multi_choice")
        return { id: question.id, type: question.type, prompt } satisfies ScriptQuestionKey;
      const options = yield* Effect.forEach(question.options, (option) =>
        screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
      );
      return { id: question.id, type: question.type, prompt, options } satisfies ScriptQuestionKey;
    }),
  );

const sameQuestion = (left: ScriptQuestionKey, right: ScriptQuestionKey) =>
  JSON.stringify(left) === JSON.stringify(right);
const fresh = (entry: KeptScriptAnswer, nowMs: number) =>
  nowMs - entry.answeredAtMs < scriptAnswerReuseMs;

/**
 * The kept answers a rerun's ask may reuse, in a fresh answer's shape, or undefined to ask the
 * owner. Every question needs an answer an earlier execution of this build kept less than
 * `scriptAnswerReuseMs` ago for the same question; one question that is a code, a secret or a
 * login, or that has no such answer, asks the owner again.
 */
export const reusedScriptAnswers = (
  asked: InputRequest,
  keys: readonly (ScriptQuestionKey | undefined)[],
  kept: readonly KeptScriptAnswer[],
  step: ScriptAskStep,
): ValidAnswers | undefined => {
  const values: Record<string, unknown> = {};
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
  }
  const valid = validateAnswer(asked, values);
  return Either.isRight(valid) ? valid.right : undefined;
};

/**
 * The kept answers once the owner answered a script's question afresh: its reusable answers
 * replace any kept for the same question, and answers older than `scriptAnswerReuseMs` go.
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
    ...kept.filter(
      (entry) =>
        fresh(entry, step.nowMs) &&
        !latest.some((answer) => sameQuestion(answer.question, entry.question)),
    ),
    ...latest,
  ];
};

/**
 * Whether no commit of the build has gone out or may have. A read build sends none. Otherwise
 * each finished act step must have reported its declared commit steps and entered none
 * (`not_entered`), and each step Guardian labelled a write must be one of them. A missing report,
 * a script that declares no commit step, or a write in any other step counts as may have gone out.
 */
export const scriptCommitsUnsent = (facts: {
  readonly effect: "read" | "write" | undefined;
  readonly actSteps: readonly {
    readonly executionId: string;
    readonly commit?: CommitEvidence | undefined;
  }[];
  readonly writeSteps: readonly string[];
}) =>
  facts.effect === "read" ||
  (facts.actSteps.every((step) => step.commit === "not_entered") &&
    facts.writeSteps.every((executionId) =>
      facts.actSteps.some((step) => step.executionId === executionId),
    ));
