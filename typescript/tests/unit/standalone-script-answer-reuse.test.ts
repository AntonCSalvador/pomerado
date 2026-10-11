// Failure modes covered: a rerun asks the owner again for an answer it may reuse; a rerun reuses
// an answer too old, to another question, to a code, secret or login, or after a commit went out
// or may have.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { InputRequest, ValidAnswers } from "../../src/runtime/input-request.js";
import {
  keptScriptAnswers,
  reusedScriptAnswers,
  scriptAnswerReuseMs,
  scriptCommitsUnsent,
  scriptQuestionKeys,
  type KeptScriptAnswer,
} from "../../src/standalone/script-answer-reuse.js";

const request = (questions: InputRequest["questions"]): InputRequest => ({
  id: "request",
  source: "script",
  questions,
});
const plan = request([
  {
    id: "plan",
    type: "choice",
    prompt: "Which plan do you have?",
    options: [
      { id: "gold", label: "Gold" },
      { id: "silver", label: "Silver" },
    ],
  },
]);
const answered: ValidAnswers = { plan: { type: "choice", value: "gold" } };
const keys = (asked: InputRequest) =>
  Effect.runSync(scriptQuestionKeys(asked, (text) => Effect.succeed(text)));
const kept = (asked: InputRequest, answers: ValidAnswers, nowMs = 0) =>
  keptScriptAnswers([], keys(asked), answers, { executionId: "first", nowMs });
const rerun = (asked: InputRequest, entries: readonly KeptScriptAnswer[], nowMs = 1) =>
  reusedScriptAnswers(asked, keys(asked), entries, { executionId: "rerun", nowMs });

describe("a rerun of a script's step", () => {
  it("reuses the owner's answer to the same question in a fresh answer's shape", () => {
    expect(rerun(plan, kept(plan, answered))).toEqual(answered);
  });

  it("asks again within the step that asked, and once the answer is as old as the window", () => {
    const entries = kept(plan, answered);
    expect(
      reusedScriptAnswers(plan, keys(plan), entries, { executionId: "first", nowMs: 1 }),
    ).toBeUndefined();
    expect(rerun(plan, entries, scriptAnswerReuseMs - 1)).toEqual(answered);
    expect(rerun(plan, entries, scriptAnswerReuseMs)).toBeUndefined();
    // A later answer drops the expired one.
    const late = { executionId: "late", nowMs: scriptAnswerReuseMs };
    expect(keptScriptAnswers(entries, keys(request([])), {}, late)).toEqual([]);
  });

  it("asks again when the question's id, type, prompt or options changed", () => {
    const entries = kept(plan, answered);
    const [question] = plan.questions;
    if (question?.type !== "choice") throw new Error("The fixture asks a choice");
    for (const changed of [
      { ...question, id: "tier" },
      { ...question, type: "multi_choice" as const, minSelections: 1, maxSelections: 1 },
      { ...question, prompt: "Which plan should the booking use?" },
      { ...question, options: [...question.options, { id: "bronze", label: "Bronze" }] },
      { ...question, options: [{ id: "gold", label: "Gold plan" }, question.options[1]!] },
    ])
      expect(rerun(request([changed]), entries)).toBeUndefined();
  });

  it("never keeps or reuses a code, a secret or a login answer", () => {
    const code = request([
      {
        id: "code",
        type: "secret",
        secretKind: "one_time_code",
        prompt: "Which code did the site send?",
      },
    ]);
    const codeAnswer: ValidAnswers = { code: { type: "secret", value: "{{secret.s1}}" } };
    expect(kept(code, codeAnswer)).toEqual([]);
    // One protected question in a request asks the whole request again.
    const both = request([...plan.questions, ...code.questions]);
    expect(rerun(both, kept(both, { ...answered, ...codeAnswer }))).toBeUndefined();
  });
});

describe("whether a build's commits are still unsent", () => {
  const act = (commit: "not_entered" | "entered" | "undeclared" | "unreported") => ({
    executionId: "act",
    commit,
  });

  it("holds for a read build and while every act step entered none of its declared commits", () => {
    expect(
      scriptCommitsUnsent({ effect: "read", actSteps: [act("entered")], writeSteps: ["x"] }),
    ).toBe(true);
    for (const effect of ["write", undefined] as const)
      expect(
        scriptCommitsUnsent({ effect, actSteps: [act("not_entered")], writeSteps: ["act"] }),
      ).toBe(true);
  });

  it("fails once a commit went out or may have", () => {
    for (const commit of ["entered", "undeclared", "unreported"] as const)
      expect(
        scriptCommitsUnsent({ effect: "write", actSteps: [act(commit)], writeSteps: [] }),
      ).toBe(false);
    // A step Guardian labelled a write that is no act step has no commit report to rely on.
    const example = { effect: "write" as const, writeSteps: ["example"] };
    expect(scriptCommitsUnsent({ ...example, actSteps: [act("not_entered")] })).toBe(false);
  });
});
