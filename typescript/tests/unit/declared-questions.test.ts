import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { asksAsDeclared } from "../../src/execution/declared-questions.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { makeInputAsker } from "../../src/inputs/callback.js";
import {
  draftQuestionDeclarationFailure,
  draftQuestionDeclarations,
} from "../../src/mint/draft-questions.js";
import type { InputRequest } from "../../src/runtime/input-request.js";
import {
  makeScriptInput,
  ScriptInputFailure,
  type ScriptQuestionDeclarations,
} from "../../src/runtime/script-input.js";

const operation = (contract: string, body = "async () => ({})") => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
${contract.includes("defineOperation") ? contract : `export default defineOperation(${contract}, ${body});`}`;
const note = { type: "text", prompt: "Which note should I keep?" } as const;

describe("draftQuestionDeclarations", () => {
  it("reads the questions a draft's one defineOperation declares as a plain literal", () => {
    const source = operation(
      `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"},"seat":{type:"choice",prompt:\`Which seat?\`,allowOther:true}}}`,
    );
    expect(draftQuestionDeclarations("src/tool.mjs", source)).toEqual({
      note,
      seat: { type: "choice", prompt: "Which seat?", allowOther: true },
    });
    expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBeUndefined();
  });

  it("reads TypeScript, with its as and satisfies expressions", () => {
    const source = operation(
      `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"} as const} satisfies object}`,
    );
    expect(draftQuestionDeclarations("src/tool.ts", source)).toEqual({ note });
  });

  it.each([
    [
      "a declaration through a variable",
      `const questions = { note: { type: "text", prompt: "Which note should I keep?" } };
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions}, async () => ({}));`,
    ],
    [
      "a spread",
      `const extra = {};
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{...extra,note:{type:"text",prompt:"Which note should I keep?"}}}, async () => ({}));`,
    ],
    [
      "a template with a value in it",
      `const word = "note";
export default defineOperation({name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:\`Which \${word} should I keep?\`}}}, async () => ({}));`,
    ],
    [
      "two operations",
      `export const one = defineOperation({name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}}, async () => ({}));
export default defineOperation({name:"b",input:Schema.Unknown,output:Schema.Unknown}, async () => ({}));`,
    ],
    ["source that does not parse", `export default defineOperation({name:"a",questions:{`],
    [
      "an extra field",
      `export default defineOperation({name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?",hint:"x"}}}, async () => ({}));`,
    ],
  ])("declares nothing for %s", (_, source) => {
    expect(draftQuestionDeclarations("src/tool.mjs", operation(source))).toEqual({});
  });

  it("names each invalid id of a literal declaration before a step runs", () => {
    const source = operation(
      `{name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{pageTitle:{type:"text",prompt:"Which page?"},"2nd":{type:"text",prompt:"Which?"},ok:{type:"text",prompt:"Fine"}}}`,
    );
    expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBe(
      'Invalid script question ids: "pageTitle", "2nd". Question ids must start with a lowercase letter and contain only lowercase letters, digits, or underscores, up to 64 characters. Rename them before executing.',
    );
    expect(
      draftQuestionDeclarationFailure(
        "src/tool.mjs",
        operation(`{name:"a",input:Schema.Unknown,output:Schema.Unknown,questions:{Note:{type:"text",prompt:"Which?"}}}`),
      ),
    ).toContain('Invalid script question id: "Note".');
  });
});

/** The request core's script input builds for `asked` under `declared`, as a running script sends it. */
const requestFor = (declared: ScriptQuestionDeclarations, asked: Parameters<ReturnType<typeof makeScriptInput>["ask"]>[0]) => {
  let sent: InputRequest | undefined;
  Effect.runSync(
    Effect.either(
      makeScriptInput(declared, (request) =>
        Effect.sync(() => {
          sent = request;
        }).pipe(Effect.zipRight(Effect.fail(new ScriptInputFailure({ code: "Unavailable" })))),
      ).ask(asked),
    ),
  );
  if (sent === undefined) throw new Error("No request sent");
  return sent;
};

