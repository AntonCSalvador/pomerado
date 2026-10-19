import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MintFailure } from "../../src/mint/contracts.js";
import {
  exampleInputFeedback,
  exampleOutputEvidence,
  exampleOutputRecord,
  missingRequestedNames,
  outputDigest,
  outputDigestNote,
  outputDigestPath,
  publicationEvidenceNote,
  publicationScope,
  publicDefinition,
  requestedOutputFields,
  reviewPublication,
  sessionEvidenceFiles,
  unlistedExampleInputKeys,
  type PublicationCandidate,
  type PublicationReview,
} from "../../src/mint/publication-review.js";

const limit = 96 * 1024;
const Envelope = Schema.parseJson(
  Schema.Struct({
    kind: Schema.Literal("verified_example_output", "write_session_output"),
    executionId: Schema.String,
    executedEntrypoint: Schema.String,
    executedSourceDigest: Schema.optional(Schema.String),
    state: Schema.String,
    reason: Schema.optional(Schema.String),
    screenedBytes: Schema.optional(Schema.Int),
    truncation: Schema.optional(
      Schema.Struct({ list: Schema.String, kept: Schema.Int, records: Schema.Int }),
    ),
    output: Schema.optional(Schema.Unknown),
  }),
);
/** A truncated record's output: a prefix of the screened output's text. */
const prefixOf = (envelope: { readonly output?: unknown }) =>
  typeof envelope.output === "string" ? envelope.output : "missing";
/** A fake host's credential precheck: a record passes unless it holds one of `secrets`. */
const precheck =
  (...secrets: string[]) =>
  (text: string) =>
    Effect.succeed(!secrets.some((secret) => text.includes(secret)));
const source = {
  executionId: "execution_a",
  executedEntrypoint: "executed/src/tool.mjs",
  executedSourceDigest: "digest_a",
};
/** A small record of short fields, which indenting makes about twice as long. */
const smallRecord = (index: number) => ({
  id: index,
  name: `Item ${index}`,
  price: 9.99,
  inStock: true,
  rating: 4.5,
  reviews: 120,
  sale: false,
  qty: 3,
});
const evidenceFor = async (value: unknown, credentialFree = precheck("private-canary")) => {
  const { state, text } = await Effect.runPromise(
    exampleOutputEvidence(
      source,
      value === undefined ? undefined : JSON.stringify(value),
      credentialFree,
    ),
  );
  const envelope = Schema.decodeUnknownSync(Envelope)(text);
  expect(envelope.state).toBe(state);
  return { text, envelope };
};

