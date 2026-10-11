import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import { OperationFailure, operationErrors } from "./operation-failure.js";
import { listHostOf } from "./list-host.js";

export { withListHost, type ListHost } from "./list-host.js";

// One page of a list per call, and a cursor to the next. A script reads the position it continues
// from with `startList` and reads the page with `readList`, which reaches the position through the
// script's site actions, picks the rows it returns with `selectRows` and writes the list's output
// fields with `finishList`. The host signs every cursor a caller sees and checks it before the
// next run starts, so a script never writes, signs or parses a cursor itself: the position it
// gets is one this tool returned within ten minutes, for the same inputs. The position reaches the
// script on a host channel beside its input (`withListHost`), never in the input itself, so a run
// whose host did not check a cursor refuses it rather than trusting what the caller sent.

/** Rows a call returns when the caller names no `limit`, and the most it may ask for. */
export const listLimitDefault = 20;
export const listLimitMax = 50;
/** The longest cursor a caller may send back. */
export const listCursorMaxLength = 2_048;
/** How long a cursor can be used after the run that returned it: ten minutes. */
export const listCursorTtlMs = 600_000;
/**
 * The most row-key digests a cursor keeps from the rows returned before it: the tail of the last
 * page, which is what a later page needs to drop rows it already returned.
 */
export const listSeenMax = 16;
/**
 * The most bytes a draft's JSON may take. With the host's own fields and signature added, any
 * draft within it seals into a cursor no longer than `listCursorMaxLength`.
 */
export const listDraftMaxBytes = 1_360;
/** The most one call reads before it returns what it has with a cursor that continues. */
export const listCallBounds = { sitePages: 5, steps: 10 } as const;
/**
 * The deepest position a cursor may hold when it has no link or token from the site to open: the
 * replay from the first page grows with depth, so past it `next_cursor` is null.
 */
export const listDepth = { sitePages: 10, steps: 20 } as const;

/**
 * How a site shows the next rows: `pages` (numbered page links), `next_link` (only a Next link,
 * often with an opaque token), `append` (a "Load more" control), `scroll` (rows that load as the
 * list scrolls), `api` (the page's own list endpoint with an offset, page or token) or `offset`
 * (the whole list on one page, read in windows).
 */
export const ListMechanism = Schema.Literal(
  "pages",
  "next_link",
  "append",
  "scroll",
  "api",
  "offset",
);
export type ListMechanism = typeof ListMechanism.Type;

/**
 * Why a cursor was refused. The host refuses `malformed`, `altered`, `unknown_key`, `version`,
 * `other_tool`, `other_account`, `inputs_changed`, `expired` and `off_site` before the run starts;
 * the script refuses `mechanism_changed` when the tool now pages another way, and `site_expired`
 * when the site refuses its own link or token and the position cannot be rebuilt.
 */
export const CursorRefusal = Schema.Literal(
  "malformed",
  "altered",
  "unknown_key",
  "version",
  "other_tool",
  "other_account",
  "inputs_changed",
  "expired",
  "off_site",
  "mechanism_changed",
  "site_expired",
);
export type CursorRefusal = typeof CursorRefusal.Type;

/** A row key's or context's digest in a cursor: 48 bits, so no account value rides in it. */
const Digest = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{8}$/u));
const countMax = 100_000;
const Count = Schema.Int.pipe(Schema.between(0, countMax));
const hrefMaxLength = 1_024;
const tokenMaxLength = 512;
const scopeMaxLength = 200;

/**
 * Where the next rows start on the site: the site page and the offset within it, the steps of a
 * "Load more" or scroll replay, and the site's own link to that page (`href`) or its list API's
 * token (`token`) exactly as this run read them. `scope` is a list scope the site applies by its
 * own value, such as a year or a tab.
 */
