import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Usage } from "@openai/agents";
import type { ModelProvider, ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Either, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type LiveTestBatch,
  type LiveTestBatchResult,
  type LiveTestHost,
  type MintDependencies,
  MintHarnessSnapshot,
} from "../../src/mint/contracts.js";
import type { LiveTestOutcome } from "../../src/mint/live-tests.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import type { MintAgentSnapshot, MintRecoveryFactory } from "../../src/mint/recovery-contracts.js";
import { Deadline } from "../../src/runtime/deadline.js";
import type { FieldFill } from "../../src/runtime/output-lint.js";
import { validateAnswer } from "../../src/runtime/input-request.js";
import { makeMintContinuationFixture, readAllow } from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

// A read signed out designs its own live test cases, runs them as batches and reads every result;
// publication review gets the host's own record of them. These drive the minter's live_tests tool
// through scripted model turns.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);
const read = { effect: "read", siteOrigin: "https://shop.example.test" } as const;

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, input: object, callId = name): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ intent: `Synthetic ${name} purpose`, ...input }),
      status: "completed",
    },
  ],
});
const prose = (): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
});
/** The JSON a tool call returned, as the next model request carries it. */
const resultOf = (request: ModelRequest | undefined, callId: string): Record<string, unknown> => {
  const input = request?.input;
  if (!Array.isArray(input)) throw new Error("Missing history");
  const item = input.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  ) as { readonly output?: unknown } | undefined;
  const output = item?.output;
  const text =
    typeof output === "string"
      ? output
      : typeof output === "object" && output !== null && "text" in output
        ? String(output.text)
        : JSON.stringify(output);
  return JSON.parse(text) as Record<string, unknown>;
};

const example = {
  purpose: "example",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 60,
};
const finish = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "search_catalog", description: "Search a synthetic catalog" },
  coverage: "The example searched one query.",
};
const plan = { action: "plan", entrypoint: "src/tool.ts", cases: null, maxWorkers: null };
const runAll = { action: "run", entrypoint: "src/tool.ts", cases: null, maxWorkers: 3 };

