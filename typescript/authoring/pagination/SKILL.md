---
name: pagination
description: Read before settling the schema of any tool that returns a list: page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop.
---

# Return a page and a way to the next

Any tool that returns a list the site can run past one page, such as search results, orders,
statements, messages or reviews, returns one page per call and a cursor for the next. A caller
that wants more calls again with the same inputs and that cursor. No browser stays open between
calls: each call is a fresh run that rebuilds its position from the cursor alone, signed in or
not.

## The contract

Spread `listInputFields` into the input schema's fields and `listOutputFields` into the output
schema's: `limit` (1 to 50, default 20) and `cursor`; `next_cursor`, `next_cursor_expires_at`,
`has_more`, `total_results`, `list_changed` and, when a list with more has no cursor,
`next_cursor_unavailable`. Never rename them or write your own. Return rows
in the site's order; rows the site promotes stay in place, count toward `limit` and carry their
mark as a boolean. `total_results` is the site's own exact count, null when it shows none or an
approximate one. The description says: "Returns up to `limit` results per call (default 20).
When `next_cursor` is not null, call again within ten minutes with the same inputs and `cursor`
set to it for the results that follow. When `list_changed` is true, results may repeat earlier
ones: de-duplicate by key," and names how the site pages and its page size.

## The cursor

The host signs every cursor and checks it before the next run starts: a cursor that is altered,
expired (ten minutes after the call that returned it), from another tool, for other inputs or for
another account never reaches your code. Call `startList(input, { mechanism })` before any
browser work; it gives you `limit` and the position the host checked, and refuses a cursor from
before the tool paged another way. Then let `readList` read the page and write the output fields.
Never write, sign or parse a cursor yourself, and never put page text, a secret or an account's
value into a position; row keys are hashed for you. A cursor's position is readable by whoever
holds it, so it holds only the site's own link, token or scope and the numbers to reach the rows.
A row's key is its stable ID; when the site shows a promoted copy of a row it also lists, give
the copy its own key, such as `sponsored:` and the ID, so both stay.

## Read the page with `readList`

`readList(list, reader)` does the paging; you write only the site actions. It returns
`{ rows, output }`: return `rows` as the list and spread `output` into the result. The reader has
`keyOf` and three functions, each one site action followed by a read of the first `count` rows,
returning a segment: `{ rows, more, hasNext }`, plus `href`, `token`, `scope`, `totalResults` or
`context` when the site gives them.

- `open(position, count)` reaches where this call starts. With no position it starts the list as
  the first call always does, such as running the search. With a position, the host has already
  started the run as it started the first call and signed in when the tool signs in; `open` then
  follows the position to its segment.
- `more(segment, count)` reads the open segment again for more of its rows, without navigating or
  acting.
- `next(segment, count)` moves on to the next segment: the next site page, the list API's next
  response, or one more "Load more" click or scroll.

A segment is one site page (`pages`, `next_link`), one API response (`api`), or the whole list as
it stands after some steps (`append`, `scroll`) or on its one page (`offset`). `rows` start at the
segment's first row; for `append` and `scroll` they are the whole list, so `count` counts it all.
`more` says the segment shows rows past the ones read, and `hasNext` that another segment
follows. Pass `remainingMs` so a call returns what it read before the run's time runs out.

`readList` asks for exactly the rows the window needs, so the call's `limit` and the site's page
size need not match. With `limit` 20 and 30 rows per site page, call one returns site page one's
rows 1 to 20; call two opens site page one again, skips to after row 20, returns rows 21 to 30,
then site page two's rows 1 to 10, exactly 20; call three returns site page two's rows 11 to 30.
With `limit` 50, one call spans two site pages, and a last page shorter than the window ends the
list with `next_cursor` null. The next position names the segment that holds the last returned
row and the offset after it there:

- `pages` and `next_link`: that site page's own link (`href`), as the browser showed it, its
  number (`page`) and the offset. `open` opens the link and reads back that it still shows the
  query, filters, sort and page; when it does not, it starts the list and follows the site's page
  links or Next to that number. Never edit a page number or offset into a URL yourself.
- `api`: the site's own token, page or offset that fetched that response (`token`, none for the
  first), and the offset within it. `open` opens the results page, then calls the endpoint inside
  the page with that token, or, for a position with only a `page`, fetches the responses up to
  that page. Keep the visible mechanism as the fallback when the endpoint refuses or changes.
- `append` and `scroll`: the fewest steps that load that row (`steps`) and its offset in the
  list. `open` starts the list, then repeats the one action `steps` times, waiting for each step's
  rows with `waitForRows`, the click or scroll as its `action`.
- `offset`: the whole list is on one page; the position's `offset` is where the next window
  starts.

## Find how the site pages

While building, scroll to the end of the list for a typical query and note the page links, a
Next link, a "Load more" control, rows that appear as you scroll, and the requests that bring
the next rows. Pick the first that fits, and name it as the mechanism: `api` when the page
fetches rows from its own list endpoint with an offset, page or cursor parameter; `pages` or
`next_link` for numbered page links or a Next link; `append` or `scroll` for a "Load more"
control or rows that load as the list scrolls; `offset` when the whole list is on one page. If
the URL gains a page parameter after a step, the site is paged: use `pages`. The host accepts
only a site link on the tool's site.

