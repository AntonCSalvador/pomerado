import { isCredentialAssignmentKey } from "./credential-policy.js";

/**
 * URL spans that screening must leave byte-exact. By user decision every part of a URL (scheme,
 * username, host, path, query, fragment, nested URLs) stays raw in all readable, stored and log
 * copies, because browser navigation and HTTP requests need the whole URL. Nothing inside these
 * spans is masked, aliased or registered.
 *
 * So a URL must end where it really ends, or the text glued to it escapes screening. A URL runs
 * to the next space, quote or angle bracket and loses trailing sentence punctuation, and ends
 * earlier at:
 * - an unbalanced `)`, `]` or `}` (balanced ones, as in `/wiki/Foo_(bar)`, stay, trimming
 *   included);
 * - a backslash escape other than `\/`, `\u` or `\x`;
 * - the field separator written just before it: a `,` or `;` touching it, or a `|` across spaces,
 *   as in a CSV row or a table, unless the `;` closes a character reference such as `&amp;`;
 * - a `|` outside the query, or in it before an empty segment;
 * - a `,`, `;` or `|` whose next field holds an `@`, a long number (9 to 19 digits), a date or a
 *   capitalized name of two or more words, or whose `key=` value does;
 * - a `,` outside the query that starts a `key=`, or a `;` outside the query that starts a
 *   credential-named `key=` (`;password=…`); other matrix parameters, such as `;v=1`, stay.
 *
 * A URL found inside another never extends it. The rules read a bounded window at each
 * delimiter, so the scan stays linear. When a case is ambiguous the URL ends: the text after it
 * is only screened like any other text.
 */
export interface UrlSpan {
  readonly start: number;
  readonly end: number;
}