/** A search tool's declared schemas, as the host reads them offline. */
const schemas = {
  input: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      sort: { enum: ["relevance", "price_low", "price_high"] },
      in_stock: { type: "boolean" },
      cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
  output: {
    type: "object",
    required: ["results", "has_next_page", "next_cursor"],
    properties: {
      results: { type: "array", items: { type: "object" } },
      has_next_page: { type: "boolean" },
      next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  },
};

const cases = {
  cases: [
    { id: "repeat-1", purpose: "The example on a fresh browser.", input: { query: "lamp" }, expect: "result" },
    {
      id: "sort-price",
      purpose: "Sorting by price reorders the results.",
      input: { query: "lamp", sort: "price_low" },
      expect: "result",
    },
    { id: "nothing", purpose: "A query with no results.", input: { query: "zzqx" }, expect: "empty" },
    {
      id: "page-2",
      purpose: "Page two through the cursor page one returned.",
      input: { query: "lamp" },
      expect: "result",
      next_page: true,
    },
  ],
  notTested: [{ what: "A sort the site does not offer", reason: "Every sort is offered." }],
};

/** A host that runs each case through `outcomes`, recording each batch it was asked to run. */
/** Each case's outcome, the same for every batch or by the batch's index. */
type Outcomes =
  | Readonly<Record<string, LiveTestOutcome>>
  | ((batch: number) => Readonly<Record<string, LiveTestOutcome>>);

const liveTestHost = (outcomes: Outcomes, result?: LiveTestBatchResult) => {
  const batches: LiveTestBatch[] = [];
  const host: LiveTestHost = {
    maxWorkers: 3,
    schemas: () => Effect.succeed(schemas),
    run: (batch) =>
      Effect.sync(() => {
        batches.push(batch);
        const now = typeof outcomes === "function" ? outcomes(batches.length - 1) : outcomes;
        return (
          result ?? {
            status: "ran" as const,
            reviewId: "review_batch",
            lanes: Math.min(batch.workers, batch.cases.length),
            cases: batch.cases.map((testCase, index) => ({
              id: testCase.id,
              outcome: now[testCase.id] ?? {
                status: "completed" as const,
                output: { results: [{ name: "Lamp" }], has_next_page: true, next_cursor: "c2" },
              },
              durationMs: 20_000,
              lane: index % batch.workers,
              // Each lane past the build's own browser opens new, so its first case runs cold.
              start: index > 0 && index < batch.workers ? ("cold" as const) : ("warm" as const),
            })),
          }
        );
      }),
  };
  return { host, batches };
};

const writeWorkspace = async (root: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};
const toolSource = "export default { name: 'search_catalog' };\n";

/** Publication requests and the host evidence each received. */
const publications = () => {
  const seen: { coverage: string; liveTests?: object; testedFields?: readonly FieldFill[] }[] = [];
  const publish: MintDependencies["publish"] = (request, _evidence, hostEvidence) =>
    Effect.sync(() => {
      seen.push({
        coverage: request.coverage,
        ...(hostEvidence?.liveTests === undefined ? {} : { liveTests: hostEvidence.liveTests }),
        ...(hostEvidence?.testedFields === undefined ? {} : { testedFields: hostEvidence.testedFields }),
      });
      return { publicationRef: "published_revision", diagnostics: [] };
    });
  return { seen, publish };
};

const completedExample: MintDependencies["reviewAndExecute"] = (_input, beforeDispatch) =>
  (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
    Effect.as({
      executionId: "execution_one",
      status: "completed" as const,
      effect: "verified" as const,
      resultRef: "protected_result",
      observations: { results: 3 },
    }),
  );

it("runs the cases a read designed as one batch and hands publication the host's record", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": {
      status: "failed",
      errorClass: "TimeoutError",
      message: "locator.click: Timeout 5000ms exceeded",
      frame: "src/tool.ts:12",
    },
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "test/cases.json": JSON.stringify(cases) });
      return (
        [
          call("live_tests", plan, "plan"),
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource });
  const outcome = await f.run();

  // Before any case exists, the plan lists none; the host builds no checklist from the schemas.
  const planned = resultOf(f.requests[1], "plan");
  expect(planned["cases"]).toEqual([]);

  // The first passing example's receipt reminds the agent of its cases.
  const receipt = resultOf(f.requests[2], "example");
  expect(receipt["testPlan"]).toMatchObject({ plannedCases: 4 });

  // One batch, every case, with the next page's cursor fields (the string cursor, never the
  // boolean beside it), at most three at once.
  expect(batches).toHaveLength(1);
  expect(batches[0]?.workers).toBe(3);
  expect(batches[0]?.cases.map((testCase) => testCase.id)).toEqual([
    "repeat-1",
    "sort-price",
    "nothing",
    "page-2",
  ]);
  expect(batches[0]?.cases.find((testCase) => testCase.id === "page-2")?.nextPage).toEqual({
    inputField: "cursor",
    outputField: "next_cursor",
  });

  // The agent sees every result, a failure with the line that threw.
  const ran = resultOf(f.requests[3], "run");
  expect(ran["status"]).toBe("ran");
  expect(ran["cases"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "repeat-1", purpose: "The example on a fresh browser.", status: "pass" }),
      expect.objectContaining({ id: "nothing", status: "pass", got: "empty" }),
      expect.objectContaining({
        id: "sort-price",
        status: "fail",
        errorClass: "TimeoutError",
        frame: "src/tool.ts:12",
      }),
    ]),
  );

  // A failing case never refuses publication by itself: the review reads the host's record.
  expect(outcome.build).toBe("published");
  expect(published.seen).toHaveLength(1);
  // The record lists each case with its purpose, input and verdict, and what was not tested.
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; input: unknown; results: Record<string, unknown> }[];
    notTested: unknown;
  };
  expect(record.cases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        purpose: "Sorting by price reorders the results.",
        input: { query: "lamp", sort: "price_low" },
        results: { playwright: expect.objectContaining({ status: "fail" }) },
      }),
    ]),
  );
  expect(record.notTested).toEqual(cases.notTested);
  // Each result says how its browser started, and each version counts the cases that passed cold.
  expect(
    record.cases.map((entry) => (entry.results["playwright"] as { start?: string }).start).sort(),
  ).toEqual(["cold", "cold", "warm", "warm"]);
  expect((published.seen[0]?.liveTests as { versions: unknown[] }).versions).toEqual([
    expect.objectContaining({ version: "playwright", coldPasses: 1 }),
  ]);
  expect(published.seen[0]?.coverage).toContain(
    "4 cases. Playwright version (src/tool.ts): 3 pass, 1 fail, 0 inconclusive; 1 passed cold.",
  );
});