export const ListPosition = Schema.Struct({
  page: Schema.optional(Schema.Int.pipe(Schema.between(1, 100_000))),
  steps: Schema.optional(Count),
  offset: Count,
  pageSize: Schema.optional(Schema.Int.pipe(Schema.between(1, 10_000))),
  href: Schema.optional(Schema.String.pipe(Schema.maxLength(hrefMaxLength))),
  token: Schema.optional(Schema.String.pipe(Schema.maxLength(tokenMaxLength))),
  scope: Schema.optional(Schema.String.pipe(Schema.maxLength(scopeMaxLength))),
});
export type ListPosition = typeof ListPosition.Type;

const draftBytes = (draft: unknown) => Buffer.byteLength(JSON.stringify(draft), "utf8");

/**
 * The part of a cursor a script writes and reads: its mechanism, position, the rows returned so
 * far, the anchor (the last returned row's key digest), the digests of the last page's last keys
 * and the digest of the context the site applied. The host adds the tool, the inputs' digest, the
 * caller it was issued to and the expiry, and signs it. Its JSON is at most `listDraftMaxBytes`.
 */
export const listDraftFields = {
  m: ListMechanism,
  pos: ListPosition,
  n: Count,
  a: Schema.optional(Digest),
  s: Schema.Array(Digest).pipe(Schema.maxItems(listSeenMax)),
  cx: Schema.optional(Digest),
};
export const ListDraft = Schema.Struct(listDraftFields).pipe(
  Schema.filter((draft) => draftBytes(draft) <= listDraftMaxBytes),
);
export type ListDraft = typeof ListDraft.Type;

/** How a draft travels between the runtime and its host, never to a caller. */
export const listDraftPrefix = "pcd1.";

export const encodeListDraft = (draft: ListDraft) =>
  `${listDraftPrefix}${Buffer.from(JSON.stringify(Schema.encodeSync(ListDraft)(draft))).toString("base64url")}`;

/** The draft a `pcd1.` string holds, or undefined for any other value. */
export const decodeListDraft = (value: unknown): ListDraft | undefined => {
  if (typeof value !== "string" || !value.startsWith(listDraftPrefix)) return undefined;
  const body = value.slice(listDraftPrefix.length);
  if (!/^[A-Za-z0-9_-]*$/u.test(body)) return undefined;
  try {
    const decoded = Schema.decodeUnknownEither(ListDraft, { onExcessProperty: "error" })(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    return Either.isRight(decoded) ? decoded.right : undefined;
    // error-reporting-allow: parse-predicate a draft that is not JSON is no draft
  } catch {
    return undefined;
  }
};

/** A row key's or context's digest, as cursors carry it. */
export const listDigest = (value: string) =>
  createHash("sha256").update(value).digest("base64url").slice(0, 8);

/** The list inputs every list tool takes; spread them into its input schema's fields. */
export const listInputFields = {
  limit: Schema.optional(
    Schema.Int.pipe(Schema.between(1, listLimitMax)).annotations({
      description: `The most results to return in this call, 1 to ${listLimitMax}. Default ${listLimitDefault}.`,
    }),
  ),
  cursor: Schema.optional(
    Schema.String.pipe(Schema.maxLength(listCursorMaxLength)).annotations({
      description:
        "The next_cursor a previous call returned, to get the results that follow. Send the same other inputs as that call; limit may change.",
    }),
  ),
};

/** The list outputs every list tool returns; spread them into its output schema's fields. */
export const listOutputFields = {
  next_cursor: Schema.NullOr(Schema.String).annotations({
    description:
      "Pass as cursor, with the same inputs, to get the results that follow. Null when no more can be fetched.",
  }),
  next_cursor_expires_at: Schema.NullOr(Schema.String).annotations({
    description:
      "When next_cursor stops working, as an ISO 8601 UTC time; null when next_cursor is null.",
  }),
  has_more: Schema.Boolean.annotations({
    description: "Whether the site shows more results after these, reachable or not.",
  }),
  total_results: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())).annotations({
    description:
      "The site's own exact count of results; null when it shows none or only an approximate one.",
  }),
  list_changed: Schema.Boolean.annotations({
    description:
      "True when the site's list changed since the cursor was issued; rows may be missing or repeated relative to earlier pages.",
  }),
  next_cursor_unavailable: Schema.optional(
    Schema.Literal(
      "depth_cap",
      "no_progress",
      "position_too_long",
      "unsigned_host",
      "off_site",
      "not_a_draft",
      "inputs_not_json",
    ).annotations({
      description:
        "Why next_cursor is null although has_more is true: depth_cap past the deepest page this tool can reach again, no_progress when this call returned no results and could not move past the cursor's position, position_too_long when the site's link to the next page is too long for a cursor, off_site when it leaves the site, or the host could not sign one.",
    }),
  ),
};

