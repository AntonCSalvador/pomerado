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
 * The most row-key digests a cursor keeps from the rows returned before it: the last rows
 * returned, across calls, which is what a later page needs to drop rows it already returned and
 * to find its place when the last returned row is gone.
 */
export const listSeenMax = 16;
/**
 * The most bytes a draft's JSON may take. With the host's own fields and signature added, any
 * draft within it seals into a cursor no longer than `listCursorMaxLength`.
 */
export const listDraftMaxBytes = 1_360;
/**
 * The most calls in a row the run's time may stop at the same position before it read past it.
 * The next one that stops there ends the list with `no_progress`, so a caller paging until
 * `has_more` is false still ends when every run's time runs out before it reads.
 */
const listTimeStopsMax = 1;
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
 * far, the anchor (the last returned row's key digest), the digests of the last rows returned,
 * the digest of the context the site applied, how many calls in a row the run's time stopped at
 * this position (`t`), and whether the anchor lies before the position's segment, which a call
 * that stepped back without finding it hands on (`b`). The host adds the tool, the inputs'
 * digest, the caller it was issued to and the expiry, and signs it. Its JSON is at most
 * `listDraftMaxBytes`.
 */
export const listDraftFields = {
  m: ListMechanism,
  pos: ListPosition,
  n: Count,
  a: Schema.optional(Digest),
  s: Schema.Array(Digest).pipe(Schema.maxItems(listSeenMax)),
  cx: Schema.optional(Digest),
  t: Schema.optional(Schema.Int.pipe(Schema.between(1, listTimeStopsMax))),
  b: Schema.optional(Schema.Literal(1)),
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
        "Why next_cursor is null although has_more is true: depth_cap past the deepest page this tool can reach again, no_progress when this call returned no results and could not move past the cursor's position, or the run's time stopped it there twice in a row, position_too_long when the site's link to the next page is too long for a cursor, off_site when it leaves the site, or the host could not sign one.",
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
  /** How many calls in a row before this one the run's time stopped at this position. */
  readonly timeStops: number;
  /** Whether the anchor lies before the position's segment: the call steps back to find it. */
  readonly lookingBack: boolean;
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
    return {
      limit,
      mechanism: options.mechanism,
      returned: 0,
      seen: new Set(),
      timeStops: 0,
      lookingBack: false,
      signed,
    };
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
    timeStops: draft.t ?? 0,
    lookingBack: draft.b === 1,
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
    // A site token that starts right after the anchor (offset 0) reads rows that cannot hold it.
    const pastAnchor = position.token !== undefined && position.offset === 0;
    const anchor = list.anchor === undefined ? -1 : digests.lastIndexOf(list.anchor);
    if (anchor >= 0) {
      start = anchor + 1;
      // The anchor moved from where the cursor saw it: rows were inserted or removed above it.
      // An inserted row is one the caller never gets, and a removed one is gone from rows it got.
      if (!pastAnchor && anchor !== position.offset - 1) changed = true;
    } else {
      // The anchor is gone: continue after the last returned row still here, so a removal
      // repeats rows rather than skipping them. A position names the segment that holds the
      // anchor, so its absence there is a change.
      const lastSeen = digests.findLastIndex((digest) => list.seen.has(digest));
      start = lastSeen + 1;
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
 * rows the previous page returned and any key twice. `listChanged` is true when anything changed
 * at or above the anchor: it moved from the offset the cursor saw it at (rows were inserted or
 * removed above it), it is gone, a returned row came back, or the context the site applied (such
 * as a location it chose) differs. Rows that changed below the anchor are simply returned. A
 * position whose site `token` starts right after the anchor (offset 0) reads rows that cannot
 * hold it, so there the anchor's absence is no change. It only sees `rows`: finding an anchor
 * that moved into another segment is `readList`'s work. A key is the row's stable ID; give a
 * promoted copy of a row its own key, such as `sponsored:` plus the ID, to keep both. `readList`
 * calls it for you.
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

/** Parameter names that carry a session, a credential or a URL signature, compared without case. */
const sessionParameter =
  /^(?:j?sessionid|session_?(?:id|token|key)|php_?sessid|sessid|aspsessionid\w*|sid|cfid|cftoken|access_?token|id_?token|auth_?token|authenticity_?token|csrf_?token|token|api_?key|password|passwd|sig|signature|x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential))$/iu;

/** An ASP.NET cookieless session path segment, such as `(S(a1b2c3))`. */
const cookielessSegment = /^\((?:[A-Z]\([^()]*\))+\)$/u;

/**
 * Whether a site link carries a session, a credential or a signature: a user name or password, a
 * path parameter such as `;jsessionid=`, a cookieless session path segment, or such a parameter
 * in its query or fragment. A cursor never carries one: the next call signs in through the host
 * instead.
 */
const carriesSession = (href: string) => {
  const url = URL.parse(href);
  if (url === null) return false;
  if (url.username !== "" || url.password !== "") return true;
  const segments = url.pathname.split("/");
  if (segments.some((segment) => cookielessSegment.test(segment))) return true;
  const names = [
    ...segments
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
 * call that the run's time stopped before it could read past its position passes `bounded`: its
 * next cursor then holds the same position, since a call with more time continues there, unless
 * the call before it stopped there the same way, when the list ends with `no_progress`. A
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
    /** The run's time stopped this call before it read past its position; not a stall. */
    readonly bounded?: boolean;
    /** The last returned row lies before `next`'s segment; the next call steps back to find it. */
    readonly lookingBack?: boolean;
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
  // A call that read nothing past its position stalls. A call the run's time stopped there does
  // not, unless the calls before it stopped there the same way.
  const stopped =
    page.rows.length === 0 && list.position !== undefined && samePosition(next, list.position);
  const timeStops = stopped && page.bounded === true ? list.timeStops + 1 : 0;
  if (stopped && (page.bounded !== true || timeStops > listTimeStopsMax))
    return ended("no_progress");
  if (!reachable(next)) return ended("depth_cap");
  if (!fits(next)) return ended("position_too_long");
  if (!list.signed) return ended("unsigned_host");
  const digests = page.rows.map((row) => listDigest(page.keyOf(row)));
  const anchor = digests.at(-1) ?? list.anchor;
  // The last rows returned across calls, this call's last.
  const seen = [...[...list.seen].filter((digest) => !digests.includes(digest)), ...digests];
  const context = page.context === undefined ? list.context : listDigest(page.context);
  const draft = Schema.decodeUnknownEither(ListDraft)({
    m: list.mechanism,
    pos: next,
    n: Math.min(list.returned + page.rows.length, countMax),
    ...(anchor === undefined ? {} : { a: anchor }),
    s: seen.slice(-listSeenMax),
    ...(context === undefined ? {} : { cx: context }),
    ...(timeStops === 0 ? {} : { t: timeStops }),
    ...(page.lookingBack === true ? { b: 1 } : {}),
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
   * follow Next to its `page`; fetch its `token` (`api`), else fetch the responses up to its
   * `page`; or start the list and repeat the "Load more" click or scroll `steps` times (`append`,
   * `scroll`). A position with only a `page` is also how `readList` reads an earlier segment
   * whole, asking for up to 1,000 rows. For `append` and `scroll`, `count` counts the rows of the
   * whole list.
   */
  readonly open: (position: ListPosition | undefined, count: number) => Promise<Segment>;
  /**
   * Reads the open segment again for its first `count` rows, without navigating or acting. To
   * read the rest of a segment, `readList` asks for at least 1,000 rows, or the rows read so far
   * plus a window when that is more.
   */
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

/** How many segments past the opened one readList looks for an anchor no remembered row shows. */
const blindSegments = 2;

/** The most rows readList asks a reader for when it reads a whole segment. */
const segmentRowsMax = 1_000;

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
 * resumes after that row wherever it now is, dropping the rows the cursor remembers.
 *
 * When the segment a later page opens (`pages`, `next_link`, `api`) shows neither that row nor any
 * row the cursor remembers, rows removed above may have pulled them back, or rows inserted above
 * pushed them on. It reads the previous segment by its page number, then up to two segments on,
 * then earlier segments one at a time, all within the call's reads, and sets `list_changed` when
 * it found them in an earlier segment. When none shows them, it returns no rows with `has_more`
 * true and a position at the earliest segment it read, so the next call looks back from there;
 * at the first segment, it continues from the list's first row. So when the list changes only by
 * removals of rows the caller got, and one row the cursor remembers stays, no row is repeated or
 * skipped. Rows inserted above are rows the caller never gets, and a burst that pushes every
 * remembered row further on than it looks repeats rows. A list that stops growing while the site
 * still offers more stops this call with `has_more` true. A call the run's time stopped before it
 * read past its position hands back that same position, and a second such call in a row ends the
 * list with `no_progress`.
 */
export const readList = async <Row, Segment extends ListSegment<Row>>(
  list: ListStart,
  reader: ListReader<Row, Segment>,
): Promise<{ readonly rows: Row[]; readonly output: ListOutput }> => {
  const whole = growing(list.mechanism);
  const start = list.position;
  const anchor = list.anchor;
  // The page number of the first segment read, which a step back lowers.
  let base = start?.page ?? 1;
  let segments: Segment[] = [await reader.open(start, (start?.offset ?? 0) + list.limit)];
  const rowsRead = () =>
    whole ? (segments.at(-1)?.rows ?? []) : segments.flatMap((segment) => segment.rows);
  const digestsOf = (rows: readonly Row[]) => rows.map((row) => listDigest(reader.keyOf(row)));
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
  let reads = 0;
  let outOfTime = false;
  const timeLeft = () => {
    if (reader.remainingMs === undefined || reader.remainingMs() > (reader.readOnMs ?? 5_000))
      return true;
    outOfTime = true;
    return false;
  };
  // Whether the call looks for the anchor at all: a later page whose position does not start
  // right after it.
  const tracking =
    start !== undefined &&
    anchor !== undefined &&
    !(start.token !== undefined && start.offset === 0);
  const inSight = (rows: readonly Row[]) =>
    digestsOf(rows).some((digest) => digest === anchor || list.seen.has(digest));
  // A step back found the anchor or a returned row in an earlier segment.
  let steppedBack = false;
  // Stepping back reached the first segment and found neither: the call starts the list over.
  let restarted = false;
  // The earliest segment a step back read that shows neither, and its page number.
  let earliest: { readonly page: number; readonly segment: Segment } | undefined;
  // Neither the anchor nor any returned row is in sight, and an earlier segment may hold them.
  const lost = () =>
    tracking && !whole && !restarted && (start?.page ?? 1) > 1 && !inSight(rowsRead());
  let blind = 0;
  // Whether the anchor may lie further on: it is not among the rows read, and no row returned
  // before is either, or those rows run to the last row read. Rows inserted above the anchor push
  // it on, maybe past the segment the position names; once a returned row is followed by rows
  // never returned, the anchor is gone instead. With no returned row in sight at all, it looks at
  // most `blindSegments` segments on, unless an earlier call already did and handed on the look
  // back.
  const seeking = () => {
    if (!tracking) return false;
    const keys = digestsOf(rowsRead());
    if (anchor !== undefined && keys.includes(anchor)) return false;
    const lastSeen = keys.findLastIndex((key) => list.seen.has(key));
    if (lastSeen >= 0) return lastSeen === keys.length - 1;
    return !steppedBack && !restarted && !list.lookingBack && blind < blindSegments;
  };
  const readOn = async () => {
    let picked = pick();
    for (;;) {
      const looking = seeking();
      if (!looking && (picked.indices.length >= list.limit || lost())) return;
      const last = segments.at(-1);
      if (last === undefined || !(last.more || last.hasNext) || reads >= budget) return;
      if (!timeLeft()) return;
      // Looking for the anchor reads a segment at least as large as the last one.
      const lacking = looking
        ? Math.max(list.limit, last.rows.length)
        : list.limit - picked.indices.length;
      reads++;
      if (last.more) {
        // Rows of this segment still unread come before the next one; looking for the anchor
        // reads the rest of them at once.
        if (reader.more === undefined) return;
        const reread = await reader.more(
          last,
          looking
            ? Math.max(segmentRowsMax, last.rows.length + lacking)
            : last.rows.length + lacking,
        );
        segments[segments.length - 1] = reread;
        if (reread.rows.length <= last.rows.length) return;
      } else {
        if (reader.next === undefined) return;
        if (looking) blind++;
        const following = await reader.next(last, whole ? last.rows.length + lacking : lacking);
        segments.push(following);
        // A list that did not grow after a step stalls while the site still offers more.
        if (whole && following.rows.length <= last.rows.length) return;
      }
      picked = pick();
    }
  };
  // One read of an earlier segment, whole, by its page number.
  const readBack = async (page: number) => {
    reads++;
    return reader.open(
      {
        page,
        offset: 0,
        ...(start?.scope === undefined ? {} : { scope: start.scope }),
      },
      segmentRowsMax,
    );
  };
  const opened = segments[0];
  if (lost() && opened?.more === true && reader.more !== undefined && timeLeft()) {
    // The rest of the opened segment first: rows inserted above may have pushed them down it.
    reads++;
    segments = [await reader.more(opened, Math.max(segmentRowsMax, opened.rows.length))];
  }
  if (lost() && reads < budget && timeLeft()) {
    // Removals above pull the anchor back into the previous segment more often than new rows
    // push every remembered row a whole segment on, so that segment is read next.
    const back = await readBack(base - 1);
    if (inSight(back.rows)) {
      steppedBack = true;
      base--;
      segments = back.more ? [back] : [back, ...segments];
    } else earliest = { page: base - 1, segment: back };
  }
  await readOn();
  // Rows removed above pulled them back further: earlier segments, one at a time.
  while (lost() && earliest !== undefined && reads < budget && timeLeft()) {
    if (earliest.page <= 1) break;
    const page = earliest.page - 1;
    const back = await readBack(page);
    if (inSight(back.rows)) {
      steppedBack = true;
      base = page;
      segments = [back];
      earliest = undefined;
      await readOn();
    } else earliest = { page, segment: back };
  }
  if (lost() && earliest !== undefined && earliest.page <= 1) {
    // No returned row is left back to the first segment: start the list over from its first row.
    restarted = true;
    base = 1;
    segments = [earliest.segment];
    earliest = undefined;
    await readOn();
  }
  const applied = context();
  const totalResults = segments[0]?.totalResults ?? null;
  const positionOf = (segment: Segment | undefined, page: number, offset: number): ListPosition => {
    const scope = segment?.scope ?? start?.scope;
    const common = { offset, ...(scope === undefined ? {} : { scope }) };
    switch (list.mechanism) {
      case "pages":
      case "next_link":
        return {
          page,
          ...common,
          ...(segment?.href === undefined ? {} : { href: segment.href }),
        };
      case "api":
        return {
          page,
          ...common,
          ...(segment?.token === undefined ? {} : { token: segment.token }),
        };
      case "append":
      case "scroll":
        return { steps: (start?.steps ?? 0) + page - base, ...common };
      case "offset":
        return common;
    }
  };
  // Stepping back found neither within the call's reads: no rows, and a position at the
  // earliest segment read, which the next call opens and looks back from.
  if (lost() && earliest !== undefined)
    return {
      rows: [],
      output: finishList(list, {
        rows: [],
        keyOf: reader.keyOf,
        next: positionOf(
          earliest.segment,
          earliest.page,
          Math.max(1, earliest.segment.rows.length),
        ),
        hasMore: true,
        totalResults,
        listChanged: true,
        ...(applied === undefined ? {} : { context: applied }),
        lookingBack: true,
      }),
    };
  // The run's time ran out before this call read past its position, before it found the anchor
  // rows inserted above pushed further on, or before it could look back: the next call continues
  // from the same position.
  if (
    start !== undefined &&
    (lost() ||
      (outOfTime && !steppedBack && !restarted && (pick().indices.length === 0 || seeking())))
  )
    return {
      rows: [],
      output: finishList(list, {
        rows: [],
        keyOf: reader.keyOf,
        next: start,
        hasMore: true,
        totalResults,
        listChanged: pick().listChanged || list.lookingBack,
        ...(applied === undefined ? {} : { context: applied }),
        bounded: true,
        lookingBack: list.lookingBack,
      }),
    };
  const picked = pick();
  const read = rowsRead();
  const keys = digestsOf(read);
  const results = picked.indices.slice(0, list.limit).flatMap((index) => {
    const row = read[index];
    return row === undefined ? [] : [row];
  });
  // The segment that holds the last returned row, else the row the call resumed after: the
  // fewest steps that load it, or the last site page or response that shows it.
  const lastIndex = picked.indices[results.length - 1];
  let at = segments.length - 1;
  let offset = segments.at(-1)?.rows.length ?? 0;
  if (!whole) {
    const resume =
      lastIndex ??
      (anchor !== undefined && keys.includes(anchor)
        ? keys.lastIndexOf(anchor)
        : keys.findLastIndex((key) => list.seen.has(key)));
    if (resume >= 0) {
      let before = 0;
      at = segments.findIndex((segment) => {
        if (resume < before + segment.rows.length) return true;
        before += segment.rows.length;
        return false;
      });
      offset = resume - before + 1;
    }
  } else {
    const last = lastIndex === undefined ? anchor : keys[lastIndex];
    const digests = segments.map((segment) => digestsOf(segment.rows));
    const found = last === undefined ? -1 : digests.findIndex((digest) => digest.includes(last));
    if (last !== undefined && found >= 0) {
      at = found;
      offset = (digests[found] ?? []).lastIndexOf(last) + 1;
    }
  }
  const last = segments.at(-1);
  const hasMore =
    picked.indices.length > results.length || last?.more === true || last?.hasNext === true;
  return {
    rows: results,
    output: finishList(list, {
      rows: results,
      keyOf: reader.keyOf,
      next: hasMore ? positionOf(segments[at], base + at, offset) : null,
      hasMore,
      totalResults,
      listChanged: picked.listChanged || steppedBack || restarted || list.lookingBack,
      ...(applied === undefined ? {} : { context: applied }),
    }),
  };
};
