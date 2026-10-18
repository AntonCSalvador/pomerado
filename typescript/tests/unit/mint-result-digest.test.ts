import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Exit, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { createLocalWorkspace, type LocalWorkspace } from "../../src/execution/local-workspace.js";
import { MintFailure } from "../../src/mint/contracts.js";
import type { ExecutionEvidence, MintDependencies } from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { resultDigestThresholdBytes } from "../../src/mint/result-digest.js";
import { mintError } from "../../src/standalone/errors.js";
import { fixtureAllow, makeMintContinuationFixture } from "../support/mint-fixtures.js";

// A browser execution's result reaches the minter whole while it fits the threshold. A larger
// one is saved whole to a read-only workspace file first and the minter gets a digest naming that
// file, which it reads back with read_source. A failure's error text is never digested away.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The local host's workspace, whose `install` saves a read-only file as the host's hook does. */
let local: LocalWorkspace | undefined;
const localSession = async (entries: Readonly<Record<string, string>>) => {
  const scope = await Effect.runPromise(Scope.make());
  const workspace = await Effect.runPromise(
    createLocalWorkspace().pipe(Effect.provideService(Scope.Scope, scope)),
  );
  for (const [path, text] of Object.entries(entries))
    await Effect.runPromise(workspace.write(path, text));
  local = workspace;
  return Object.assign(workspace.session, {
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  });
};
const fixture = makeMintContinuationFixture(cleanups, localSession, makeOpenAIMinter);

const respond = (output: ModelResponse["output"]): ModelResponse => ({
  usage: new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  output,
});
const call = (name: string, input: Record<string, unknown>, callId = name) =>
  respond([
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify(input),
      status: "completed",
    },
  ]);
const done = respond([
  {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done." }],
  },
]);

const example = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
  intent: "Run the example",
};

/** The text of the tool call `callId`'s result, as the model read it in `request`. */
const toolText = (request: ModelRequest | undefined, callId: string) => {
  const input = Array.isArray(request?.input) ? request.input : [];
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item !== undefined && "output" in item ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? output.text
        : undefined;
  if (typeof text !== "string") throw new Error(`Missing result of ${callId}`);
  return text;
};

/** A result of `rows` product rows, each about 200 bytes. */
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    title: `Synthetic product number ${index} with a long descriptive title`,
    price: { amount: 10 + index, currency: "USD" },
    tags: ["alpha", "beta"],
  }));

/**
 * Runs one execution whose result is `observations`, then, when its result names a file, reads
 * that file with read_source, range by range as each read's `nextOffset` says. Returns what the
 * model read of each.
 */
const runOnce = async (
  observations: unknown,
  status: ExecutionEvidence["status"] = "completed",
  // null: a host without the hook.
  saveResult: MintDependencies["saveResult"] | null = (path, text) => {
    if (local === undefined) throw new Error("No local workspace");
    return local.install(path, text).pipe(Effect.mapError(mintError));
  },
) => {
  let digestPath: string | undefined;
  let file = "";
  const read = (path: string, offset: number) =>
    call("read_source", { path, offset, limit: 64_000, paths: null }, `read_${offset}`);
  const f = await fixture(
    (request, index) => {
      if (index === 0) return call("execute", example, "run");
      if (index === 1) {
        const executed = JSON.parse(toolText(request, "run")) as { observations: string };
        const parsed: unknown = JSON.parse(executed.observations);
        if (typeof parsed !== "object" || parsed === null || !("path" in parsed)) return done;
        digestPath = String(parsed.path);
        return read(digestPath, 0);
      }
      if (digestPath === undefined) return done;
      const range = JSON.parse(toolText(request, `read_${file.length}`)) as {
        source: string;
        nextOffset: number | null;
      };
      file += range.source;
      return range.nextOffset === null ? done : read(digestPath, range.nextOffset);
    },
    {
      ...(saveResult === null ? {} : { saveResult }),
      reviewAndExecute: (input, beforeDispatch = () => Effect.void) =>
        beforeDispatch(fixtureAllow(input.purpose)).pipe(
          Effect.as({
            executionId: "execution_one",
            status,
            effect: "not_sent" as const,
            ...(status === "completed" ? { resultRef: "protected_result" } : {}),
            observations,
          }),
        ),
    },
  );
  await f.run();
  const delivered = (JSON.parse(toolText(f.requests[1], "run")) as { observations: string })
    .observations;
  return { delivered, file: digestPath === undefined ? undefined : file, digestPath };
};

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

