import { Effect } from "effect";
import { expect, it } from "vitest";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

// A synthetic write that saves a draft and then submits it, whose build's session stopped after
// the draft. The local host's offline contract read keeps the steps it declares unproven, so its
// publication check can accept them.

const entrypoint = "operation/src/tool.mjs";
const source = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ saved: Schema.Boolean }),
    write: {
      confirmation: "readback",
      commits: ["save-draft", "submit-draft"],
      commitsUnproven: ["submit-draft"],
    },
  },
  async ({ kernel, sessionId, enteringCommit, verified }) => {
    enteringCommit("save-draft");
    await kernel.browsers.playwright.execute(sessionId, { code: "return save();" });
    enteringCommit("submit-draft");
    await kernel.browsers.playwright.execute(sessionId, { code: "return submit();" });
    verified();
    return { saved: true };
  },
);`;

// Starting the local operation child takes seconds on a loaded host.
it("keeps a write's unproven commit steps in its offline contract", { timeout: 30_000 }, async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources: [[entrypoint, source]],
          input: {},
          validateInput: true,
          mode: "contract",
          target: "pureFiles",
        });
      }),
    ),
  );
  expect(result).toMatchObject({ effect: "not_sent", inputDecodes: true });
  expect(result.write).toEqual({
    confirmation: "readback",
    commits: ["save-draft", "submit-draft"],
    commitsUnproven: ["submit-draft"],
  });
});
