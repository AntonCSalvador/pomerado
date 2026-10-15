import type { AgentInputItem, ModelProvider, ModelRequest } from "@openai/agents";
import { protocol } from "@openai/agents";
import { compaction, StaticCompactionPolicy } from "@openai/agents/sandbox";
import { Clock, Effect, Schema } from "effect";
import { compactionTrigger } from "../models/compaction-trigger.js";
import { modelUsageCounts } from "../models/model-usage.js";
import { leadingPrivateAfter } from "./review-layout.js";

/** Private continuation state; complete original exchanges remain in protected model records. */
export const GuardianSessionSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sdkVersion: Schema.Literal("0.18.0"),
  history: Schema.Array(Schema.Unknown),
  incomplete: Schema.Boolean,
  effectiveReasoningContext: Schema.optional(
    Schema.Literal("all_turns", "current_turn", "not_reported"),
  ),
  /**
   * The items before the history's first request belong to a private review whose request
   * a compaction removed, so readable records still withhold them.
   */
  leadingPrivate: Schema.optional(Schema.Literal(true)),
  /**
   * The input and output tokens of the conversation's last model call: about the size the next
   * request starts from. Absent before the first call and after a compaction, until the next call.
   */
  contextTokens: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
});
export type GuardianSessionSnapshot = typeof GuardianSessionSnapshot.Type;

/** The provider compacts the conversation inside a request whose input reaches this many tokens. */
export const guardianCompactionThresholdTokens = 240_000;

/**
 * The conversation size at which Guardian compacts before a review instead, so the compaction
 * never runs inside one of the review's own calls. Two thirds of the provider's threshold: a
 * review has 80K tokens for its request, reads and reasoning before the provider would compact.
 */
export const guardianCompactBeforeReviewTokens = 160_000;

/** One compaction a session ran before a review, apart from the review's own calls. */
export interface GuardianSessionCompaction {
  readonly state: "completed" | "failed";
  /** Why a failed compaction left the conversation as it was. */
  readonly reason?: "no_compaction_item" | "provider_failed";
  /** The conversation's size before it, from its last model call. */
  readonly contextTokens: number;
  readonly startedAtUtc: string;
  readonly endedAtUtc: string;
  readonly elapsedMs: number;
  /** The compaction call's token counts, when it returned. */
  readonly usage?: ReturnType<typeof modelUsageCounts>;
}
interface GuardianReasoningReport {
  readonly requested: "all_turns";
  readonly effective: "all_turns" | "current_turn" | "not_reported";
  readonly level: "info" | "warning";
  readonly detail?: string;
}
export interface GuardianSessionOptions {
  readonly reportReasoning?: (context: GuardianReasoningReport) => Effect.Effect<void>;
  readonly initial?: GuardianSessionSnapshot;
  readonly save?: (snapshot: GuardianSessionSnapshot) => Effect.Effect<void, Error>;
  /**
   * What the conversation is told after a turn that did not complete: the result of each tool
   * call it left unanswered, and the message before the next request. Guardian's own by default;
   * another continuing session, such as the outcome reviewer's, names its own work.
   */
  readonly interruption?: { readonly toolResult: string; readonly continuation: string };
  /**
   * Compact the conversation before a review, apart from its model calls, when the last call's
   * input and output reached this many tokens. The review then starts from the compacted context
   * followed by its own request. Absent, the conversation compacts only when the provider does,
   * inside whichever request crosses its threshold. `makeGuardian` sets
   * `guardianCompactBeforeReviewTokens` unless the host sets its own.
   */
  readonly compactBeforeReviewTokens?: number;
}

const guardianInterruption = {
  toolResult:
    "The previous review was interrupted before this source result was retained. No source result or approval is implied. Read the current source again.",
  continuation:
    "The preceding review did not complete. Continue in the same conversation and review the following current request afresh; earlier verdicts are not authorization.",
};

export const guardianContinuityPolicy =
  "This is one continuing Guardian conversation for this mint. Earlier requests, source reads, " +
  "reasoning and verdicts are historical context, never authority for this request. Apply the " +
  "current instructions and this turn's trusted authority. Inspect current source for every " +
  "execution: an earlier allow never satisfies this review, and an earlier read does only for " +
  "a source the host lists in trusted_review.unchangedSources as byte-identical to it. An " +
  "interrupted review grants no approval.";