describe("asksAsDeclared", () => {
  const declared: ScriptQuestionDeclarations = {
    note,
    seat: { type: "choice", prompt: "Which seat?" },
    sides: { type: "multi_choice", prompt: "Which sides?", maxSelections: 2 },
    sure: { type: "confirm", prompt: "Go ahead?" },
    code: { type: "secret", prompt: "Which code?", secretKind: "one_time_code" },
  };
  const options = [
    { value: "a", label: "Aisle" },
    { value: "w", label: "Window" },
    { value: "m", label: "Middle" },
  ];

  it("allows a request that asks exactly what was declared", () => {
    expect(asksAsDeclared(requestFor(declared, "note"), declared)).toBe(true);
    expect(
      asksAsDeclared(
        requestFor(declared, { seat: { options }, sides: { options }, sure: {}, code: {} }),
        declared,
      ),
    ).toBe(true);
  });

  it("refuses a request whose prompt or bounds differ from the declaration it is checked against", () => {
    const asked = requestFor(declared, "note");
    expect(asksAsDeclared(asked, { note: { ...note, prompt: "Which note?" } })).toBe(false);
    expect(asksAsDeclared(asked, { note: { ...note, maxLength: 10 } })).toBe(false);
    expect(asksAsDeclared(asked, { note: { type: "confirm", prompt: note.prompt } })).toBe(false);
    const sides = requestFor(declared, { sides: { options } });
    expect(asksAsDeclared(sides, { sides: { type: "multi_choice", prompt: "Which sides?" } })).toBe(
      false,
    );
    const seat = requestFor(declared, { seat: { options } });
    expect(asksAsDeclared(seat, { seat: { type: "choice", prompt: "Which seat?", allowOther: true } })).toBe(false);
    // The pre-unification `{ prompt }` declaration is a plain choice.
    expect(asksAsDeclared(seat, { seat: { prompt: "Which seat?" } })).toBe(true);
  });

  it("refuses an undeclared id, an inherited one, a notice and a request that is not the script's", () => {
    const asked = requestFor(declared, "note");
    expect(asksAsDeclared(asked, {})).toBe(false);
    expect(asksAsDeclared(asked, Object.create({ note }) as ScriptQuestionDeclarations)).toBe(false);
    expect(asksAsDeclared({ ...asked, notice: "Read this first." }, declared)).toBe(false);
    expect(asksAsDeclared({ ...asked, source: "agent" }, declared)).toBe(false);
  });
});

it("reads a question declared afterCommit from a draft", () => {
  const source = operation(
    `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:{slot:{type:"choice",prompt:"Which delivery slot should I book?",afterCommit:true}}}`,
  );
  expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBeUndefined();
  expect(draftQuestionDeclarations("src/tool.mjs", source)).toEqual({
    slot: { type: "choice", prompt: "Which delivery slot should I book?", afterCommit: true },
  });
});

it("reads a secret question declared afterCommit, and afterCommit false as left out", () => {
  const source = operation(
    `{name:"pay",input:Schema.Unknown,output:Schema.Unknown,questions:{code:{type:"secret",prompt:"What code did the bank send?",secretKind:"one_time_code",afterCommit:true}}}`,
  );
  expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBeUndefined();
  expect(draftQuestionDeclarations("src/tool.mjs", source)).toEqual({
    code: { type: "secret", prompt: "What code did the bank send?", secretKind: "one_time_code", afterCommit: true },
  });
  const offSource = operation(
    `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:{slot:{type:"choice",prompt:"Which delivery slot should I book?",afterCommit:false},note:{type:"text",prompt:"Which note should I keep?"}}}`,
  );
  expect(draftQuestionDeclarationFailure("src/tool.mjs", offSource)).toBeUndefined();
  expect(draftQuestionDeclarations("src/tool.mjs", offSource)).toEqual({
    slot: { type: "choice", prompt: "Which delivery slot should I book?", afterCommit: false },
    note,
  });
});

// One invalid declaration would leave the run with none, so the draft check names it before a step runs.
it("refuses a declaration that does not decode instead of dropping every question", () => {
  const source = operation(
    `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:{slot:{type:"choice",prompt:"Which slot?",afterCommit:"yes"},note:{type:"text",prompt:"Which note should I keep?"}}}`,
  );
  expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toMatch(/^Invalid script questions: the run would declare none of them\./);
});