describe("the example's output evidence", () => {
  it("binds the output to the execution and the source that ran it", async () => {
    const { text, envelope } = await evidenceFor({ heading: "Public" });
    expect(envelope).toEqual({
      kind: "verified_example_output",
      ...source,
      state: "available",
      screenedBytes: Buffer.byteLength('{"heading":"Public"}'),
      output: { heading: "Public" },
    });
    // The record is compact JSON with its fields in this order.
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "kind",
      "executionId",
      "executedEntrypoint",
      "executedSourceDigest",
      "state",
      "screenedBytes",
      "output",
    ]);
    expect(text.startsWith('{"kind":"verified_example_output","executionId":')).toBe(true);
    expect(text).not.toContain("\n");
  });

  it("names a write session's step instead of a source digest", async () => {
    const { text } = await Effect.runPromise(
      exampleOutputEvidence(
        {
          kind: "write_session_output",
          executionId: "execution_b",
          executedEntrypoint: "publication/session/1/src/save.mjs",
        },
        '{"saved":true}',
        precheck(),
      ),
    );
    expect(JSON.parse(text)).toEqual({
      kind: "write_session_output",
      executionId: "execution_b",
      executedEntrypoint: "publication/session/1/src/save.mjs",
      state: "available",
      screenedBytes: 14,
      output: { saved: true },
    });
  });

  it("embeds a bare string result as its JSON value, not a JSON string inside JSON", async () => {
    const { text, envelope } = await evidenceFor("plain result");
    expect(envelope.output).toBe("plain result");
    expect(text).not.toContain(String.raw`\"plain result\"`);
  });

  it("returns the whole screened output, parsed, beside the record", async () => {
    const value = { rows: Array.from({ length: 20_000 }, (_, index) => `row ${index}`) };
    const evidence = await Effect.runPromise(
      exampleOutputEvidence(source, JSON.stringify(value), precheck()),
    );
    expect(evidence.state).toBe("truncated");
    expect(evidence.screened).toEqual(value);
  });

  it("cuts a large list of records to its first whole records", async () => {
    const records = Array.from({ length: 4000 }, (_, index) => ({
      id: index,
      title: `Result ${index} ${"x".repeat(40)}`,
    }));
    const { text, envelope } = await evidenceFor({ total: 4000, results: records });
    expect(envelope.state).toBe("truncated");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    const kept = envelope.truncation?.kept ?? 0;
    expect(envelope.truncation).toEqual({ list: "results", kept, records: 4000 });
    expect(kept).toBeGreaterThan(100);
    expect(envelope.output).toEqual({ total: 4000, results: records.slice(0, kept) });
  });

  it("keeps every record of an output that fits in 96 KiB as compact JSON", async () => {
    const records = Array.from({ length: 600 }, (_, index) => smallRecord(index));
    const value = { total: 600, results: records };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(limit - 1024);
    expect(Buffer.byteLength(JSON.stringify(value, null, 2))).toBeGreaterThan(limit);
    const { text, envelope } = await evidenceFor(value);
    expect(envelope.state).toBe("available");
    expect(envelope.truncation).toBeUndefined();
    expect(envelope.output).toEqual(value);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
  });

  it("cuts an output past 96 KiB as compact JSON, and its digest covers every record", async () => {
    const records = Array.from({ length: 1500 }, (_, index) => smallRecord(index));
    const value = { total: 1500, results: records };
    const evidence = await Effect.runPromise(
      exampleOutputEvidence(source, JSON.stringify(value), precheck()),
    );
    const envelope = Schema.decodeUnknownSync(Envelope)(evidence.text);
    expect(envelope.state).toBe("truncated");
    expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(limit);
    const kept = envelope.truncation?.kept ?? 0;
    expect(envelope.truncation).toEqual({ list: "results", kept, records: 1500 });
    expect(envelope.output).toEqual({ total: 1500, results: records.slice(0, kept) });
    // The kept records fill the limit as compact JSON.
    expect(Buffer.byteLength(JSON.stringify(records.slice(0, kept)))).toBeGreaterThan(limit * 0.95);
    const digest = JSON.parse(outputDigest(evidence.screened) ?? "{}") as {
      readonly lists: readonly { readonly path: string; readonly records: number }[];
    };
    expect(digest.lists).toContainEqual(expect.objectContaining({ path: "results", records: 1500 }));
  });

  it("writes the record of an output the host could not read", () => {
    expect(JSON.parse(exampleOutputRecord(source, "unavailable", { reason: "result_read" }).text)).toEqual({
      kind: "verified_example_output",
      ...source,
      state: "unavailable",
      reason: "result_read",
    });
  });

  it("marks an output the host kept none of as not_retained, without output", async () => {
    const { envelope } = await evidenceFor(undefined);
    expect(envelope).toMatchObject({ state: "not_retained" });
    expect(envelope.output).toBeUndefined();
  });

  it("bounds the serialized envelope and keeps a prefix of the screened output", async () => {
    const value = { rows: Array.from({ length: 20_000 }, (_, index) => `row "${index}"\n`) };
    const { text, envelope } = await evidenceFor(value);
    const full = JSON.stringify(value);
    expect(envelope.state).toBe("truncated");
    expect(envelope.screenedBytes).toBe(Buffer.byteLength(full));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(full.startsWith(prefixOf(envelope))).toBe(true);
    expect(prefixOf(envelope).length).toBeGreaterThan(limit / 4);
  });

  it.each(["é", "😀"])("truncates on a code point boundary: %s", async (character) => {
    const value = character.repeat(60_000);
    const { text, envelope } = await evidenceFor(value);
    expect(envelope.state).toBe("truncated");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(prefixOf(envelope)).not.toContain("�");
    expect(JSON.stringify(value).startsWith(prefixOf(envelope))).toBe(true);
    expect(Buffer.from(prefixOf(envelope)).toString()).toBe(envelope.output);
  });

  it("withholds an output whose URL carries a secret the truncation point would split", async () => {
    const secret = `tok-${"q7".repeat(6000)}`;
    const value = {
      filler: "a".repeat(limit - 4096),
      link: `https://shop.example.com/account?session=${secret}`,
    };
    const { envelope } = await evidenceFor(value, precheck(secret));
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
    expect(envelope.output).toBeUndefined();
  });

  it("withholds an untruncated output that fails the credential precheck", async () => {
    const { text, envelope } = await evidenceFor(
      { link: "https://shop.example.com/?session=tok-short-canary-91" },
      precheck("tok-short-canary-91"),
    );
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
    expect(text).not.toContain("tok-short-canary-91");
  });

  it("checks a cut record again before it keeps it", async () => {
    const checked: string[] = [];
    const { envelope } = await evidenceFor({ rows: "r".repeat(limit) }, (text) =>
      Effect.sync(() => {
        checked.push(JSON.parse(text).state as string);
        return checked.length === 1;
      }),
    );
    expect(checked).toEqual(["available", "truncated"]);
    expect(envelope).toMatchObject({ state: "withheld", reason: "credential_precheck" });
  });
});

