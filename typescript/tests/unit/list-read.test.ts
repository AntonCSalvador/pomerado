import { describe, expect, it } from "vitest";
import { admitListCursor, listCursorKeys, sealListOutput } from "../../src/runtime/list-cursor.js";
import {
  decodeListDraft,
  readList,
  startList,
  withListHost,
  type ListMechanism,
  type ListPosition,
  type ListReader,
  type ListSegment,
  type ListStart,
} from "../../src/runtime/list-page.js";

// Where each call of a list starts and what it returns when the call's page size and the site's
// differ, for every mechanism. A simulated site serves the rows; each call is a fresh read whose
// position comes from the cursor the previous call returned, sealed and admitted as a host does.

const origin = "https://www.example.test";
const scope = {
  keys: listCursorKeys({ current: { id: "k1", secret: new Uint8Array(32).fill(7) } }),
  operation: "list-tool",
  siteOrigin: origin,
  now: Date.UTC(2026, 0, 5, 12),
};
const ids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `r${from + index}`);

interface Row {
  readonly id: string;
}
/** A segment as the simulated readers return it, with where it sits on the site. */
interface SiteSegment extends ListSegment<Row> {
  readonly at: number;
}

/** A list site: `rows` in its order, `pageSize` rows per site page, API response or step. */
const listSite = (rows: string[], pageSize: number) => {
  const pageOf = (page: number) => rows.slice((page - 1) * pageSize, page * pageSize);
  const hrefOf = (page: number) => `${origin}/s?q=lamps&page=${page}`;
  const separate = (page: number, count: number, token?: string): SiteSegment => {
    const all = pageOf(page);
    return {
      at: page,
      rows: all.slice(0, count).map((id) => ({ id })),
      more: all.length > count,
      hasNext: page * pageSize < rows.length,
      href: hrefOf(page),
      ...(token === undefined ? {} : { token }),
      totalResults: rows.length,
    };
  };
  // The whole list after `steps` "Load more" steps or scrolls.
  const grown = (steps: number, count: number): SiteSegment => {
    const all = rows.slice(0, (steps + 1) * pageSize);
    return {
      at: steps,
      rows: all.slice(0, count).map((id) => ({ id })),
      more: all.length > count,
      hasNext: all.length < rows.length,
    };
  };
  const readers: Record<ListMechanism, ListReader<Row, SiteSegment>> = {
    pages: {
      keyOf: (row) => row.id,
      open: async (position, count) =>
        separate(
          position?.href === undefined
            ? (position?.page ?? 1)
            : Number(new URL(position.href).searchParams.get("page")),
          count,
        ),
      more: async (segment, count) => separate(segment.at, count),
      next: async (segment, count) => separate(segment.at + 1, count),
    },
    next_link: {
      keyOf: (row) => row.id,
      open: async (position, count) =>
        separate(Number(new URL(position?.href ?? hrefOf(1)).searchParams.get("page")), count),
      more: async (segment, count) => separate(segment.at, count),
      next: async (segment, count) => separate(segment.at + 1, count),
    },
    // The API's token is the index its response starts at; the first request sends none.
    api: {
      keyOf: (row) => row.id,
      open: async (position, count) => {
        const page = position?.token === undefined ? 1 : Number(position.token) / pageSize + 1;
        return separate(page, count, page === 1 ? undefined : String((page - 1) * pageSize));
      },
      more: async (segment, count) => separate(segment.at, count, segment.token),
      next: async (segment, count) =>
        separate(segment.at + 1, count, String(segment.at * pageSize)),
    },
    append: {
      keyOf: (row) => row.id,
      open: async (position, count) => grown(position?.steps ?? 0, count),
      more: async (segment, count) => grown(segment.at, count),
      next: async (segment, count) => grown(segment.at + 1, count),
    },
    scroll: {
      keyOf: (row) => row.id,
      open: async (position, count) => grown(position?.steps ?? 0, count),
      more: async (segment, count) => grown(segment.at, count),
      next: async (segment, count) => grown(segment.at + 1, count),
    },
    // The whole list on one page.
    offset: {
      keyOf: (row) => row.id,
      open: async (_position, count) => ({
        at: 0,
        rows: rows.slice(0, count).map((id) => ({ id })),
        more: rows.length > count,
        hasNext: false,
      }),
      more: async (_segment, count) => ({
        at: 0,
        rows: rows.slice(0, count).map((id) => ({ id })),
        more: rows.length > count,
        hasNext: false,
      }),
    },
  };
  return { rows, readers };
};

/** One call: its list from the input and the cursor the host admitted, then its rows and fields. */
const call = async (
  site: ReturnType<typeof listSite>,
  mechanism: ListMechanism,
  limit: number,
  cursor?: string,
) => {
  const input = { query: "lamps", limit, ...(cursor === undefined ? {} : { cursor }) };
  const admitted = admitListCursor(input, scope);
  if (!admitted.ok) throw new Error(`refused: ${admitted.reason}`);
  const list: ListStart = startList(withListHost(input, admitted.list), { mechanism });
  const page = await readList(list, site.readers[mechanism]);
  const draft = decodeListDraft(page.output.next_cursor);
  const sealed = sealListOutput({ rows: page.rows, ...page.output }, input, scope).output as {
    readonly next_cursor: string | null;
  };
  return {
    ids: page.rows.map((row) => row.id),
    output: page.output,
    position: draft?.pos,
    cursor: sealed.next_cursor ?? undefined,
  };
};

const mechanisms: readonly ListMechanism[] = [
  "pages",
  "next_link",
  "api",
  "append",
  "scroll",
  "offset",
];