For `append` and `scroll`, the control gone or disabled after a step's rows arrived is the end of
the list. A control that hides or disables while a step loads is not: when a step adds no
identified rows, read once more without acting, and report `hasNext` false only if the rows still
did not grow and the control is still gone or disabled. A list that stalls while the control is
still offered has more: `readList` returns the rows read with `has_more` true and a position that
continues, never a null next cursor. On a list that drops earlier rows as it scrolls, collect rows
by key as they show. Never treat a repeated click as safe if it could submit or change anything.

## Changed lists

Lists change between calls. `readList` reads from the segment that holds the last row the
previous call returned, continues after that row wherever it now is, and drops the last 16 rows
returned, which the cursor remembers. Rows inserted above it push the window down: `readList`
reads more of the segment or up to two segments on. Rows removed above it can pull it back into
the previous segment: `readList` reads that segment by its page number when that fits within the
call's reads, counting one read per page, since `open` reaches a page by its number by following
Next from the first page. When neither shows that row or any remembered row, it starts over from
the list's first segment in the same call, repeating rows rather than skipping any. So `open`
must reach a position that has only a `page`, as the mechanisms below say. `list_changed` is
true when anything changed at or above that row: it moved from where the cursor saw it, because
rows were inserted above it (rows the caller never gets) or rows it already got were removed; it
is gone; or a remembered row came back. After a start over, or a page continued from a segment's
first row with no remembered row in sight, later pages can repeat rows returned before the
remembered ones, so `list_changed` stays true on that page and every later page from its cursor:
a caller that needs no repeats de-duplicates by key once `list_changed` is true, as the
description says. On a site with very few rows per page and constant new rows on top, a list can
start over again and again. Rows that change below the last returned row are simply returned.
When the site applied a context the caller did not set, such as a location it picked, return it
as the segment's `context`, so a different one sets `list_changed`. Never promise a snapshot the
site does not keep.

## Stop

`readList` returns as soon as it holds `limit` rows. Per call it reads at most 5 site pages or
API responses, or 10 steps, within `remainingMs()`; when a bound stops it, it returns what it
read with a position that continues; a call the run's time stopped before it read past its
position hands back that same position, which a call with more time continues, and a second such
call in a row ends the list with `no_progress`. `next_cursor` is null, with `has_more` true and
`next_cursor_unavailable` saying why, past the deepest position a tool can rebuild without the
site's link or token (10 site pages or 20 steps, `depth_cap`), when the site's link or token is
too long for a cursor (`position_too_long`), or when a later call returned no rows and its next
position is the one it started from, such as a list that still stalls where the previous call
stopped (`no_progress`), so a caller paging until `has_more` is false still ends. The description
names that depth. When the site refuses its own link or token and the position cannot be
rebuilt, throw `errors.InvalidInput` with `field: "cursor"` and `kind: "site_expired"`. Never
return a position the tool could not follow.

## Wait only for this page's rows

Wait for the list's answer with `waitForOutcome`, then for the key fields of the first `count`
rows with `waitForRows` (core skill): identifier, name and each value the request needs. Do not
wait for rows outside the window, for the whole list to settle or for slots the site fills late; a
slot with no identifier is a placeholder.

## Signed-in lists

The same rules apply under the account the host bound to this run. Every call signs in through
the host before your code runs, page two and later too, so `open` reaches the position on a
signed-in page; after it loads a page, call `ensureSignedIn()`, and open the page again when the
host signed in again. A cursor never carries a credential or session data: the saved profile
restores the sign-in, not a page, a server's cursor, drafts or form state, and a site link that
carries a session, a key or a signature, such as `;jsessionid=`, a `sid`, `api_key` or `token`
parameter or a signed URL, is left out of the cursor, so the next call reaches that page by its
number. A link whose path names the account, such as its ID, is an account's value too: give such
segments no `href`, so the position keeps only the page number, and reach the list from the
site's own navigation. Keep a list's scope, such as a year or tab, in the
segment's `scope` as the site's own value. Never recreate a hold, draft, upload, payment token or
write in order to page.

## A list that fits on one page

Every list tool takes the contract. When the site shows the whole list at once, use `offset`:
`limit` still caps each call, the position's `offset` continues it, and the description says the
site shows the whole list.

## Test it

On a read signed out, run page one, then page two live with the cursor page one returned: page
two continues the order and repeats no row. Where the site's page size is known, try a `limit`
that ends inside a site page and check that page two finishes that page and continues on the
next. Reach a last page, for example with a narrow query, and check that `next_cursor` is null
(testing skill). A signed-in read proves the list with its example alone and reports later pages
as untested. `references/pagination.ts` is a compiling pattern for a paged site with a Next link,
and for a "Show more" list (`readRooms`), both on `readList`; their reads are site logic.
<!-- pomerado:section pagination.cursor-scope:start

## Standalone cursor scope

A logical cursor is not proof of browser or account identity. Validate its supplied query and scope before effects, verify the current page and account context, and reconstruct only a repeatable read when the evidence supports it. Never recreate a write to recover a cursor.

pomerado:section pagination.cursor-scope:end -->