describe("the example output's digest", () => {
  it("digests a nested list across every parent record, not only the first", () => {
    const Digest = Schema.parseJson(
      Schema.Struct({
        lists: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            records: Schema.Number,
            parents: Schema.optional(Schema.Number),
            fields: Schema.Record({
              key: Schema.String,
              value: Schema.Struct({ withValue: Schema.Number }),
            }),
          }),
        ),
      }),
    );
    const digest = Schema.decodeUnknownSync(Digest, { onExcessProperty: "ignore" })(
      outputDigest({
        results: [
          {
            id: "a",
            offers: [
              { seller: "one", price: 1 },
              { seller: "two", price: 2 },
            ],
          },
          {
            id: "b",
            offers: [
              { seller: "three", price: 3 },
              { seller: null, price: 4 },
              { seller: "five", price: 5 },
            ],
          },
          { id: "c" },
        ],
      }),
    );
    const offers = digest.lists.find((list) => list.path === "results[].offers");
    expect(offers).toMatchObject({ records: 5, parents: 2 });
    expect(offers?.fields.seller?.withValue).toBe(4);
    expect(offers?.fields.price?.withValue).toBe(5);
  });

  it("has none for an output without a list of records", () => {
    expect(outputDigest({ heading: "Public", tags: ["a", "b"] })).toBeUndefined();
  });

  it("tells the review where the digest is and what it covers", () => {
    expect(outputDigestNote).toBe(
      `${outputDigestPath} summarizes every field of each list in the example output across all its records, including records past what publication/example-output.json keeps.`,
    );
  });
});

describe("the public definition", () => {
  const metadata = { name: "read_reports", description: "Read reports" };
  const schemas = {
    input: { type: "object", properties: { month: { type: "string" } } },
    output: { type: "array" },
  };

  it("lists the name and description, then the schemas and declared questions", () => {
    const questions = { delivery: { type: "choice" as const, prompt: "Which speed?" } };
    const text = publicDefinition(metadata, { ...schemas, questions });
    expect(text).toBe(
      JSON.stringify(
        {
          name: "read_reports",
          description: "Read reports",
          inputSchema: schemas.input,
          outputSchema: schemas.output,
          questions,
        },
        null,
        2,
      ),
    );
    expect(publicDefinition(metadata, schemas)).not.toContain('"questions"');
  });
});