const trailingProse = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "\\"]);
const terminator = /[\s"'`<>]/u;

/** A URL candidate's end without the sentence punctuation after it, by a scan back to `floor`. */
const trimmedEnd = (text: string, floor: number, end: number) => {
  let trimmed = end;
  while (trimmed > floor && trailingProse.has(text[trimmed - 1] ?? "")) trimmed--;
  return trimmed;
};

const schemeRelativeHost = (candidate: string) => {
  const authority = candidate.slice(2).split(/[/?#\\]/u)[0] ?? "";
  return authority.includes(".") || authority.includes("@") || /:\d+$/u.test(authority);
};

// Where each kind of URL starts; `urlEnd` finds where it ends. Scheme URLs (JSON-escaped
// `https:\/\/` included) and schemeless `www.` hosts. The scheme is bounded, so each position
// costs a fixed amount and the scan is linear.
const absoluteStart =
  /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)|www\.)(?=[^\s"'`<>])/giu;
const schemeRelativeStart = /(?<![A-Za-z0-9+.:/\\-])\/\/(?=[^\s"'`<>])/gu;

const openers = "([{";
const closers = ")]}";

/** The `;` at `index` ends a character reference such as `&amp;`, `&#38;` or `&#x26;`. */
const endsEntity = (text: string, index: number) =>
  /&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6})$/iu.test(
    text.slice(Math.max(0, index - 9), index),
  );

/** The field separator written just before a URL: `,` or `;` touching it, or `|` across spaces. */
const separatorBefore = (text: string, start: number) => {
  const before = text[start - 1];
  if (before === "," || (before === ";" && !endsEntity(text, start - 1))) return before;
  let index = start - 1;
  while (index >= Math.max(0, start - 16) && (text[index] === " " || text[index] === "\t")) index--;
  return text[index] === "|" ? "|" : undefined;
};

/**
 * A long number: 9 to 19 digits with only phone or card punctuation between, as a phone, card,
 * account or identity number is written.
 */
const isLongNumber = (value: string) => {
  const run = /^\+?\(?\d[\d ().-]*/u.exec(value)?.[0] ?? "";
  const digits = run.replace(/\D/gu, "").length;
  return digits >= 9 && digits <= 19;
};

/** A field value that belongs to a person: a long number, a date or a name of two or more words. */
const personalValue = (value: string) =>
  isLongNumber(value) ||
  /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?!\d)/u.test(value) ||
  /^\p{Lu}[\p{L}'’.-]* \p{Lu}/u.test(value);

const nextField = /[^\r\n,;|"'`<>]{0,64}/uy;

/**
 * The field after the delimiter at `index`, to the next delimiter or line end and at most 64
 * characters; its first segment, to a space or a URL delimiter; and the key of the `key=` that
 * starts it.
 */
const fieldAfter = (text: string, index: number) => {
  nextField.lastIndex = index + 1;
  const field = nextField.exec(text)?.[0] ?? "";
  const segment = /^[^\s&/?#]*/u.exec(field)?.[0] ?? "";
  return { field, segment, key: /^([A-Za-z_][\w.-]*)=/u.exec(segment)?.[1] };
};

/** What follows a delimiter is a new field, not more of the URL. */
const startsField = (text: string, index: number, delimiter: string, query: boolean) => {
  const { field, segment, key } = fieldAfter(text, index);
  if (field === "") return delimiter === "|";
  const value = key === undefined ? field : field.slice(key.length + 1);
  if (segment.includes("@") || personalValue(value)) return true;
  if (delimiter === "|") return !query || segment === "";
  if (query || key === undefined) return false;
  return delimiter === "," || isCredentialAssignmentKey(key);
};

/** A URL scan's state: open bracket counts, whether it is past `?` or `#`, and the trim floor. */
interface Scan {
  readonly depths: number[];
  query: boolean;
  floor: number;
}

/** The bracket at `index` ends the URL: an unbalanced closer. A balanced one raises the floor. */
const bracketEnds = (scan: Scan, character: string, index: number) => {
  const opened = openers.indexOf(character);
  if (opened !== -1) scan.depths[opened] = (scan.depths[opened] ?? 0) + 1;
  const closed = closers.indexOf(character);
  if (closed === -1) return false;
  if ((scan.depths[closed] ?? 0) === 0) return true;
  scan.depths[closed] = (scan.depths[closed] ?? 0) - 1;
  scan.floor = index + 1;
  return false;
};

const isDelimiter = (text: string, index: number, character: string) =>
  character === "," || character === "|" || (character === ";" && !endsEntity(text, index));

/** The URL ends at `index`, by the rules above. */
const endsAt = (text: string, index: number, scan: Scan, separator: string | undefined) => {
  const character = text[index] ?? "";
  if (terminator.test(character)) return true;
  // A backslash escape other than JSON's `\/` (or a script's `&` and `\x26`) is a line
  // break, a tab or a quote written in a string: the URL ends before it.
  if (character === "\\" && !"/ux".includes(text[index + 1] ?? " ")) return true;
  if (character === "?" || character === "#") scan.query = true;
  if (bracketEnds(scan, character, index)) return true;
  return (
    isDelimiter(text, index, character) &&
    (character === separator || startsField(text, index, character, scan.query))
  );
};

/**
 * Where the URL whose text starts at `bodyStart` ends (`end`, trailing punctuation trimmed) and
 * where its scan stopped (`stop`). `start` is where the URL itself starts.
 */
const urlEnd = (text: string, start: number, bodyStart: number) => {
  const separator = separatorBefore(text, start);
  const scan: Scan = { depths: [0, 0, 0], query: false, floor: start };
  let index = bodyStart;
  while (index < text.length && !endsAt(text, index, scan, separator)) index++;
  return { end: trimmedEnd(text, scan.floor, index), stop: index };
};

/**
 * Sorted, disjoint ranges. A range that starts inside an earlier one is dropped: the outer URL's
 * own boundary stands, so a URL found inside it never carries it further.
 */
const disjointRanges = (ranges: UrlSpan[]): UrlSpan[] => {
  ranges.sort((left, right) => left.start - right.start);
  const disjoint: UrlSpan[] = [];
  for (const range of ranges) {
    const last = disjoint.at(-1);
    if (last === undefined || range.start >= last.end) disjoint.push(range);
  }
  return disjoint;
};

/**
 * Every URL in `text`, absolute or scheme-relative, each ending at its real boundary, sorted and
 * disjoint. Each kind's scan resumes where its last URL stopped.
 */
export const urlSpans = (text: string): UrlSpan[] => {
  if (!text.includes("/") && !/www\./iu.test(text)) return [];
  const ranges: UrlSpan[] = [];
  const scan = (pattern: RegExp, accept: (url: string) => boolean) => {
    const starts = new RegExp(pattern);
    for (let match = starts.exec(text); match !== null; match = starts.exec(text)) {
      const { end, stop } = urlEnd(text, match.index, match.index + match[0].length);
      if (end > match.index && accept(text.slice(match.index, end)))
        ranges.push({ start: match.index, end });
      starts.lastIndex = Math.max(stop, match.index + 1);
    }
  };
  scan(absoluteStart, () => true);
  scan(schemeRelativeStart, schemeRelativeHost);
  return disjointRanges(ranges);
};

// The same starts, each read to the next space, quote or angle bracket.
const absoluteReach =
  /(?<![A-Za-z0-9])(?:[a-z][a-z0-9+.-]{1,31}:(?:\/\/|\\\/\\\/)|www\.)[^\s"'`<>]+/giu;
const schemeRelativeReach = /(?<![A-Za-z0-9+.:/\\-])\/\/[^\s"'`<>]+/gu;

/**
 * Each stretch of text a URL starts, read to the next space, quote or angle bracket and trimmed
 * of sentence punctuation, merged where stretches overlap. This is how far `urlSpans` reached
 * before URLs ended at field delimiters. It is never a screening exemption, only a measure for a
 * bound that must still accept text an older release measured that way.
 */
export const urlReaches = (text: string): UrlSpan[] => {
  if (!text.includes("/") && !/www\./iu.test(text)) return [];
  const ranges: UrlSpan[] = [];
  const add = (start: number, end: number) => {
    const trimmed = trimmedEnd(text, start, end);
    if (trimmed > start) ranges.push({ start, end: trimmed });
  };
  for (const match of text.matchAll(absoluteReach)) add(match.index, match.index + match[0].length);
  for (const match of text.matchAll(schemeRelativeReach))
    if (schemeRelativeHost(match[0])) add(match.index, match.index + match[0].length);
  ranges.sort((left, right) => left.start - right.start);
  const merged: UrlSpan[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else merged.push(range);
  }
  return merged;
};