/** Why a list that has more returned no next cursor. */
export type ListCursorUnavailable = NonNullable<ListOutput["next_cursor_unavailable"]>;

/** The list fields `finishList` writes into a tool's output. */
export interface ListOutput {
  readonly next_cursor: string | null;
  readonly next_cursor_expires_at: string | null;
  readonly has_more: boolean;
  readonly total_results: number | null;
  readonly list_changed: boolean;
  readonly next_cursor_unavailable?:
    | "depth_cap"
    | "no_progress"
    | "position_too_long"
    | "unsigned_host"
    | "off_site"
    | "not_a_draft"
    | "inputs_not_json";
}

/** Where a call starts: its `limit`, and on a later page the position the cursor holds. */
export interface ListStart {
  readonly limit: number;
  readonly mechanism: ListMechanism;
  /** Undefined on the first page. */
  readonly position?: ListPosition;
  /** Rows earlier pages returned. */
  readonly returned: number;
  readonly anchor?: string;
  readonly seen: ReadonlySet<string>;
  readonly context?: string;
  /** Whether the run's host signs the next cursor; without it, `finishList` returns none. */
  readonly signed: boolean;
}

const refuse = (reason: CursorRefusal, message: string) =>
  new operationErrors.InvalidInput(message, { field: "cursor", kind: reason });

/**
 * Reads the call's `limit` and the position its cursor holds, before any browser work. The
 * position comes from the host, which checked the cursor's signature, tool, inputs, caller and
 * expiry before the run started. It throws `errors.InvalidInput` with `field: "cursor"` when the
 * run has a cursor its host did not check, or the tool now pages another way than when it was
 * issued. An empty cursor is none.
 */
export const startList = (
  input: unknown,
  options: { readonly mechanism: ListMechanism },
): ListStart => {
  const limitValue: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "limit") : undefined;
  const cursor: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "cursor") : undefined;
  const limit =
    typeof limitValue === "number" && Number.isInteger(limitValue)
      ? Math.min(Math.max(limitValue, 1), listLimitMax)
      : listLimitDefault;
  const host = listHostOf(input);
  const signed = host !== undefined;
  if (cursor === undefined || cursor === null || cursor === "")
    return { limit, mechanism: options.mechanism, returned: 0, seen: new Set(), signed };
  const draft = host?.position;
  if (draft === undefined)
    throw refuse(
      "malformed",
      "The cursor is not one this tool returned. Call again without cursor to start from the first page.",
    );
  if (draft.m !== options.mechanism)
    throw refuse(
      "mechanism_changed",
      "This tool now pages the site another way, so the cursor no longer applies. Call again without cursor to start from the first page and skip the results you already have.",
    );
  return {
    limit,
    mechanism: draft.m,
    position: draft.pos,
    returned: draft.n,
    ...(draft.a === undefined ? {} : { anchor: draft.a }),
    seen: new Set(draft.s),
    ...(draft.cx === undefined ? {} : { context: draft.cx }),
    signed,
  };
};