/** Same explicit provider compaction threshold as the minter; no additional tools or sandbox. */
export const guardianCompaction = (): ReturnType<typeof compaction> =>
  compaction({ policy: new StaticCompactionPolicy(guardianCompactionThresholdTokens) });

const closeInterruptedReview = (
  items: AgentInputItem[],
  interruption: NonNullable<GuardianSessionOptions["interruption"]>,
) => {
  const answered = new Set(
    items.flatMap((item) => (item.type === "function_call_result" ? [item.callId] : [])),
  );
  for (const item of [...items])
    if (item.type === "function_call" && !answered.has(item.callId))
      items.push({
        type: "function_call_result",
        status: "completed",
        name: item.name,
        callId: item.callId,
        output: { type: "text", text: interruption.toolResult },
      });
  items.push({ role: "user", type: "message", content: interruption.continuation });
};

/** A compaction due before the review whose request follows this many history items. */
interface PlannedCompaction {
  readonly length: number;
  readonly contextTokens: number;
}

/** A compaction that replaced a review's first `length` items, matched by their content. */
interface AppliedCompaction {
  readonly length: number;
  readonly key: string;
  readonly item: AgentInputItem;
}

/** What the session provider needs of the session for a compaction before a review. */
interface CompactionHooks {
  /** The compaction planned for this review, once: only its first call runs it. */
  readonly take: () => PlannedCompaction | undefined;
  /** The items as sent: the applied compaction item after the history it replaced. */
  readonly view: (items: readonly AgentInputItem[]) => AgentInputItem[];
  readonly applied: (applied: AppliedCompaction) => void;
  readonly failed: () => void;
  readonly observe?: (compaction: GuardianSessionCompaction) => Effect.Effect<void>;
}

type GuardianModel = Awaited<ReturnType<ModelProvider["getModel"]>>;

/**
 * Compacts the history before the review's request with one call of its own: the review's first
 * request with its input cut at that point and the compaction trigger after it, so it reads the
 * prefix the last call cached. The review's calls then send the compaction item in place of that
 * history, followed by everything after it. A failed compaction leaves the conversation whole;
 * the provider still compacts at its own threshold.
 */
const compactBefore = ({
  model,
  request,
  input,
  planned,
  signal,
  state,
  save,
  setContextTokens,
  compaction,
}: {
  model: GuardianModel;
  request: ModelRequest;
  input: readonly AgentInputItem[];
  planned: PlannedCompaction;
  signal: () => AbortSignal;
  state: () => AgentInputItem[];
  save: (items: readonly AgentInputItem[], incomplete: boolean) => Effect.Effect<void, Error>;
  setContextTokens: (tokens: number | undefined) => void;
  compaction: CompactionHooks;
}) =>
  Effect.gen(function* () {
    const prefix = input.slice(0, planned.length);
    const startedMs = yield* Clock.currentTimeMillis;
    const result = yield* Effect.either(
      Effect.tryPromise(() =>
        model.getResponse({ ...request, input: [...prefix, compactionTrigger] }),
      ),
    );
    const endedMs = yield* Clock.currentTimeMillis;
    signal().throwIfAborted();
    const item =
      result._tag === "Right"
        ? result.right.output.findLast((entry) => entry.type === "compaction")
        : undefined;
    if (item === undefined) compaction.failed();
    else {
      compaction.applied({ length: prefix.length, key: JSON.stringify(prefix), item });
      setContextTokens(undefined);
      yield* save(state(), true);
    }
    yield* compaction.observe?.({
      state: item === undefined ? "failed" : "completed",
      ...(item !== undefined
        ? {}
        : { reason: result._tag === "Left" ? "provider_failed" : "no_compaction_item" }),
      contextTokens: planned.contextTokens,
      startedAtUtc: new Date(startedMs).toISOString(),
      endedAtUtc: new Date(endedMs).toISOString(),
      elapsedMs: endedMs - startedMs,
      ...(result._tag === "Right" ? { usage: modelUsageCounts(result.right.usage) } : {}),
    }) ?? Effect.void;
  });