describe("the evidence index", () => {
  it("lists the bundle under operation/, then each publication file", () => {
    const scope = publicationScope(
      new Map([
        ["src/tool.mjs", "export const é = 1;"],
        ["src/entry.mjs", "export {};"],
      ]),
      new Map([
        ["publication/definition.json", "{}"],
        ["publication/session-output.json", "{}"],
        ["publication/session/0/src/tool.mjs", "old"],
      ]),
    );
    expect(scope.files).toEqual([
      {
        path: "operation/src/tool.mjs",
        byteLength: Buffer.byteLength("export const é = 1;"),
        published: true,
        current: true,
        owner: "minter",
      },
      {
        path: "operation/src/entry.mjs",
        byteLength: 10,
        published: true,
        current: true,
        owner: "minter",
      },
      {
        path: "publication/definition.json",
        byteLength: 2,
        published: true,
        current: true,
        owner: "host",
      },
      {
        path: "publication/session-output.json",
        byteLength: 2,
        published: false,
        current: true,
        owner: "host",
      },
      {
        path: "publication/session/0/src/tool.mjs",
        byteLength: 3,
        published: false,
        current: false,
        owner: "host",
      },
    ]);
  });

  it("marks bundle files the host wrote as the host's, and lists the review's references", () => {
    const scope = publicationScope(
      new Map([
        ["src/tool.mjs", "export {};"],
        ["operation.mjs", "export * from './src/tool.mjs';"],
      ]),
      new Map([["publication/definition.json", "{}"]]),
      {
        hostWritten: new Set(["operation.mjs"]),
        references: new Map([[".agents/write-tools/SKILL.md", "# Skill é"]]),
      },
    );
    expect(Object.keys(scope)).toEqual(["references", "files"]);
    expect(scope.references).toEqual([
      { path: ".agents/write-tools/SKILL.md", byteLength: Buffer.byteLength("# Skill é") },
    ]);
    expect(scope.files.map(({ path, owner }) => [path, owner])).toEqual([
      ["operation/src/tool.mjs", "minter"],
      ["operation/operation.mjs", "host"],
      ["publication/definition.json", "host"],
    ]);
    expect(publicationScope(new Map(), new Map(), { references: new Map() })).not.toHaveProperty(
      "references",
    );
  });

  it("keeps each act step's entrypoint and its imports, in order, and drops what it never ran", () => {
    expect([
      ...sessionEvidenceFiles([
        {
          entrypoint: "src/read.mjs",
          files: new Map([
            ["src/read.mjs", 'import { h } from "./help.mjs";'],
            ["src/help.mjs", "export const h = 1;"],
            ["explore/unused.mjs", "export {};"],
          ]),
        },
        { entrypoint: "src/save.mjs", files: new Map([["src/save.mjs", "export {};"]]) },
      ]).keys(),
    ]).toEqual([
      "publication/session/0/src/read.mjs",
      "publication/session/0/src/help.mjs",
      "publication/session/1/src/save.mjs",
    ]);
  });

  it("tells the review what it judges a read or a write against", () => {
    const read = publicationEvidenceNote({
      kind: "read",
      entrypoint: "src/tool.mjs",
      completed: true,
    });
    expect(read).toContain("The actual completed example used executed/src/tool.mjs;");
    expect(read).not.toContain("The source changed after the example ran");
    expect(
      publicationEvidenceNote({
        kind: "read",
        entrypoint: "src/tool.mjs",
        completed: false,
        schemasReadOffline: true,
      }),
    ).toContain("The actual failed example used executed/src/tool.mjs; ");
    const write = publicationEvidenceNote({
      kind: "write",
      writeConfirmation: "readback",
      intentDerived: false,
    });
    expect(write).toContain("declared write confirmation (readback)");
    expect(write).toContain("and the caller's own input decodes against it.");
    expect(write.endsWith("Do not call for another run of the write.")).toBe(true);
  });
});