/** The indices in `rows` of the rows `selectRows` picks, and whether the list changed. */
const pickRows = <Row>(
  list: ListStart,
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  options: { readonly context?: string },
): { readonly indices: number[]; readonly listChanged: boolean } => {
  const digests = rows.map((row) => listDigest(keyOf(row)));
  let start = 0;
  let changed = false;
  const position = list.position;
  if (position !== undefined) {
    const anchor = list.anchor === undefined ? -1 : digests.lastIndexOf(list.anchor);
    if (anchor >= 0) start = anchor + 1;
    else {
      // The anchor is gone: continue after the last returned row still here, so a removal
      // repeats rows rather than skipping them. A position names the segment that holds the
      // anchor, so its absence there is a change. Only a site token that starts right after the
      // anchor (offset 0) reads rows that cannot hold it.
      const lastSeen = digests.findLastIndex((digest) => list.seen.has(digest));
      start = lastSeen + 1;
      const pastAnchor = position.token !== undefined && position.offset === 0;
      if (lastSeen >= 0 || (list.anchor !== undefined && !pastAnchor)) changed = true;
    }
    if (
      list.context !== undefined &&
      options.context !== undefined &&
      listDigest(options.context) !== list.context
    )
      changed = true;
  }
  const kept = new Set<string>();
  const indices: number[] = [];
  for (let index = start; index < rows.length; index++) {
    const digest = digests[index] ?? "";
    if (list.seen.has(digest)) {
      changed = true;
      continue;
    }
    if (kept.has(digest)) continue;
    kept.add(digest);
    indices.push(index);
  }
  return { indices, listChanged: changed };
};

/**
 * Picks the rows that follow the previous page from `rows`, the rows the call read in the site's
 * order from where its position starts: the segment that holds the anchor, the last row the
 * previous page returned. It continues after the anchor, wherever that row now is. When the
 * anchor is gone, it continues after the last row the previous page returned that is still
 * there, else from the first row, so a change repeats rows rather than skipping them. It drops
 * rows the previous page returned and any key twice. `listChanged` is true when the anchor is
 * gone, a returned row came back or the context the site applied (such as a location it chose)
 * differs. A position whose site `token` starts right after the anchor (offset 0) reads rows that
 * cannot hold it, so there the anchor's absence is no change. A key is the row's stable ID; give
 * a promoted copy of a row its own key, such as `sponsored:` plus the ID, to keep both.
 * `readList` calls it for you.
 */
export const selectRows = <Row>(
  list: ListStart,
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  options: { readonly context?: string } = {},
): { readonly rows: Row[]; readonly listChanged: boolean } => {
  const picked = pickRows(list, rows, keyOf, options);
  return {
    rows: picked.indices.flatMap((index) => {
      const row = rows[index];
      return row === undefined ? [] : [row];
    }),
    listChanged: picked.listChanged,
  };
};

/** Whether the tool can rebuild `next` on a later call. */
const reachable = (next: ListPosition) =>
  next.href !== undefined ||
  next.token !== undefined ||
  ((next.page ?? 1) <= listDepth.sitePages && (next.steps ?? 0) <= listDepth.steps);

/** Whether two positions name the same place on the site. */
const samePosition = (a: ListPosition, b: ListPosition) =>
  a.page === b.page &&
  a.steps === b.steps &&
  a.offset === b.offset &&
  a.pageSize === b.pageSize &&
  a.href === b.href &&
  a.token === b.token &&
  a.scope === b.scope;

/** Whether a next position fits in a cursor, with room for everything else the cursor holds. */
const fits = (next: ListPosition) =>
  (next.href?.length ?? 0) <= hrefMaxLength &&
  (next.token?.length ?? 0) <= tokenMaxLength &&
  (next.scope?.length ?? 0) <= scopeMaxLength;

/** Parameter names that carry a session or a credential, compared without case. */
const sessionParameter =
  /^(?:j?sessionid|session(?:_?id|_?token|_?key)?|phpsessid|aspsessionid\w*|sid|access_?token|id_?token|auth_?token|password|passwd)$/iu;

/**
 * Whether a site link carries a session or a credential: a user name or password, a path
 * parameter such as `;jsessionid=`, or a session parameter in its query or fragment. A cursor
 * never carries one: the next call signs in through the host instead.
 */
const carriesSession = (href: string) => {
  const url = URL.parse(href);
  if (url === null) return false;
  if (url.username !== "" || url.password !== "") return true;
  const names = [
    ...url.pathname
      .split("/")
      .flatMap((segment) => segment.split(";").slice(1))
      .map((parameter) => parameter.split("=")[0] ?? ""),
    ...url.searchParams.keys(),
    ...new URLSearchParams(url.hash.slice(1)).keys(),
  ];
  return names.some((name) => sessionParameter.test(name));
};