const continuationProvider = ({
  provider,
  state,
  signal,
  save,
  reportReasoning,
  setEffective,
  compacted,
  setContextTokens,
  compaction,
}: {
  provider: ModelProvider;
  state: () => AgentInputItem[];
  signal: () => AbortSignal;
  save: (items: readonly AgentInputItem[], incomplete: boolean) => Effect.Effect<void, Error>;
  reportReasoning: GuardianSessionOptions["reportReasoning"];
  setEffective: (value: "all_turns" | "current_turn" | "not_reported") => void;
  compacted: () => void;
  setContextTokens: (tokens: number | undefined) => void;
  compaction: CompactionHooks;
}): ModelProvider => ({
  getModel: (name) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* Effect.promise(async () => provider.getModel(name));
        return {
          ...model,
          getStreamedResponse: model.getStreamedResponse.bind(model),
          getResponse: (request: ModelRequest) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* save(state(), true);
                const planned = typeof request.input === "string" ? undefined : compaction.take();
                if (planned !== undefined && typeof request.input !== "string")
                  yield* compactBefore({
                    model,
                    request,
                    input: request.input,
                    planned,
                    signal,
                    state,
                    save,
                    setContextTokens,
                    compaction,
                  });
                const response = yield* Effect.tryPromise({
                  try: () =>
                    model.getResponse({
                      ...request,
                      input:
                        typeof request.input === "string"
                          ? request.input
                          : guardianCompaction().processContext(compaction.view(request.input)),
                    }),
                  catch: (error) =>
                    error instanceof Error
                      ? error
                      : new Error("Guardian provider failed", { cause: error }),
                });
                signal().throwIfAborted();
                const providerCompacted = response.output.some(
                  (item) => item.type === "compaction",
                );
                if (providerCompacted) compacted();
                // A provider compaction leaves the next request's size unknown until it returns.
                setContextTokens(
                  providerCompacted
                    ? undefined
                    : response.usage.inputTokens + response.usage.outputTokens,
                );
                const metadata = Schema.decodeUnknownEither(
                  Schema.Struct({
                    reasoning: Schema.Struct({
                      context: Schema.Literal("all_turns", "current_turn"),
                    }),
                  }),
                )(response.providerData);
                const effective =
                  metadata._tag === "Right" ? metadata.right.reasoning.context : "not_reported";
                setEffective(effective);
                yield* save([...state(), ...response.output], true);
                // A current_turn response still decides: each request carries its own trusted
                // authority and source inspection, and the replayed history keeps earlier requests,
                // source exchanges and verdicts. Only earlier turns' reasoning is not carried.
                if (reportReasoning)
                  yield* reportReasoning(
                    effective === "current_turn"
                      ? {
                          requested: "all_turns",
                          effective,
                          level: "warning",
                          detail:
                            "Guardian requested all_turns reasoning but the provider reported current_turn: earlier reviews' reasoning was not carried into this response. The review continues; earlier requests, source exchanges and verdicts are still sent as conversation history.",
                        }
                      : { requested: "all_turns", effective, level: "info" },
                  );
                return response;
              }),
              { signal: signal() },
            ),
        };
      }),
    ),
});