describe("a local operation's questions", () => {
  const asking = operation(
    `{name:"ask_note",input:Schema.Unknown,output:Schema.Unknown,questions:{note:{type:"text",prompt:"Which note should I keep?"}}}`,
    `async ({ ask }) => ({ note: await ask("note") })`,
  );
  const run = (declaredQuestions?: ScriptQuestionDeclarations) => {
    const asked: InputRequest[] = [];
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        asked.push(request);
        return { note: "kept" };
      }),
    );
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint: "src/tool.mjs",
              sources: [["src/tool.mjs", asking]],
              input: {},
              target: "pureFiles",
              ask,
              ...(declaredQuestions === undefined ? {} : { declaredQuestions }),
            }),
          );
        }),
      ),
    ).then((result) => ({ result, asked }));
  };

  it("puts a question to the caller when it matches what the host read", async () => {
    const { result, asked } = await run({ note });
    expect(Either.isRight(result) && result.right.output).toEqual({ note: "kept" });
    expect(asked).toHaveLength(1);
  });

  it.each([
    ["a different prompt", { note: { ...note, prompt: "Which note?" } }],
    ["no declarations", {}],
    ["declarations the host never read", undefined],
  ])("fails the ask as Undeclared and asks nobody for %s", async (_, declared) => {
    const { result, asked } = await run(declared);
    expect(asked).toEqual([]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LocalOperationFailure);
      expect(result.left).toMatchObject({ tag: "ScriptInputFailure", code: "Undeclared" });
    }
  });

  it("reports which option of a question could not be asked, and never its value or label", async () => {
    const seat = { seat: { type: "choice", prompt: "Which seat?" } } as const;
    const source = operation(
      `{name:"ask_seat",input:Schema.Unknown,output:Schema.Unknown,questions:${JSON.stringify(seat)}}`,
      `async ({ ask }) => ask({ seat: { options: [{ value: "seat-4a", label: "Window 4A" }, { value: "seat-4a", label: "Aisle 4C" }] } })`,
    );
    const asked: InputRequest[] = [];
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        asked.push(request);
        return {};
      }),
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint: "src/tool.mjs",
              sources: [["src/tool.mjs", source]],
              input: {},
              target: "pureFiles",
              ask,
              declaredQuestions: seat,
            }),
          );
        }),
      ),
    );
    expect(asked).toEqual([]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LocalOperationFailure);
      expect(result.left).toMatchObject({ tag: "ScriptInputFailure", code: "InvalidOptions" });
      expect(result.left.message).toBe(
        "Script question seat could not be asked because option 2 repeats another option's value.",
      );
      for (const said of ["seat-4a", "Window 4A", "Aisle 4C"])
        expect(result.left.message).not.toContain(said);
    }
  });
});

describe("card questions in a script", () => {
  it("accepts a script that declares a card question, for its fillCard", () => {
    const source = operation(
      `{name:"book",input:Schema.Unknown,output:Schema.Unknown,questions:{card:{type:"secret",secretKind:"card_number",prompt:"Card number?"},zip:{type:"secret",secretKind:"billing_postal_code",prompt:"Billing ZIP?"},note:{type:"text",prompt:"Any note?"}}}`,
    );
    expect(draftQuestionDeclarationFailure("src/tool.mjs", source)).toBeUndefined();
    expect(draftQuestionDeclarations("src/tool.mjs", source)).toMatchObject({
      card: { type: "secret", secretKind: "card_number" },
      zip: { type: "secret", secretKind: "billing_postal_code" },
    });
  });
});