/** A position without a site link that carries a session; the next call reaches it by number. */
const withoutSession = (next: ListPosition): ListPosition => {
  if (next.href === undefined || !carriesSession(next.href)) return next;
  const { href: _href, ...rest } = next;
  return rest;
};

/**
 * Writes the list's output fields for the rows this call returns. `next` is where the following
 * rows start, null when the site shows nothing further; it names the segment that holds the last
 * returned row, so the next call finds that row again. When the list has more but no cursor
 * can continue it, `next_cursor` is null, `has_more` stays true and `next_cursor_unavailable`
 * says why: past the deepest position the tool can rebuild without a site link or token, a site
 * link or token too long for a cursor, a later page that returned no rows and stayed at the
 * position it started from, such as a list that stalls while the site still offers more (so a
 * caller paging until `has_more` is false still ends), or a host that does not sign cursors. A
 * site link that carries a session or a credential is left out of the cursor, so the next call
 * reaches that page by its number. The host signs `next_cursor` and fills
 * `next_cursor_expires_at` after the run. `readList` calls it for you.
 */
export const finishList = <Row>(
  list: ListStart,
  page: {
    readonly rows: readonly Row[];
    readonly keyOf: (row: Row) => string;
    readonly next: ListPosition | null;
    readonly hasMore: boolean;
    readonly totalResults: number | null;
    readonly listChanged: boolean;
    readonly context?: string;
  },
): ListOutput => {
  if (page.rows.length > list.limit)
    throw new OperationFailure(
      `finishList got ${page.rows.length} rows for a limit of ${list.limit}; return at most limit rows`,
      { dispatch: "unknown" },
    );
  const fields = {
    next_cursor_expires_at: null,
    has_more: page.hasMore || page.next !== null,
    total_results: page.totalResults,
    list_changed: page.listChanged,
  };
  const ended = (reason: ListCursorUnavailable): ListOutput => ({
    next_cursor: null,
    ...fields,
    has_more: true,
    next_cursor_unavailable: reason,
  });
  if (page.next === null) return { next_cursor: null, ...fields };
  // A site link that carries a session or a credential stays out of the cursor; the page number
  // reaches the same page after the next call signs in.
  const next = withoutSession(page.next);
  if (
    page.rows.length === 0 &&
    list.position !== undefined &&
    samePosition(next, list.position)
  )
    return ended("no_progress");
  if (!reachable(next)) return ended("depth_cap");
  if (!fits(next)) return ended("position_too_long");
  if (!list.signed) return ended("unsigned_host");
  const digests = page.rows.map((row) => listDigest(page.keyOf(row)));
  const anchor = digests.at(-1) ?? list.anchor;
  const seen = digests.length > 0 ? digests : [...list.seen];
  const context = page.context === undefined ? list.context : listDigest(page.context);
  const draft = Schema.decodeUnknownEither(ListDraft)({
    m: list.mechanism,
    pos: next,
    n: Math.min(list.returned + page.rows.length, countMax),
    ...(anchor === undefined ? {} : { a: anchor }),
    s: seen.slice(-listSeenMax),
    ...(context === undefined ? {} : { cx: context }),
  });
  if (Either.isLeft(draft)) {
    // Within each field's length, a position can still be too large as a whole.
    const positionValid = Either.isRight(Schema.decodeUnknownEither(ListPosition)(next));
    if (positionValid) return ended("position_too_long");
    throw new OperationFailure(
      `finishList got a next position that is not one: ${String(draft.left.message).slice(0, 500)}`,
      { dispatch: "unknown" },
    );
  }
  return { next_cursor: encodeListDraft(draft.right), ...fields };
};

/**
 * One segment of a list as a reader reads it: a site page (`pages`, `next_link`), one response of
 * the page's own list API (`api`), or the whole list as it stands after some "Load more" steps or
 * scrolls (`append`, `scroll`) or on its one page (`offset`). `rows` are its rows in the site's
 * order from its first row, up to the count asked for.
 */