it("marks results stale in the publication record when the source changed after they ran", async () => {
  const { host } = liveTestHost({});
  const published = publications();
  let root = "";
  const f = await fixture(
    async (_request, index) => {
      // The agent edits the source after the batch and publishes without running it again.
      if (index === 3) await writeWorkspace(root, { "src/tool.ts": `${toolSource}// edited\n` });
      return (
        [
          call("execute", example, "example"),
          call("live_tests", runAll, "run"),
          call("execute", example, "again"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      repeatableRead: true,
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  const record = published.seen[0]?.liveTests as { cases: { results: { playwright: { status: string } } }[] };
  expect(record.cases.map((testCase) => testCase.results.playwright.status)).toEqual([
    "stale",
    "stale",
    "stale",
    "stale",
  ]);
});

it("tells the agent when the host could not read the schemas its verdicts and next pages need", async () => {
  const { host, batches } = liveTestHost({});
  const unreadable: LiveTestHost = {
    ...host,
    schemas: () => Effect.fail(new MintFailure({ code: "Unavailable" })),
  };
  const f = await fixture(
    (_request, index) => [call("live_tests", runAll, "run")][index] ?? prose(),
    { liveTests: unreadable, deadline: Deadline.after(30 * 60_000) },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  const single = { cases: cases.cases.filter((testCase) => testCase.next_page !== true) };
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(single) });
  await f.run();
  expect(batches).toHaveLength(1);
  const ran = resultOf(f.requests[1], "run");
  expect(ran["status"]).toBe("ran");
  expect(ran).toHaveProperty("schemaProblem");
});

// Fails when the source digest follows the host runtime's relative import out of the workspace:
// the workspace refuses that path, so live_tests answered source_unreadable and ran nothing.
it.each(["../../runtime/index.js", "../../browser/index.js"])(
  "runs the batch for a tool that imports the host runtime as %s",
  async (sdk) => {
    const { host, batches } = liveTestHost({});
    const f = await fixture(
      (_request, index) =>
        [call("live_tests", { ...runAll, entrypoint: "src/tool.mjs" }, "run")][index] ?? prose(),
      { liveTests: host, deadline: Deadline.after(30 * 60_000) },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    const single = { cases: cases.cases.filter((testCase) => testCase.next_page !== true) };
    await writeWorkspace(root, {
      "src/tool.mjs": `import { defineOperation } from "${sdk}";\nexport default defineOperation;\n`,
      "test/cases.json": JSON.stringify(single),
    });
    await f.run();
    expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "ran" });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sourceDigest).toEqual(expect.any(String));
  },
);

// Fails when the digest swallows a read the workspace refused: the host never hears of it.
it("reports a source digest the host could not read, and runs nothing", async () => {
  const { host, batches } = liveTestHost({});
  const reported: { readonly error: unknown; readonly operation: string }[] = [];
  const f = await fixture(
    (_request, index) => [call("live_tests", runAll, "run")][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reporting: {
        failure: (error, details) =>
          Effect.sync(() => {
            reported.push({ error, operation: details.operation });
          }),
        bestEffort: (effect) => Effect.ignore(effect),
      },
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  // The workspace refuses a path with a space, so the import cannot be read.
  await writeWorkspace(root, {
    "src/tool.ts": `import helper from "./helper copy.mjs";\nexport default helper;\n`,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "source_unreadable" });
  expect(batches).toHaveLength(0);
  expect(reported).toEqual(
    expect.arrayContaining([
      { error: expect.any(MintFailure) as unknown, operation: "stepDigest" },
    ]),
  );
});

it("checks each case's output as it checks an example's, and the record keeps the findings", async () => {
  const markup = {
    status: "completed" as const,
    output: {
      results: [{ name: "Example &amp; Co <b>Lamp</b>" }],
      has_next_page: false,
      next_cursor: null,
    },
  };
  const { host } = liveTestHost({ "repeat-1": markup });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  // The agent reads the case's findings, a blocking one marked, with what it means and a sample.
  const ran = resultOf(f.requests[1], "run") as {
    cases: Record<string, unknown>[];
    outputChecksInstruction?: string;
  };
  const flagged = ran.cases.find((testCase) => testCase["id"] === "repeat-1");
  expect(flagged?.["outputChecks"]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "results[].name",
        check: "markup",
        blocking: true,
        meaning: expect.any(String),
        sample: expect.stringContaining("Lamp"),
      }),
    ]),
  );
  expect(ran.cases.find((testCase) => testCase["id"] === "sort-price")).not.toHaveProperty(
    "outputChecks",
  );
  expect(ran.outputChecksInstruction).toEqual(expect.any(String));

  // A finding on a case never refuses publication; the record keeps it compactly for the review.
  expect(published.seen).toHaveLength(1);
  const record = published.seen[0]?.liveTests as {
    cases: { id: string; results: { playwright: Record<string, unknown> } }[];
  };
  expect(
    record.cases.find((testCase) => testCase.id === "repeat-1")?.results.playwright["outputChecks"],
  ).toEqual([
    { path: "results[].name", check: "markup", count: 1, blocking: true },
  ]);
});

it("flags a field no case filled on each case, and gives publication every case's fields", async () => {
  const output = (results: readonly object[], storeNotice: string | null) => ({
    status: "completed" as const,
    output: { results, has_next_page: false, next_cursor: null, store_notice: storeNotice },
  });
  const { host } = liveTestHost({
    "repeat-1": output([{ name: "Lamp", note: null }, { name: "Desk lamp", note: null }], null),
    "sort-price": output([{ name: "Floor lamp", note: null }], "Prices for the chosen store"),
  });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  const record = published.seen[0]?.liveTests as {
    cases: { id: string; results: { playwright: { outputChecks?: { path: string; check: string }[] } } }[];
  };
  const checksOf = (id: string) =>
    (record.cases.find((testCase) => testCase.id === id)?.results.playwright.outputChecks ?? []).map(
      ({ path, check }) => `${path} ${check}`,
    );
  // Three records across the cases, none with a note; the store notice one case filled.
  expect(checksOf("repeat-1")).toEqual(["results[].note empty_field"]);
  expect(checksOf("sort-price")).toEqual(["results[].note empty_field"]);
  // Publication gets each case's fields as paths and counts, never a value.
  const tested = published.seen[0]?.testedFields ?? [];
  expect(tested).toHaveLength(cases.cases.length);
  expect(tested).toContainEqual(expect.objectContaining({ store_notice: { records: 1, filled: 1 } }));
  expect(JSON.stringify(tested)).not.toContain("Prices for");
});