// A question asked once a write's commit step may have reached the site leaves the record half
// done while the caller decides, such as a draft saved before asking which kind of line to add.
// The runtime refuses it with words that name the question and the step; a code the site sends
// only after that step is the one question that can come later.
describe("a question asked after a commit mark", () => {
  const questions = {
    line_kind: { type: "choice", prompt: "Which kind of line should I add?" },
    slot: { type: "choice", prompt: "Which delivery slot should I book?", afterCommit: true },
    card: {
      type: "secret",
      secretKind: "card_number",
      prompt: "Card number?",
      afterCommit: true,
    },
    code: {
      type: "secret",
      secretKind: "one_time_code",
      prompt: "Enter the code the website just sent you.",
    },
  } as const;
  const write = (body: string) =>
    operation(
      `{name:"save_invoice",input:Schema.Unknown,output:Schema.Unknown,write:{confirmation:"readback",commits:["save_draft","submit"]},questions:${JSON.stringify(questions)}}`,
      body,
    );
  const run = (source: string) => {
    const asked: InputRequest[] = [];
    const ask = makeInputAsker((request) =>
      Effect.sync(() => {
        asked.push(request);
        const question = request.questions[0];
        // The first option the page offered, or a code.
        return question?.type === "choice"
          ? { [question.id]: question.options[0]?.id ?? "" }
          : { [question?.id ?? "code"]: "123456" };
      }),
    );
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* createLocalWorkspace();
          return yield* Effect.either(
            runLocalOperation({
              workspace,
              entrypoint: "src/tool.mjs",
              sources: [["src/tool.mjs", source]],
              input: {},
              target: "pureFiles",
              ask,
              declaredQuestions: questions,
            }),
          );
        }),
      ),
    ).then((result) => ({ result, asked }));
  };
  const lineOptions = `{ options: [{ value: "item", label: "Item line" }, { value: "text", label: "Free-text line" }] }`;

  it("refuses the question, names it and the step, and asks nobody", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit }) => { enteringCommit("save_draft"); return { kind: await ask({ line_kind: ${lineOptions} }) }; }`,
      ),
    );
    expect(asked).toEqual([]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(LocalOperationFailure);
      expect(result.left).toMatchObject({ tag: "ScriptInputFailure", code: "AskedAfterCommit" });
      expect(result.left.message).toContain("line_kind");
      expect(result.left.message).toContain("save_draft");
    }
  });

  it("refuses askOne and a list of ids after the mark the same way", async () => {
    for (const call of [
      `askOne("line_kind", ${lineOptions})`,
      `ask(["code", "line_kind"])`,
    ]) {
      const { result, asked } = await run(
        write(`async ({ ask, askOne, enteringCommit }) => { enteringCommit("submit"); return await ${call}; }`),
      );
      expect(asked).toEqual([]);
      expect(Either.isLeft(result) && result.left).toMatchObject({ code: "AskedAfterCommit" });
    }
  });

  it("names only an identifier the script passed, never other text", async () => {
    const { result } = await run(
      write(
        `async ({ ask, enteringCommit }) => { enteringCommit("save draft for Ada"); return await ask("Ada's card 4242"); }`,
      ),
    );
    expect(Either.isLeft(result) && result.left).toMatchObject({ code: "AskedAfterCommit" });
    if (Either.isLeft(result)) {
      expect(result.left.message).toMatch(/^A script question was asked after the commit step was entered/u);
      for (const said of ["Ada", "4242"]) expect(result.left.message).not.toContain(said);
    }
  });

  // Options a saved step first shows, such as the delivery slots for the cart it filled, can only
  // be asked after that step: the contract declares such a question afterCommit, where the
  // publication review reads it.
  it("asks a question its contract declares afterCommit, once a step entered its mark", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit }) => { enteringCommit("save_draft"); const slot = (await ask({ slot: { options: [{ value: "am", label: "Morning" }] } })).slot; const card = (await ask(["card"])).card; return { slot, card: card.length > 0 }; }`,
      ),
    );
    expect(Either.isRight(result) && result.right.output).toEqual({ slot: "am", card: true });
    expect(asked.map((request) => request.questions[0]?.id)).toEqual(["slot", "card"]);
  });

  it("still refuses an undeclared question asked beside one declared afterCommit", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit }) => { enteringCommit("save_draft"); return await ask({ slot: { options: [{ value: "am", label: "Morning" }] }, line_kind: ${lineOptions} }); }`,
      ),
    );
    expect(asked).toEqual([]);
    expect(Either.isLeft(result) && result.left).toMatchObject({ code: "AskedAfterCommit" });
    if (Either.isLeft(result)) expect(result.left.message).toContain("line_kind");
  });

  it("asks again once verified() confirmed the write, which is then whole", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit, verified }) => { enteringCommit("submit"); verified(); return { kind: (await ask({ line_kind: ${lineOptions} })).line_kind }; }`,
      ),
    );
    expect(Either.isRight(result) && result.right.output).toEqual({ kind: "item" });
    expect(asked).toHaveLength(1);
  });

  it("asks the same question before the first commit mark", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit }) => { const kind = (await ask({ line_kind: ${lineOptions} })).line_kind; enteringCommit("save_draft"); return { kind }; }`,
      ),
    );
    expect(Either.isRight(result) && result.right.output).toEqual({ kind: "item" });
    expect(asked).toHaveLength(1);
  });

  it("asks for a code the site sends after a commit step", async () => {
    const { result, asked } = await run(
      write(
        `async ({ ask, enteringCommit }) => { enteringCommit("save_draft"); const code = await ask("code"); return { sent: code.length > 0 }; }`,
      ),
    );
    expect(Either.isRight(result) && result.right.output).toEqual({ sent: true });
    expect(asked).toHaveLength(1);
  });
});