it("returns a result within the threshold whole and unchanged", async () => {
  const observations = { output: rows(20), stdout: "", stderr: "" };
  expect(bytes(JSON.stringify(observations))).toBeLessThan(resultDigestThresholdBytes);
  const { delivered, file } = await runOnce(observations);
  expect(delivered).toBe(JSON.stringify(observations));
  expect(file).toBeUndefined();
});

it("returns a larger result as a digest naming a file that holds the whole result", async () => {
  const observations = { output: { items: rows(400), total: 400 }, stdout: "", stderr: "" };
  const whole = JSON.stringify(observations);
  expect(bytes(whole)).toBeGreaterThan(resultDigestThresholdBytes * 2);
  const { delivered, file, digestPath } = await runOnce(observations);

  expect(bytes(delivered)).toBeLessThan(resultDigestThresholdBytes / 2);
  const digest = JSON.parse(delivered) as Record<string, unknown>;
  expect(digest).toMatchObject({
    kind: "result_digest",
    totalBytes: bytes(whole),
    path: expect.stringMatching(/^captures\/results\/.+\.json$/u),
    shape: {
      type: "object",
      fields: {
        output: {
          type: "object",
          fields: { items: { type: "array", length: 400 }, total: "number" },
        },
      },
    },
  });
  // The first items show as they are.
  expect(JSON.stringify(digest["preview"])).toContain(JSON.stringify(rows(1)[0]));

  // The file at that path holds the whole result.
  expect(digestPath).toBe(digest["path"]);
  expect(JSON.parse(file ?? "null")).toEqual(observations);
});

it("keeps a completed result's error output whole inside its digest", async () => {
  const stack = Array.from(
    { length: 80 },
    (_, line) => `    at frame${line} (src/tool.ts:${line}:1)`,
  )
    .join("\n")
    .padStart(4_000, "Error: synthetic failure\n");
  const observations = { output: rows(200), stdout: "", stderr: stack };
  const { delivered } = await runOnce(observations);
  const digest = JSON.parse(delivered) as { kind: string; errors: { text: string }[] };
  expect(digest.kind).toBe("result_digest");
  expect(digest.errors.map((entry) => entry.text)).toContain(stack);
});

it("returns a failed result within the threshold whole", async () => {
  const message = `Error: synthetic failure\n${"    at frame (src/tool.ts:1:1)\n".repeat(300)}`;
  const observations = { message, code: "OperationFailed" };
  expect(bytes(JSON.stringify(observations))).toBeGreaterThan(8 * 1024);
  expect(bytes(JSON.stringify(observations))).toBeLessThan(resultDigestThresholdBytes);
  const { delivered } = await runOnce(observations, "failed");
  expect(delivered).toBe(JSON.stringify(observations));
});

it("keeps a larger failed result's error message whole, after any other output", async () => {
  const message = `Error: synthetic failure\n${"    at frame (src/tool.ts:1:1)\n".repeat(300)}`;
  const observations = { partial: rows(200), message, code: "OperationFailed" };
  const { delivered, file } = await runOnce(observations, "failed");
  const digest = JSON.parse(delivered) as { kind: string; errors: { text: string }[] };
  expect(digest.kind).toBe("result_digest");
  expect(digest.errors.map((entry) => entry.text)).toContain(message);
  expect(JSON.parse(file ?? "null")).toEqual(observations);
});

it.each([
  { case: "a host that saves no results", saveResult: null },
  {
    case: "a save that fails",
    saveResult: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  },
])("returns a larger result whole for $case", async ({ saveResult }) => {
  const observations = { output: rows(200), stdout: "", stderr: "" };
  const { delivered, file } = await runOnce(observations, "completed", saveResult);
  expect(delivered).toBe(JSON.stringify(observations));
  expect(file).toBeUndefined();
});