it("keeps a failing case in the publication record after the minter deletes or changes it", async () => {
  const { host, batches } = liveTestHost({
    "sort-price": { status: "failed", errorClass: "TimeoutError", frame: "src/tool.ts:12" },
  });
  const published = publications();
  let root = "";
  // Without the failing sort case, and with the failing no-results case on another query.
  const trimmed = {
    ...cases,
    cases: cases.cases
      .filter((testCase) => testCase.id !== "sort-price")
      .map((testCase) =>
        testCase.id === "nothing" ? { ...testCase, input: { query: "zzqy" } } : testCase,
      ),
  };
  const f = await fixture(
    async (_request, index) => {
      if (index === 1) await writeWorkspace(root, { "test/cases.json": JSON.stringify(trimmed) });
      return (
        [
          call("live_tests", runAll, "first"),
          call("live_tests", runAll, "second"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(2);
  const record = published.seen[0]?.liveTests as {
    cases: { id: string }[];
    retired: Record<string, unknown>[];
  };
  expect(record.cases.map((testCase) => testCase.id)).not.toContain("sort-price");
  expect(record.retired).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "sort-price",
        retiredBecause: "deleted from the cases file",
        lastVerdict: "fail",
        frame: "src/tool.ts:12",
        input: { query: "lamp", sort: "price_low" },
        onPublishedSource: true,
      }),
      expect.objectContaining({
        id: "nothing",
        retiredBecause: "changed after it failed",
        lastVerdict: "fail",
        input: { query: "zzqx" },
      }),
    ]),
  );
  expect(published.seen[0]?.coverage).toContain("2 retired cases (2 last failed)");
});