export interface ListSegment<Row> {
  readonly rows: readonly Row[];
  /** Whether the segment shows rows past the ones read, such as the rest of a site page. */
  readonly more: boolean;
  /**
   * Whether another segment follows: a Next link, a "Load more" control still offered, rows still
   * to scroll to, or the API's next token.
   */
  readonly hasNext: boolean;
  /** The site's own link to this segment, exactly as the run read it (`pages`, `next_link`). */
  readonly href?: string;
  /** The site's own token, page or offset that fetched this segment (`api`); none for the first. */
  readonly token?: string;
  /** A list scope the site applies by its own value, such as a year or a tab. */
  readonly scope?: string;
  /** The site's own exact count of results, when it shows one. */
  readonly totalResults?: number | null;
  /** A context the site applied that the caller did not set, such as a location it chose. */
  readonly context?: string;
}

/**
 * How `readList` reads a site's list. Each function does one site action and reads; `readList`
 * decides which to call, how many rows to ask for and where the next call starts.
 */
export interface ListReader<Row, Segment extends ListSegment<Row>> {
  /** A row's stable key, such as its ID; a promoted copy gets its own, such as `sponsored:` + ID. */
  readonly keyOf: (row: Row) => string;
  /**
   * Reaches where this call starts and reads the first `count` rows of that segment. On a first
   * page `position` is undefined: start the list as the first call always does, such as running
   * the search. On a later page, the host has already started this run as it started the first
   * one and signed it in when the tool signs in; then follow the position: open its `href`
   * (`pages`, `next_link`) and read back that it shows the same list, else start the list and
   * follow Next to its `page`; fetch its `token` (`api`); or start the list and repeat the "Load
   * more" click or scroll `steps` times (`append`, `scroll`). For `append` and `scroll`, `count`
   * counts the rows of the whole list.
   */
  readonly open: (position: ListPosition | undefined, count: number) => Promise<Segment>;
  /** Reads the open segment again for its first `count` rows, without navigating or acting. */
  readonly more?: (segment: Segment, count: number) => Promise<Segment>;
  /**
   * Moves on from `segment`, the last one read, and reads the first `count` rows of the next: opens
   * the next site page, fetches the API's next response, or takes one more "Load more" step or
   * scroll, after which `count` counts the rows of the whole list.
   */
  readonly next?: (segment: Segment, count: number) => Promise<Segment>;
  /** The run's time left; with `readOnMs` or less left, the call returns what it read. */
  readonly remainingMs?: () => number;
  /** The time reading on needs. Default 5 s. */
  readonly readOnMs?: number;
}

/** A list read as one growing document: the segment after a step holds every row before it too. */
const growing = (mechanism: ListMechanism) =>
  mechanism === "append" || mechanism === "scroll" || mechanism === "offset";

/**
 * Reads one call's page of a list and writes its output fields: from where the position starts,
 * it reads exactly the rows the window needs, reads the rest of a segment or moves on to the next
 * while rows are lacking, within `listCallBounds` and the run's time, and returns at most `limit`
 * rows. The call's page size and the site's need not match: a window can end inside a segment,
 * span two or more, or end on a short last one. The next position names the segment that holds
 * the last returned row (the site page and its link, the API token, or the fewest steps that load
 * it) and the offset after that row within it, so the next call reaches that segment again and
 * resumes there. Rows inserted or removed in between keep the anchor's guarantees: no row
 * repeated, none skipped, and `list_changed` when the anchor is gone. A list that stops growing
 * while the site still offers more stops this call with `has_more` true.
 */