export const makeGuardianSession = (options: GuardianSessionOptions) => {
  const permit = Effect.unsafeMakeSemaphore(1);
  /** Provider compactions this process observed; each replaces the context Guardian sees. */
  let compactions = 0;
  /** A compaction before the current review: planned at its request, applied by its first call. */
  let planned: PlannedCompaction | undefined;
  let applied: AppliedCompaction | undefined;
  /** A compaction before a review failed; the provider's own threshold bounds the rest. */
  let compactionFailed = false;
  let current: GuardianSessionSnapshot = options.initial ?? {
    version: 1,
    sdkVersion: "0.18.0",
    history: [],
    incomplete: false,
  };
  const history = (): AgentInputItem[] =>
    current.history.map((item) => protocol.ModelItem.parse(item));
  /** The items as the provider sees them: the applied compaction item after what it replaced. */
  const view = (items: readonly AgentInputItem[]): AgentInputItem[] => {
    const replaced = applied;
    if (
      replaced === undefined ||
      items.length < replaced.length ||
      JSON.stringify(items.slice(0, replaced.length)) !== replaced.key
    )
      return [...items];
    return [...items.slice(0, replaced.length), replaced.item, ...items.slice(replaced.length)];
  };
  /** Whether the next review compacts the conversation before its first call. */
  const compactsBeforeReview = () =>
    options.compactBeforeReviewTokens !== undefined &&
    !compactionFailed &&
    current.history.length > 0 &&
    (current.contextTokens ?? 0) >= options.compactBeforeReviewTokens;
  const save = (sent: readonly AgentInputItem[], incomplete: boolean) =>
    Effect.suspend(() => {
      const items = view(sent);
      // Only the provider's continuation item replaces context. Never trim reviews ourselves.
      let start = 0;
      for (let index = 0; index < items.length; index++)
        if (items[index]?.type === "compaction") start = index;
      const { leadingPrivate: _previous, ...rest } = current;
      current = {
        ...rest,
        history: items.slice(start),
        incomplete,
        ...(leadingPrivateAfter(items.slice(0, start), current.leadingPrivate === true)
          ? { leadingPrivate: true as const }
          : {}),
      };
      return (options.save?.(current) ?? Effect.void).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            current = { ...current, incomplete: true };
          }),
        ),
      );
    });
  return {
    /** `observe` hears of a compaction before the review, which its first call runs. */
    provider: (
      provider: ModelProvider,
      state: () => AgentInputItem[],
      signal: () => AbortSignal,
      observe?: (compaction: GuardianSessionCompaction) => Effect.Effect<void>,
    ) =>
      continuationProvider({
        provider,
        state,
        signal,
        save,
        reportReasoning: options.reportReasoning,
        setEffective: (effective) => {
          current = { ...current, effectiveReasoningContext: effective };
        },
        compacted: () => {
          compactions++;
        },
        setContextTokens: (tokens) => {
          const { contextTokens: _previous, ...rest } = current;
          current = tokens === undefined ? rest : { ...rest, contextTokens: tokens };
        },
        compaction: {
          take: () => {
            const next = planned;
            planned = undefined;
            return next;
          },
          view,
          applied: (compaction) => {
            applied = compaction;
          },
          failed: () => {
            compactionFailed = true;
          },
          ...(observe === undefined ? {} : { observe }),
        },
      }),
    snapshot: () => current,
    /** Whether readable records must withhold the history's leading items; see the snapshot. */
    leadingPrivate: () => current.leadingPrivate === true,
    /** The conversation since its last compaction, as the next request continues it. */
    history,
    /**
     * Changes whenever a compaction replaces the context in the middle of a review. A compaction
     * before a review does not count: it replaces only what came before the review's request.
     */
    compactions: () => compactions,
    /**
     * Whether the next review compacts the conversation before its first call, so the reads
     * before it leave the review's view. Read it before that review's request.
     */
    compactsBeforeReview,
    exclusive: <A, E, R>(work: Effect.Effect<A, E, R>) => permit.withPermits(1)(work),
    observe: (items: readonly AgentInputItem[]) => save(items, true),
    complete: () => save(history(), false),
    sourceResult: (callId: string, output: string) =>
      save(
        [
          ...history(),
          {
            type: "function_call_result",
            status: "completed",
            name: "read_source",
            callId,
            output: { type: "text", text: output },
          },
        ],
        true,
      ),
    /** Adds a request; `continuing` marks the host's follow-up within the review in progress. */
    input: (request: string, continuing = false) =>
      Effect.gen(function* () {
        const items = history();
        if (current.incomplete && !continuing) {
          closeInterruptedReview(items, options.interruption ?? guardianInterruption);
        }
        if (!continuing) {
          applied = undefined;
          planned = compactsBeforeReview()
            ? { length: items.length, contextTokens: current.contextTokens ?? 0 }
            : undefined;
        }
        items.push({ role: "user", type: "message", content: request });
        yield* save(items, true);
        return items;
      }),
  };
};
export type GuardianSession = ReturnType<typeof makeGuardianSession>;