/** Runs `turns` of live_tests batches, editing the workspace before each, then publishes. */
const batchesThenPublish = async (
  outcomes: Outcomes,
  edits: readonly Readonly<Record<string, string>>[],
) => {
  const { host, batches } = liveTestHost(outcomes);
  const published = publications();
  let root = "";
  const runs = edits.map((_edit, index) => call("live_tests", runAll, `run_${index}`));
  const f = await fixture(
    async (_request, index) => {
      const edit = edits[index];
      if (edit !== undefined) await writeWorkspace(root, edit);
      return (
        [...runs, call("execute", example, "example"), call("finish_build", finish, "finish")][
          index
        ] ?? prose()
      );
    },
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  root = (f.workspace as unknown as { root: string }).root;
  await f.run();
  expect(batches).toHaveLength(edits.length);
  return published.seen[0]?.liveTests as { retired: Record<string, unknown>[] };
};
const otherStore = (expectation: string) =>
  JSON.stringify({
    cases: [
      {
        id: "other-store",
        purpose: "A second store the store picker lists.",
        input: { query: "lamp", store: "Mill Street" },
        expect: expectation,
      },
    ],
  });
const emptyList = {
  status: "completed" as const,
  output: { results: [], has_next_page: false, next_cursor: null },
};

// The review excuses a relabeled failure only when the captures show the site giving the new
// answer for that input, so the host names the passing case for it and excuses nothing itself.
it("never excuses a failure by a case that changed its expectation, and names that case for the review", async () => {
  // The second store's results come back empty; the agent relabels the case to expect that.
  const record = await batchesThenPublish({ "other-store": emptyList }, [
    { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
    { "test/cases.json": otherStore("empty") },
  ]);
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      lastVerdict: "fail",
      expect: "result",
      changedExpectationBy: "other-store",
    }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("excusedBy");
});

it("names no case for a changed expectation that does not pass", async () => {
  const record = await batchesThenPublish({ "other-store": emptyList }, [
    { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
    { "test/cases.json": otherStore("invalid_input") },
  ]);
  expect(record.retired).toEqual([
    expect.objectContaining({ id: "other-store", lastVerdict: "fail", expect: "result" }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("changedExpectationBy");
});

it("excuses a failure only by a case passing its input and expectation after the code changed", async () => {
  const record = await batchesThenPublish(
    (batch) => (batch === 0 ? { "other-store": emptyList } : {}),
    [
      { "src/tool.ts": toolSource, "test/cases.json": otherStore("result") },
      {
        "src/tool.ts": `${toolSource}// fixed\n`,
        "test/cases.json": otherStore("result").replace('"other-store"', '"second-store"'),
      },
    ],
  );
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      retiredBecause: "deleted from the cases file",
      excusedBy: "second-store",
    }),
  ]);
});

it("keeps a failure that passed when run again on the same code as flaky", async () => {
  const record = await batchesThenPublish(
    (batch) => (batch === 0 ? { "other-store": emptyList } : {}),
    [{ "src/tool.ts": toolSource, "test/cases.json": otherStore("result") }, {}],
  );
  expect(record.retired).toEqual([
    expect.objectContaining({
      id: "other-store",
      lastVerdict: "fail",
      flaky: true,
      onPublishedSource: true,
    }),
  ]);
  expect(record.retired[0]).not.toHaveProperty("excusedBy");
});

it("publishes with the gaps when too little time is left for a batch, and the record says so", async () => {
  const { host, batches } = liveTestHost({});
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      // Less than the batch's margin before the attempt's end.
      deadline: Deadline.after(2 * 60_000 + 30_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(0);
  expect(resultOf(f.requests[1], "run")).toMatchObject({ status: "no_time" });
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toMatchObject({ outOfTime: true });
  expect(published.seen[0]?.coverage).toContain("ran out of time");
});

// A host whose cases may each run longer than the default gets no batch it cannot fit one case in:
// such a batch would only end every case inconclusive for the deadline.
it("refuses a batch as no_time when less than the host's case limit is left, and runs one that fits", async () => {
  const attempt = async (batchMs: number) => {
    const { host, batches } = liveTestHost({});
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose(),
      {
        liveTests: { ...host, caseTimeoutMs: 120_000 },
        // The attempt keeps two minutes after the batch; `batchMs` is what the batch may use.
        deadline: Deadline.after(2 * 60_000 + batchMs),
        reviewAndExecute: completedExample,
        publish: publications().publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
    await f.run();
    return { batches: batches.length, status: resultOf(f.requests[1], "run")["status"] };
  };
  expect(await attempt(90_000)).toEqual({ batches: 0, status: "no_time" });
  expect(await attempt(150_000)).toEqual({ batches: 1, status: "ran" });
});

it("says time ran out only when the attempt's end, not the batch's own cap, stopped a case", async () => {
  const stopped = { status: "inconclusive" as const, reason: "deadline" as const };
  const record = async (attemptMs: number) => {
    const { host, batches } = liveTestHost({ "sort-price": stopped });
    const published = publications();
    const f = await fixture(
      (_request, index) =>
        [
          call("live_tests", runAll, "run"),
          call("execute", example, "example"),
          call("finish_build", finish, "finish"),
        ][index] ?? prose(),
      {
        liveTests: host,
        deadline: Deadline.after(attemptMs),
        reviewAndExecute: completedExample,
        publish: published.publish,
      },
      read,
    );
    const root = (f.workspace as unknown as { root: string }).root;
    await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
    await f.run();
    expect(batches).toHaveLength(1);
    return published.seen[0]?.liveTests as { outOfTime?: boolean };
  };
  // Half an hour left: the batch's own ten-minute cap stopped the case, so testing can go on.
  expect((await record(30 * 60_000)).outOfTime).toBeUndefined();
  // Five minutes left: the attempt's end set the batch's deadline.
  expect((await record(5 * 60_000)).outOfTime).toBe(true);
});

it("never counts a case the site blocked on the browser's egress against the tool", async () => {
  const { host, batches } = liveTestHost({ "sort-price": { status: "inconclusive", reason: "site_block" } });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();

  expect(batches).toHaveLength(1);
  const blocked = (resultOf(f.requests[1], "run")["cases"] as { id: string }[]).find(
    (testCase) => testCase.id === "sort-price",
  );
  expect(blocked).toMatchObject({ status: "inconclusive", got: "site_block" });
  expect(published.seen[0]?.coverage).toContain("2 pass, 1 fail, 1 inconclusive;");
});

it("runs nothing when Guardian denies the batch, and says why", async () => {
  const { host, batches } = liveTestHost(
    {},
    {
      status: "review_denied",
      reviewId: "review_denied_batch",
      rationale: "Case repeat-1 guesses an order number.",
    },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, { "src/tool.ts": toolSource, "test/cases.json": JSON.stringify(cases) });
  await f.run();
  expect(batches).toHaveLength(1);
  expect(resultOf(f.requests[1], "run")).toMatchObject({
    status: "review_denied",
    rationale: "Case repeat-1 guesses an order number.",
  });
  const record = published.seen[0]?.liveTests as { cases: { results: { playwright: { status: string } } }[] };
  expect(record.cases.every((testCase) => testCase.results.playwright.status === "not_run")).toBe(true);
});

it("runs no live tests for a signed-in read, which its example alone proves", async () => {
  const { host, batches } = liveTestHost({});
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call(
          "execute",
          { ...example, purpose: "authenticate", entrypoint: "src/sign-in.ts" },
          "sign_in",
        ),
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: (input, beforeDispatch) =>
        input.purpose === "authenticate"
          ? (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
              Effect.as({
                executionId: "sign_in_one",
                status: "completed" as const,
                effect: "verified" as const,
                authentication: { state: "authenticated" as const, effect: "verified" as const },
                observations: {},
              }),
            )
          : completedExample(input, beforeDispatch),
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(batches).toHaveLength(0);
  expect(resultOf(f.requests[2], "run")).toMatchObject({ status: "unavailable" });
  expect(published.seen[0]?.liveTests).toBeUndefined();
});

const httpSource = "export default { name: 'search_catalog_http' };\n";
const runHttp = { action: "run", entrypoint: "src/tool-http.mjs", cases: null, maxWorkers: 3 };
const planOf = (entrypoint: string) => ({ action: "plan", entrypoint, cases: null, maxWorkers: null });
const statuses = (result: Record<string, unknown>) =>
  Object.fromEntries(
    (result["cases"] as { id: string; status: string }[]).map((testCase) => [testCase.id, testCase.status]),
  );

// A read signed out runs the same cases as a batch on both versions. Each version keeps its own
// results: a batch on the HTTP version neither replaces nor stales the Playwright version's.
it("runs the cases as a batch on each version, and each version keeps its own results", async () => {
  const { host, batches } = liveTestHost((batch) =>
    batch === 0
      ? {
          "sort-price": { status: "failed", errorClass: "TimeoutError", message: "Timed out" },
          nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
        }
      : {
          nothing: {
            status: "failed",
            errorClass: "OperationFailure",
            message: "Unexpected status 500",
            frame: "src/tool-http.mjs:9",
          },
        },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();

  expect(batches.map((batch) => batch.entrypoint)).toEqual(["src/tool.ts", "src/tool-http.mjs"]);
  const both = { "repeat-1": "pass", "page-2": "pass" };
  expect(statuses(resultOf(f.requests[3], "run_http"))).toEqual({
    ...both,
    "sort-price": "pass",
    nothing: "fail",
  });
  // After the HTTP batch, the Playwright version's results stand as they ran.
  expect(statuses(resultOf(f.requests[4], "plan_playwright"))).toEqual({
    ...both,
    "sort-price": "fail",
    nothing: "pass",
  });

  // The record shows each case's result on each version, against that version's own source.
  const record = published.seen[0]?.liveTests as {
    versions: { version: string; entrypoint: string }[];
    cases: { id: string; results: Record<string, { status: string }> }[];
  };
  expect(record.versions.map(({ version, entrypoint }) => [version, entrypoint])).toEqual([
    ["playwright", "src/tool.ts"],
    ["http", "src/tool-http.mjs"],
  ]);
  const byCase = Object.fromEntries(
    record.cases.map((testCase) => [
      testCase.id,
      [testCase.results["playwright"]?.status, testCase.results["http"]?.status],
    ]),
  );
  expect(byCase).toEqual({
    "repeat-1": ["pass", "pass"],
    "sort-price": ["fail", "pass"],
    nothing: ["pass", "fail"],
    "page-2": ["pass", "pass"],
  });
  expect(published.seen[0]?.coverage).toContain(
    "HTTP version (src/tool-http.mjs): 3 pass, 1 fail, 0 inconclusive; 1 passed cold.",
  );
});

/** A scripted minter that checkpoints before each model call, as a host's recovery store does. */
const checkpointingMinter = (respondTo: (index: number) => ModelResponse) => {
  const requests: ModelRequest[] = [];
  const recoveryFactory: MintRecoveryFactory = (store) =>
    Effect.succeed({
      model: (state, counters, invoke) =>
        store
          .save({ version: 1, sdkVersion: "0.18.0", sdkState: state(), ...counters, tools: [] })
          .pipe(Effect.zipRight(invoke)),
      tool: (_call, invoke) => invoke,
    });
  const provider: ModelProvider = {
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return respondTo(requests.length - 1);
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  };
  return { requests, model: makeOpenAIMinter(provider, "medium", {}, { recoveryFactory }) };
};

// A checkpoint from an older release keeps results without an entrypoint: a worker that takes
// it over restores them as the Playwright version's, and the HTTP version has run nothing yet.
it("restores an older checkpoint's results as the Playwright version's", async () => {
  const { host } = liveTestHost({
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const files = {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  };
  const before = checkpointingMinter(
    (index) =>
      [call("execute", example, "example"), call("live_tests", runAll, "run")][index] ?? prose(),
  );
  const first = await fixture(() => prose(), {
    model: before.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: {
      save: (agent, harness) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  }, read);
  await writeWorkspace((first.workspace as unknown as { root: string }).root, files);
  await first.run().catch(() => undefined);
  const saved = checkpoints.find((checkpoint) => (checkpoint.harness.liveTests ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with live test results");
  // What an older release wrote: the same results, with no entrypoint.
  const older = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(
      JSON.stringify({
        ...saved.harness,
        liveTests: saved.harness.liveTests?.map(({ entrypoint: _entrypoint, ...record }) => record),
      }),
    ),
  );
  expect(older.liveTests?.some((record) => record.entrypoint !== undefined)).toBe(false);

  const published = publications();
  const after = checkpointingMinter(
    (index) =>
      [
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("live_tests", planOf("src/tool-http.mjs"), "plan_http"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
  );
  const second = await fixture(() => prose(), {
    model: after.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    publish: published.publish,
    agentRecovery: { initial: { agent: saved.agent, harness: older }, save: () => Effect.void },
  }, read);
  await writeWorkspace((second.workspace as unknown as { root: string }).root, files);
  await second.run();
  const pass = { "repeat-1": "pass", "sort-price": "pass", nothing: "pass", "page-2": "pass" };
  expect(statuses(resultOf(after.requests[1], "plan_playwright"))).toEqual(pass);
  expect(statuses(resultOf(after.requests[2], "plan_http"))).toEqual(
    Object.fromEntries(Object.keys(pass).map((id) => [id, "not_run"])),
  );
  const record = published.seen[0]?.liveTests as {
    cases: { results: Record<string, { status: string }> }[];
  };
  expect(record.cases.map((testCase) => testCase.results["playwright"]?.status)).toEqual(
    Object.values(pass),
  );
  expect(record.cases.every((testCase) => testCase.results["http"]?.status === "not_run")).toBe(true);
});

const signInStep = { ...example, purpose: "authenticate", entrypoint: "src/sign-in.ts" };
const signingIn: MintDependencies["reviewAndExecute"] = (input, beforeDispatch) =>
  input.purpose === "authenticate"
    ? (beforeDispatch?.(readAllow) ?? Effect.void).pipe(
        Effect.as({
          executionId: "sign_in_one",
          status: "completed" as const,
          effect: "verified" as const,
          authentication: { state: "authenticated" as const, effect: "verified" as const },
          observations: {},
        }),
      )
    : completedExample(input, beforeDispatch);

// Testing scope follows what the tool is now. A repair of a read that starts signed out runs its
// cases; once it signs in, it is a signed-in read: live tests are refused from then on, and its
// publication carries no test record, so the review judges its one run.
// The harness already gated live tests on a sign-in before this scope change, so this pins that
// behavior for a repair rather than failing first; the site-change case below fails first.
it("drops a repair that signs in mid-build to the one-run rule", async () => {
  const { host, batches } = liveTestHost({
    nothing: { status: "completed", output: { results: [], has_next_page: false, next_cursor: null } },
  });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("live_tests", runAll, "before_sign_in"),
        call("execute", signInStep, "sign_in"),
        call("live_tests", runAll, "after_sign_in"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
    },
    { ...read, mode: "maintenance", observations: { failure: "The results list did not load." } },
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(resultOf(f.requests[1], "before_sign_in")).toMatchObject({ status: "ran" });
  expect(resultOf(f.requests[3], "after_sign_in")).toMatchObject({ status: "unavailable" });
  expect(batches).toHaveLength(1);
  expect(published.seen).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toBeUndefined();
  expect(published.seen[0]?.coverage).not.toContain("Host live tests");
});

const emptyResults = {
  status: "completed" as const,
  output: { results: [], has_next_page: false, next_cursor: null },
};
const httpFailure = {
  status: "failed" as const,
  errorClass: "OperationFailure",
  message: "Unexpected status 403",
  frame: "src/tool-http.mjs:9",
};

// An HTTP version ruled out at finish_build does not ship, so its failing batch results are
// neither recorded nor judged: the publication record lists the Playwright version alone.
it("leaves a ruled-out HTTP version's results out of the publication record", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0
      ? { nothing: emptyResults }
      : { "repeat-1": httpFailure, "sort-price": httpFailure, nothing: httpFailure, "page-2": httpFailure },
  );
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
        call(
          "finish_build",
          {
            ...finish,
            httpVersion: {
              outcome: "ruled_out",
              signal: "bot_wall_on_page_fetch",
              note: "Every request to the results route returned a challenge page.",
            },
          },
          "finish",
        ),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: completedExample,
      publish: published.publish,
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  });
  const outcome = await f.run();
  expect(outcome.build).toBe("published");
  const record = published.seen[0]?.liveTests as {
    versions: { version: string }[];
    cases: { results: Record<string, { status: string }> }[];
    retired: unknown[];
  };
  expect(record.versions.map((entry) => entry.version)).toEqual(["playwright"]);
  expect(record.cases.every((testCase) => Object.keys(testCase.results).join() === "playwright")).toBe(
    true,
  );
  expect(record.cases.every((testCase) => testCase.results["playwright"]?.status === "pass")).toBe(true);
  expect(published.seen[0]?.coverage).not.toContain("HTTP version");
});

// A sign-in counts only on the site it happened on: after an update moves the build to another
// site, the read has not signed in there, so it is a read signed out and runs its live tests.
it("runs live tests after an update moves a signed-in read to a site it has not signed in to", async () => {
  const sister = "https://shop.example.org";
  const { host, batches } = liveTestHost({ nothing: emptyResults });
  const published = publications();
  const f = await fixture(
    (_request, index) =>
      [
        call("execute", signInStep, "sign_in"),
        call(
          "request_input",
          {
            questions: [
              {
                id: "site",
                type: "choice",
                prompt: `The catalog lives on ${sister}. Build the tool there?`,
                options: [
                  { id: "move", label: `Yes, use ${sister}` },
                  { id: "stay", label: "No, stay here" },
                ],
              },
            ],
          },
          "ask",
        ),
        call(
          "mint_update",
          {
            summary: `Build the tool on ${sister}, where the catalog lives.`,
            changes: [{ setting: "site", origin: sister }],
            confirmedBy: ["site"],
            recommend: "update",
          },
          "update",
        ),
        call("live_tests", runAll, "run"),
        call("execute", example, "example"),
        call("finish_build", finish, "finish"),
      ][index] ?? prose(),
    {
      liveTests: host,
      deadline: Deadline.after(30 * 60_000),
      reviewAndExecute: signingIn,
      publish: published.publish,
      askInput: (submitted) =>
        Effect.sync(() =>
          Either.getOrThrow(
            validateAnswer(
              { ...submitted, id: "5b3f0e2a-6c1d-4f7e-9a8b-0c2d4e6f8a1b", source: "agent" },
              { site: "move" },
            ),
          ),
        ),
      reviewTaskUpdate: () =>
        Effect.succeed({ outcome: "allow" as const, rationale: "Scripted review.", reviewId: "review_update" }),
      applyTaskUpdate: () => Effect.succeed({ outcome: "applied" as const }),
    },
    read,
  );
  const root = (f.workspace as unknown as { root: string }).root;
  await writeWorkspace(root, {
    "src/tool.ts": toolSource,
    "src/sign-in.ts": toolSource,
    "test/cases.json": JSON.stringify(cases),
  });
  await f.run();
  expect(resultOf(f.requests[3], "update")).toMatchObject({ status: "updated" });
  expect(resultOf(f.requests[4], "run")).toMatchObject({ status: "ran" });
  expect(batches).toHaveLength(1);
  expect(published.seen[0]?.liveTests).toBeDefined();
});

// A checkpoint keeps the HTTP version's results in a field of their own. A worker from an older
// release drops that field and the entrypoints when it saves again, so the next new worker
// restores only the Playwright version's results, never the HTTP version's in their place.
it("never restores the HTTP version's results as the Playwright version's after an older worker", async () => {
  const { host } = liveTestHost((batch) =>
    batch === 0 ? { nothing: emptyResults } : { nothing: httpFailure, "sort-price": emptyResults },
  );
  const checkpoints: { agent: MintAgentSnapshot; harness: MintHarnessSnapshot }[] = [];
  const files = {
    "src/tool.ts": toolSource,
    "src/tool-http.mjs": httpSource,
    "test/cases.json": JSON.stringify(cases),
  };
  const before = checkpointingMinter(
    (index) =>
      [
        call("execute", example, "example"),
        call("live_tests", runAll, "run_playwright"),
        call("live_tests", runHttp, "run_http"),
      ][index] ?? prose(),
  );
  const first = await fixture(() => prose(), {
    model: before.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: {
      save: (agent, harness) =>
        Effect.sync(() => {
          checkpoints.push({ agent, harness });
        }),
    },
  }, read);
  await writeWorkspace((first.workspace as unknown as { root: string }).root, files);
  await first.run().catch(() => undefined);
  const saved = checkpoints.find((checkpoint) => (checkpoint.harness.liveTestsHttp ?? []).length > 0);
  if (saved === undefined) throw new Error("No checkpoint with both versions' results");
  // The Playwright field holds the Playwright version's results alone.
  expect(saved.harness.liveTests?.map((record) => record.entrypoint)).toEqual(
    Array.from({ length: 4 }, () => "src/tool.ts"),
  );
  // What an older worker saves again: no HTTP field, and no entrypoints.
  const { liveTestsHttp: _http, ...kept } = saved.harness;
  const resaved = Schema.decodeUnknownSync(MintHarnessSnapshot)(
    JSON.parse(
      JSON.stringify({
        ...kept,
        liveTests: kept.liveTests?.map(({ entrypoint: _entrypoint, ...record }) => record),
      }),
    ),
  );

  const after = checkpointingMinter(
    (index) =>
      [
        call("live_tests", planOf("src/tool.ts"), "plan_playwright"),
        call("live_tests", planOf("src/tool-http.mjs"), "plan_http"),
      ][index] ?? prose(),
  );
  const second = await fixture(() => prose(), {
    model: after.model,
    liveTests: host,
    deadline: Deadline.after(30 * 60_000),
    reviewAndExecute: completedExample,
    agentRecovery: { initial: { agent: saved.agent, harness: resaved }, save: () => Effect.void },
  }, read);
  await writeWorkspace((second.workspace as unknown as { root: string }).root, files);
  await second.run().catch(() => undefined);
  const ids = ["repeat-1", "sort-price", "nothing", "page-2"];
  expect(statuses(resultOf(after.requests[1], "plan_playwright"))).toEqual(
    Object.fromEntries(ids.map((id) => [id, "pass"])),
  );
  expect(statuses(resultOf(after.requests[2], "plan_http"))).toEqual(
    Object.fromEntries(ids.map((id) => [id, "not_run"])),
  );
});