export const readList = async <Row, Segment extends ListSegment<Row>>(
  list: ListStart,
  reader: ListReader<Row, Segment>,
): Promise<{ readonly rows: Row[]; readonly output: ListOutput }> => {
  const whole = growing(list.mechanism);
  const start = list.position;
  const segments: Segment[] = [await reader.open(start, (start?.offset ?? 0) + list.limit)];
  const rowsRead = () =>
    whole ? (segments.at(-1)?.rows ?? []) : segments.flatMap((segment) => segment.rows);
  const context = () => segments.find((segment) => segment.context !== undefined)?.context;
  const pick = () => {
    const applied = context();
    return pickRows(
      list,
      rowsRead(),
      reader.keyOf,
      applied === undefined ? {} : { context: applied },
    );
  };
  // The reads after the first: one per site page or API response, or one per step.
  const budget = whole ? listCallBounds.steps : listCallBounds.sitePages - 1;
  const timeLeft = () =>
    reader.remainingMs === undefined || reader.remainingMs() > (reader.readOnMs ?? 5_000);
  let picked = pick();
  for (let reads = 0; picked.indices.length < list.limit && reads < budget && timeLeft(); reads++) {
    const last = segments.at(-1);
    if (last === undefined) break;
    const lacking = list.limit - picked.indices.length;
    if (last.more) {
      // Rows of this segment still unread come before the next one.
      if (reader.more === undefined) break;
      const reread = await reader.more(last, last.rows.length + lacking);
      segments[segments.length - 1] = reread;
      if (reread.rows.length <= last.rows.length) break;
    } else if (last.hasNext) {
      if (reader.next === undefined) break;
      const following = await reader.next(last, whole ? last.rows.length + lacking : lacking);
      segments.push(following);
      // A list that did not grow after a step stalls while the site still offers more.
      if (whole && following.rows.length <= last.rows.length) break;
    } else break;
    picked = pick();
  }
  picked = pick();
  const read = rowsRead();
  const results = picked.indices.slice(0, list.limit).flatMap((index) => {
    const row = read[index];
    return row === undefined ? [] : [row];
  });
  // The segment that holds the last returned row, else the anchor the call started from: the
  // fewest steps that load it, or the last site page or response that shows it.
  const lastIndex = picked.indices[results.length - 1];
  const anchor =
    lastIndex === undefined
      ? list.anchor
      : listDigest(reader.keyOf(read[lastIndex] as Row));
  const digests = segments.map((segment) =>
    segment.rows.map((row) => listDigest(reader.keyOf(row))),
  );
  let at = segments.length - 1;
  let offset = segments.at(-1)?.rows.length ?? 0;
  if (!whole && lastIndex !== undefined) {
    let before = 0;
    at = segments.findIndex((segment) => {
      if (lastIndex < before + segment.rows.length) return true;
      before += segment.rows.length;
      return false;
    });
    offset = lastIndex - before + 1;
  } else if (anchor !== undefined) {
    const found = whole
      ? digests.findIndex((keys) => keys.includes(anchor))
      : digests.findLastIndex((keys) => keys.includes(anchor));
    if (found >= 0) {
      at = found;
      offset = (digests[found] ?? []).lastIndexOf(anchor) + 1;
    }
  }
  const last = segments.at(-1);
  const hasMore =
    picked.indices.length > results.length || last?.more === true || last?.hasNext === true;
  const segment = segments[at];
  const scope = segment?.scope ?? start?.scope;
  const page = (start?.page ?? 1) + at;
  const position = (): ListPosition => {
    const common = { offset, ...(scope === undefined ? {} : { scope }) };
    switch (list.mechanism) {
      case "pages":
      case "next_link":
        return { page, ...common, ...(segment?.href === undefined ? {} : { href: segment.href }) };
      case "api":
        return {
          page,
          ...common,
          ...(segment?.token === undefined ? {} : { token: segment.token }),
        };
      case "append":
      case "scroll":
        return { steps: (start?.steps ?? 0) + at, ...common };
      case "offset":
        return common;
    }
  };
  const applied = context();
  return {
    rows: results,
    output: finishList(list, {
      rows: results,
      keyOf: reader.keyOf,
      next: hasMore ? position() : null,
      hasMore,
      totalResults: segments[0]?.totalResults ?? null,
      listChanged: picked.listChanged,
      ...(applied === undefined ? {} : { context: applied }),
    }),
  };
};