describe("reviewPublication", () => {
  const definition = publicDefinition(
    { name: "book_table", description: "Book a table" },
    {
      input: {
        type: "object",
        properties: { date: { type: "string" }, partySize: { type: "integer" } },
      },
      output: { type: "object" },
    },
  );
  const candidate: PublicationCandidate = {
    entrypoint: "src/tool.mjs",
    files: new Map([["src/tool.mjs", "export default 1;"]]),
    definition,
    evidence: new Map([["publication/example-output.json", "{}"]]),
    baseline: new Map([["src/tool.mjs", "export default 0;"]]),
    notes: "Evidence note.",
    inputSchema: JSON.parse(definition).inputSchema as unknown,
    write: false,
  };
  /** A fake host's review hook that records each request and allows it. */
  const recordingReview = () => {
    const requests: Parameters<PublicationReview>[0][] = [];
    const review: PublicationReview = (request) =>
      Effect.sync(() => {
        requests.push(request);
        return `review_${requests.length}`;
      });
    return { requests, review };
  };

  it("reviews the bundle against the definition first, then the host's evidence", async () => {
    const { requests, review } = recordingReview();
    expect(await Effect.runPromise(reviewPublication(review, candidate))).toBe("review_1");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({
      entrypoint: "src/tool.mjs",
      files: candidate.files,
      notes: "Evidence note.",
      baseline: candidate.baseline,
      allowedEffects: [
        "Publish the current operation bundle, including the files the host adds to it, and the public definition only; do not execute the business action again.",
      ],
    });
    expect([...(request?.evidence ?? [])]).toEqual([
      ["publication/definition.json", definition],
      ["publication/example-output.json", "{}"],
    ]);
  });

  it("gives the review its reference files apart from its evidence", async () => {
    const { requests, review } = recordingReview();
    const references = new Map([[".agents/core/SKILL.md", "# Core"]]);
    await Effect.runPromise(reviewPublication(review, { ...candidate, references }));
    expect(requests[0]?.references).toBe(references);
    expect([...(requests[0]?.evidence.keys() ?? [])]).not.toContain(".agents/core/SKILL.md");
  });

  it("passes the review's denial through as it came", async () => {
    const denial = new MintFailure({
      code: "ReviewDenied",
      review: { outcome: "deny", reason: "privacy", reviewId: "review_x", rationale: "No." },
    });
    const failure = await Effect.runPromise(
      Effect.flip(reviewPublication(() => Effect.fail(denial), candidate)),
    );
    expect(failure).toBe(denial);
  });

  it("returns an intent-derived key the schema does not list as input feedback once Guardian allows", async () => {
    const { requests, review } = recordingReview();
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(review, {
          ...candidate,
          intentDerivedInput: { date: "Friday", venue: "Corner", seating: "patio" },
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    const start = Buffer.byteLength(definition.slice(0, definition.indexOf('"inputSchema"')));
    const rationale =
      'The example ran with "venue", "seating" in its exampleInput, which the input schema does not list, so the tool fixes that value itself. Make each an input property.';
    expect(failure.review).toEqual({
      outcome: "deny",
      reason: "input_feedback",
      reviewId: "review_1",
      rationale,
      findings: [
        {
          path: "publication/definition.json",
          byteStart: start,
          byteEnd: start + '"inputSchema"'.length,
          category: "example_input",
          explanation: rationale,
        },
      ],
    });
    expect(definition.slice(start, start + 13)).toBe('"inputSchema"');
  });

  it("names the write session in a write's input feedback", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(recordingReview().review, {
          ...candidate,
          write: true,
          intentDerivedInput: { note: "kept" },
        }),
      ),
    );
    expect(failure.review?.rationale).toMatch(/^The write session ran with "note" in/u);
  });

  // An Effect identifier annotation or Schema.Class publishes its input schema as a root $ref,
  // and a union as anyOf; either lists the example's keys. A no-input tool's empty properties
  // lists none of them.
  it.each([
    {
      root: "a $ref",
      input: {
        $ref: "#/$defs/Reservation",
        $defs: {
          Reservation: {
            type: "object",
            properties: { venue: { type: "string" }, date: { type: "string" } },
          },
        },
      },
      feedback: false,
    },
    {
      root: "an anyOf",
      input: {
        anyOf: [
          { type: "object", properties: { venue: { type: "string" } } },
          { type: "object", properties: { date: { type: "string" } } },
        ],
      },
      feedback: false,
    },
    {
      root: "an unresolvable $ref",
      input: { $ref: "#/$defs/Missing" },
      feedback: false,
    },
    {
      root: "no properties at all",
      input: { type: "object" },
      feedback: false,
    },
    {
      root: "an empty properties",
      input: { type: "object", properties: {}, additionalProperties: false },
      feedback: true,
    },
  ])("checks an intent-derived example's keys against $root input root", async (row) => {
    const result = await Effect.runPromise(
      Effect.either(
        reviewPublication(recordingReview().review, {
          ...candidate,
          inputSchema: row.input,
          intentDerivedInput: { venue: "Corner", date: "Friday" },
        }),
      ),
    );
    expect(result._tag === "Left" && result.left.review?.reason === "input_feedback").toBe(
      row.feedback,
    );
  });

  it("gives a host that runs its own review the same unlisted keys and input feedback", () => {
    const unlisted = unlistedExampleInputKeys(candidate.inputSchema, {
      date: "Friday",
      venue: "Corner",
    });
    expect(unlisted).toEqual(["venue"]);
    expect(unlistedExampleInputKeys({ $ref: "#/$defs/Missing" }, { venue: "Corner" })).toEqual([]);
    expect(unlistedExampleInputKeys(candidate.inputSchema, undefined)).toEqual([]);
    const start = Buffer.byteLength(definition.slice(0, definition.indexOf('"inputSchema"')));
    const rationale =
      'The write session ran with "venue" in its exampleInput, which the input schema does not list, so the tool fixes that value itself. Make each an input property.';
    expect(exampleInputFeedback({ definition, write: true }, unlisted, "review_9").review).toEqual({
      outcome: "deny",
      reason: "input_feedback",
      reviewId: "review_9",
      rationale,
      findings: [
        {
          path: "publication/definition.json",
          byteStart: start,
          byteEnd: start + '"inputSchema"'.length,
          category: "example_input",
          explanation: rationale,
        },
      ],
    });
  });

  // A name the caller's request declares, an input it supplied or an output field a task update
  // added, is one the tool supports or the build ends blocked: never dropped from the schema.
  it("returns an input the caller's request names and the schema lacks as input feedback", async () => {
    const { requests, review } = recordingReview();
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(review, {
          ...candidate,
          requested: { input: { date: "2026-03-14", notes: "Window seat", partySize: 2 } },
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    const start = Buffer.byteLength(definition.slice(0, definition.indexOf('"inputSchema"')));
    expect(failure.review).toMatchObject({
      outcome: "deny",
      reason: "input_feedback",
      reviewId: "review_1",
      findings: [
        {
          path: "publication/definition.json",
          byteStart: start,
          byteEnd: start + '"inputSchema"'.length,
          category: "example_input",
        },
      ],
    });
    expect(failure.review?.rationale).toContain('"notes"');
    expect(failure.review?.rationale).not.toContain('"date"');
  });

  it("returns an output field a task update declared and the schema lacks as a source correction", async () => {
    const withOutput = publicDefinition(
      { name: "book_table", description: "Book a table" },
      {
        input: JSON.parse(definition).inputSchema as unknown,
        output: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "object", properties: { name: {} } } },
          },
        },
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        reviewPublication(recordingReview().review, {
          ...candidate,
          definition: withOutput,
          outputSchema: JSON.parse(withOutput).outputSchema as unknown,
          requested: { input: { notes: "Window seat" }, outputs: ["items[].name", "items[].currency"] },
        }),
      ),
    );
    const outputAt = Buffer.byteLength(withOutput.slice(0, withOutput.indexOf('"outputSchema"')));
    expect(failure.review).toMatchObject({
      outcome: "deny",
      reason: "source_correction",
      findings: [
        { category: "example_input" },
        {
          path: "publication/definition.json",
          byteStart: outputAt,
          byteEnd: outputAt + '"outputSchema"'.length,
          category: "schema_mismatch",
        },
      ],
    });
    expect(failure.review?.findings?.[1]?.explanation).toContain('"items[].currency"');
    expect(failure.review?.findings?.[1]?.explanation).not.toContain('"items[].name"');
  });

  it("publishes when every requested name is in the schemas", async () => {
    expect(
      await Effect.runPromise(
        reviewPublication(recordingReview().review, {
          ...candidate,
          outputSchema: { type: "object", properties: { status: { type: "string" } } },
          requested: { input: { date: "2026-03-14", partySize: 2 }, outputs: ["status"] },
        }),
      ),
    ).toBe("review_1");
  });

  it("finds each requested name across references, unions and nested lists", () => {
    const inputSchema = {
      $ref: "#/$defs/Entry",
      $defs: { Entry: { type: "object", properties: { amount: {}, memo: {} } } },
    };
    const outputSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            entry: {
              type: "object",
              properties: {
                lines: {
                  type: "array",
                  items: { $ref: "#/$defs/Line" },
                },
              },
            },
          },
        },
        { type: "object", properties: { status: { type: "string" } } },
      ],
      $defs: { Line: { type: "object", properties: { account: {}, amount: {} } } },
    };
    expect(
      missingRequestedNames(
        { input: inputSchema, output: outputSchema },
        {
          input: { amount: "12.50", memo: "Rent", notes: "Paid early" },
          outputs: ["status", "entry.lines[].amount", "entry.lines[].direction", "entry.total"],
        },
      ),
    ).toEqual({ inputs: ["notes"], outputs: ["entry.lines[].direction", "entry.total"] });
  });

  it("checks no name a schema cannot answer for", () => {
    // A free-form object, an unresolvable reference or a caller input that is not an object
    // lists nothing to check against.
    expect(
      missingRequestedNames(
        { input: { $ref: "#/$defs/Missing" }, output: { type: "object" } },
        { input: { notes: "Paid early" }, outputs: ["status", "entry.total"] },
      ),
    ).toEqual({ inputs: [], outputs: [] });
    expect(
      missingRequestedNames(
        { input: { type: "object", properties: {} }, output: undefined },
        { input: ["notes"], outputs: ["status"] },
      ),
    ).toEqual({ inputs: [], outputs: [] });
    // A map keyed by the site's own field names takes any key.
    expect(
      missingRequestedNames(
        {
          input: { type: "object", properties: {}, additionalProperties: { type: "string" } },
          output: {
            type: "object",
            properties: { fields: { type: "object", properties: {}, additionalProperties: true } },
          },
        },
        { input: { Company: "Acme" }, outputs: ["fields.Close date"] },
      ),
    ).toEqual({ inputs: [], outputs: [] });
  });

  it("reads the output fields each task update declares, a later removal dropping one", () => {
    const update = (...changes: Parameters<typeof requestedOutputFields>[0][number]["changes"]) => ({
      changes,
    });
    expect(
      requestedOutputFields([
        update(
          { setting: "output", field: "price.amount", change: "add", text: "Add the amount" },
          { setting: "output", field: "status", change: "tighten", text: "Always return it" },
          { setting: "purpose", text: "Read one order" },
        ),
        update(
          { setting: "output", field: "rating", change: "nullable", text: "May be missing" },
          {
            setting: "output",
            field: "status",
            change: "remove",
            text: "Drop the status",
            reason: "The page no longer shows it",
          },
        ),
      ]),
    ).toEqual(["price.amount", "rating"]);
  });

  it("checks nothing for an example that ran the caller's own input", async () => {
    expect(
      await Effect.runPromise(
        reviewPublication(recordingReview().review, {
          ...candidate,
          inputSchema: { type: "object", properties: {} },
        }),
      ),
    ).toBe("review_1");
  });
});