describe.each(mechanisms)("a %s list read 20 at a time over 30 per segment", (mechanism) => {
  it("continues inside a segment and across into the next, with no gap or repeat", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    expect(first.ids).toEqual(ids(1, 20));
    const second = await call(site, mechanism, 20, first.cursor);
    expect(second.ids).toEqual(ids(21, 40));
    const third = await call(site, mechanism, 20, second.cursor);
    expect(third.ids).toEqual(ids(41, 60));
    for (const page of [first, second, third])
      expect(page.output).toMatchObject({ has_more: true, list_changed: false });
  });

  it("straddles two segments when the call is larger than a segment", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 50);
    expect(first.ids).toEqual(ids(1, 50));
    const second = await call(site, mechanism, 50, first.cursor);
    expect(second.ids).toEqual(ids(51, 95));
    expect(second.output).toMatchObject({ next_cursor: null, has_more: false });
  });

  it("ends on a short last segment", async () => {
    const site = listSite(ids(1, 65), 30);
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await call(site, mechanism, 20, cursor);
      pages.push(page.ids);
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(pages).toEqual([ids(1, 20), ids(21, 40), ids(41, 60), ids(61, 65)]);
  });

  it("keeps the anchor's guarantees when rows are inserted or removed between calls", async () => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    // A row inserted above the last returned row: the next window starts right after that row,
    // here reading the rest of its segment past the rows first asked for.
    site.rows.unshift("new");
    const inserted = await call(site, mechanism, 5, first.cursor);
    expect(inserted.ids).toEqual(ids(21, 25));
    expect(inserted.output.list_changed).toBe(false);
    // A row removed above it: still no gap, no repeat.
    site.rows.splice(site.rows.indexOf("r3"), 1);
    const removed = await call(site, mechanism, 20, inserted.cursor);
    expect(removed.ids).toEqual(ids(26, 45));
    expect(removed.output.list_changed).toBe(false);
    // The last returned row itself removed: no row skipped, and the list says it changed.
    site.rows.splice(site.rows.indexOf("r45"), 1);
    const gone = await call(site, mechanism, 20, removed.cursor);
    expect(gone.ids).toEqual(ids(46, 65));
    expect(gone.output.list_changed).toBe(true);
  });
});

describe("the position a call hands the next", () => {
  const positions = async (mechanism: ListMechanism) => {
    const site = listSite(ids(1, 95), 30);
    const first = await call(site, mechanism, 20);
    const second = await call(site, mechanism, 20, first.cursor);
    return [first.position, second.position] as const;
  };
  const href = (page: number) => `${origin}/s?q=lamps&page=${page}`;

  it.each<readonly [ListMechanism, ListPosition, ListPosition]>([
    ["pages", { page: 1, offset: 20, href: href(1) }, { page: 2, offset: 10, href: href(2) }],
    ["next_link", { page: 1, offset: 20, href: href(1) }, { page: 2, offset: 10, href: href(2) }],
    ["api", { page: 1, offset: 20 }, { page: 2, offset: 10, token: "30" }],
    ["append", { steps: 0, offset: 20 }, { steps: 1, offset: 40 }],
    ["scroll", { steps: 0, offset: 20 }, { steps: 1, offset: 40 }],
    ["offset", { offset: 20 }, { offset: 40 }],
  ])(
    "names the %s segment holding the last returned row and the offset after it",
    async (mechanism, first, second) => {
      expect(await positions(mechanism)).toEqual([first, second]);
    },
  );
});

describe("a list that stops growing while the site still offers more", () => {
  const stalled = (): ListReader<Row, SiteSegment> => {
    const grown = (at: number): SiteSegment => ({
      at,
      rows: ids(1, 2).map((id) => ({ id })),
      more: false,
      hasNext: true,
    });
    return {
      keyOf: (row) => row.id,
      open: async (position) => grown(position?.steps ?? 0),
      next: async (segment) => grown(segment.at + 1),
    };
  };

  it("returns what it read with has_more, and ends the next call that still stalls", async () => {
    const site = { rows: [], readers: { append: stalled() } } as unknown as ReturnType<
      typeof listSite
    >;
    const first = await call(site, "append", 10);
    expect(first.ids).toEqual(ids(1, 2));
    expect(first.output).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
    const second = await call(site, "append", 10, first.cursor);
    expect(second.ids).toEqual([]);
    expect(second.output).toMatchObject({
      next_cursor: null,
      has_more: true,
      next_cursor_unavailable: "no_progress",
    });
  });
});

describe("a site link that carries a session", () => {
  it.each([
    `${origin}/s;jsessionid=A1B2C3?q=lamps&page=1`,
    `${origin}/s?q=lamps&page=1&sid=A1B2C3`,
    `${origin}/s?q=lamps&page=1#access_token=A1B2C3`,
  ])("stays out of the cursor, which reaches the page by its number: %s", async (link) => {
    const site = listSite(ids(1, 95), 30);
    const reader = site.readers.pages;
    const withLink: ListReader<Row, SiteSegment> = {
      ...reader,
      open: async (position, count) => ({ ...(await reader.open(position, count)), href: link }),
    };
    const sessionSite = { ...site, readers: { ...site.readers, pages: withLink } };
    const first = await call(sessionSite, "pages", 20);
    expect(first.position).toEqual({ page: 1, offset: 20 });
    expect(first.cursor).not.toContain("A1B2C3");
    const decoded = Buffer.from(String(first.cursor).split(".")[2] ?? "", "base64url").toString();
    expect(decoded).not.toContain("A1B2C3");
    expect((await call(site, "pages", 20, first.cursor)).ids).toEqual(ids(21, 40));
  });
});
