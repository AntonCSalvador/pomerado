/**
 * The forms a known secret value can be written in, and where they occur in a text. Every host
 * masks and refuses a registered value in each of these forms: as given, as a page, a URL, a form
 * body, JSON or base64 writes it.
 *
 * Where registered values occur: every non-overlapping occurrence of each form of each value,
 * scanning left to right, in value then form order. Screening masks these spans.
 *
 * A capture body is megabytes long and a scope registers hundreds of values (every cookie and
 * header secret, each in several forms), so one `indexOf` scan per form reads the body thousands
 * of times. A long text with many forms is instead scanned once: each position's first four code
 * units are hashed and only forms starting with that hash are compared there. Both paths return
 * the same spans in the same order. A caller that screens one part of a long text passes the part
 * with its context around it as one text, and keeps the spans that reach its part.
 */

export interface KnownValue {
  readonly value: string;
  readonly forms: readonly string[];
}

export interface KnownValueOccurrence<Value extends KnownValue> {
  readonly start: number;
  readonly end: number;
  readonly value: Value;
}

const prefixLength = 4;

/** A hash of four code units, below 2^41 so it stays exact; equal prefixes hash equal. */
const prefixHash = (text: string, at: number): number =>
  ((text.charCodeAt(at) * 257 + text.charCodeAt(at + 1)) * 257 + text.charCodeAt(at + 2)) * 257 +
  text.charCodeAt(at + 3);

/**
 * One `indexOf` pass per form: the reference behaviour, and the fast path for short texts. A form
 * longer than the text cannot occur in it, so it is not looked for.
 */
export const scanKnownValues = <Value extends KnownValue>(
  text: string,
  values: Iterable<Value>,
): KnownValueOccurrence<Value>[] => {
  const occurrences: KnownValueOccurrence<Value>[] = [];
  for (const value of values)
    for (const form of value.forms) {
      if (form.length === 0 || form.length > text.length) continue;
      let start = text.indexOf(form);
      while (start !== -1) {
        occurrences.push({ start, end: start + form.length, value });
        start = text.indexOf(form, start + form.length);
      }
    }
  return occurrences;
};

/** Every non-overlapping start of `form` in `text`, by `indexOf`. */
const formStarts = (text: string, form: string, found: number[]) => {
  let start = text.indexOf(form);
  while (start !== -1) {
    found.push(start);
    start = text.indexOf(form, start + form.length);
  }
};

/** Starts of every hashed form, reading `text` once; each form's starts stay non-overlapping. */
const hashedStarts = (
  text: string,
  byPrefix: ReadonlyMap<number, readonly string[]>,
  positions: ReadonlyMap<string, number[]>,
) => {
  const nextAllowed = new Map<string, number>();
  const last = text.length - prefixLength;
  for (let at = 0; at <= last; at++) {
    const bucket = byPrefix.get(prefixHash(text, at));
    if (bucket === undefined) continue;
    for (const form of bucket) {
      if ((nextAllowed.get(form) ?? 0) > at || !text.startsWith(form, at)) continue;
      positions.get(form)?.push(at);
      nextAllowed.set(form, at + form.length);
    }
  }
};

/** The same occurrences as `scanKnownValues`, reading a long text once. */
export const findKnownValues = <Value extends KnownValue>(
  text: string,
  values: readonly Value[],
): KnownValueOccurrence<Value>[] => {
  const formCount = values.reduce((total, value) => total + value.forms.length, 0);
  // Below this much work, per-form scans are cheaper than hashing every position.
  if (text.length < 4_096 || formCount < 16) return scanKnownValues(text, values);
  // Each distinct form is located once; forms shorter than the hashed prefix use indexOf.
  const positions = new Map<string, number[]>();
  const byPrefix = new Map<number, string[]>();
  for (const form of values.flatMap((value) => value.forms)) {
    if (form.length === 0 || positions.has(form)) continue;
    const found: number[] = [];
    positions.set(form, found);
    if (form.length < prefixLength) formStarts(text, form, found);
    else {
      const hash = prefixHash(form, 0);
      byPrefix.set(hash, [...(byPrefix.get(hash) ?? []), form]);
    }
  }
  if (byPrefix.size > 0) hashedStarts(text, byPrefix, positions);
  return values.flatMap((value) =>
    value.forms.flatMap((form) =>
      (positions.get(form) ?? []).map((start) => ({ start, end: start + form.length, value })),
    ),
  );
};

/**
 * A value's forms plus each form's JSON-escaped spelling. Structured screening masks forms in
 * decoded JSON strings, which serialized JSON holds escaped once more, so a search of serialized
 * text for what screening would mask needs both.
 */
export const withJsonEscapedForms = <Value extends KnownValue>(value: Value): Value => ({
  ...value,
  forms: [
    ...new Set([...value.forms, ...value.forms.map((form) => JSON.stringify(form).slice(1, -1))]),
  ],
});

/**
 * A security answer under eight characters counts only where it stands as a whole token: "red"
 * inside "required" is a chance match that must not refuse a request to another site, a source
 * read or a publication. An all-digit form counts where no digit adjoins it and any other where no
 * letter, mark or digit does, so `A4821` or `/otp4821/` still carry a digit answer. A longer
 * answer, and every other secret, counts wherever it appears, and masking still masks every
 * occurrence.
 */
const shortAnswerLength = 8;
export const countsAsCarried = (
  text: string,
  start: number,
  end: number,
  secret: { readonly entity: string; readonly value: string },
) => {
  if (secret.entity !== "SECURITY_ANSWER" || secret.value.length >= shortAnswerLength) return true;
  const form = text.slice(start, end);
  const joins = /^[0-9]+$/u.test(form) ? /[0-9]/u : /[\p{L}\p{M}\p{N}]/u;
  const joinedBefore = joins.test(form.charAt(0)) && joins.test(text.charAt(start - 1));
  const joinedAfter = joins.test(form.charAt(form.length - 1)) && joins.test(text.charAt(end));
  return !joinedBefore && !joinedAfter;
};

/**
 * A quoted value in a page's accessibility snapshot, escaped as Playwright's YAML writer does: a
 * backslash, a double quote and `\b\f\n\r\t` as escapes, and every other control character as
 * `\xNN`.
 */
const yamlValueEscaped = (form: string) =>
  form.replace(/[\\"\x00-\x1f\x7f-\x9f]/gu, (character) => {
    switch (character) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
    }
  });

/**
 * The characters Chromium percent-encodes in each part of a URL it shows (`page.url()`), beyond
 * control characters, space and anything outside ASCII, which every part encodes.
 */
const urlPartEncoded = { query: `"#<>'`, path: '"#<>?^`{|}', fragment: '"<>`' };
/**
 * Each byte as one part of a URL writes it: escaped when it is a control character, space,
 * non-ASCII byte or one of the part's `encoded` characters, in uppercase hex.
 */
const byteForms = (encoded: string) =>
  Array.from({ length: 256 }, (_, byte) =>
    byte <= 0x20 || byte >= 0x7f || encoded.includes(String.fromCharCode(byte))
      ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      : String.fromCharCode(byte),
  );
const urlPartBytes = {
  query: byteForms(urlPartEncoded.query),
  path: byteForms(urlPartEncoded.path),
  fragment: byteForms(urlPartEncoded.fragment),
};
const utf8 = new TextEncoder();
/**
 * `form` as a browser writes it into one part of a URL: without tabs and line breaks, which a
 * URL drops, with `\` turned into `/` in a path, then percent-encoded in UTF-8.
 */
const urlPartForm = (form: string, part: keyof typeof urlPartEncoded) => {
  const bytes = urlPartBytes[part];
  let encoded = "";
  for (const character of (part === "path" ? form.replaceAll("\\", "/") : form).replace(
    /[\t\n\r]/gu,
    "",
  )) {
    const code = character.charCodeAt(0);
    if (code < 0x80) encoded += bytes[code];
    else for (const byte of utf8.encode(character)) encoded += bytes[byte];
  }
  return encoded;
};
const lowercaseHex = (encoded: string) =>
  encoded.includes("%")
    ? encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase())
    : encoded;

/**
 * Under this many characters a form is short: a host may count it in source only as a whole
 * token, since a short value, such as a favorite color or a six-digit code, turns up inside a
 * longer word or a timestamp by chance.
 */
const shortForm = 8;

/**
 * Each form a page or URL can show `value` in, each with whether it is short (`shortForm`). The
 * value as given, trimmed, and with its whitespace collapsed as an accessibility snapshot shows it;
 * each of them as written, JSON-escaped, escaped as a snapshot's quoted value, and with each `'`
 * doubled as a snapshot's quoted key holds a name; and percent-encoded as `encodeURIComponent` and
 * a form write it, and as Chromium writes it into a URL's query, path and fragment, in uppercase
 * and lowercase hex. Last, the value base64-encoded. A value that cannot be encoded, such as one
 * holding a lone surrogate, keeps every other form. Each form counts by the length of the shown
 * value it came from.
 */
export const shownForms = (value: string): (readonly [string, boolean])[] => {
  const shown = [
    value,
    value.trim(),
    value
      .replace(/[\u200b\u00ad]/gu, "")
      .trim()
      .replace(/\s+/gu, " "),
  ];
  // The three shown values are usually equal, and each distinct one is encoded once.
  const encoded = new Map<string, (readonly [string, boolean])[]>();
  const forms = shown.flatMap((form) => {
    const known = encoded.get(form);
    if (known !== undefined) return known;
    if (form.length === 0) return [];
    const json = JSON.stringify(form).slice(1, -1);
    const forms = [
      form,
      json,
      yamlValueEscaped(form),
      form.replaceAll("'", "''"),
      json.replaceAll("'", "''"),
    ];
    if (form.isWellFormed()) {
      const percent = [
        encodeURIComponent(form),
        new URLSearchParams([["", form]]).toString().slice(1),
        urlPartForm(form, "query"),
        urlPartForm(form, "path"),
        urlPartForm(form, "fragment"),
      ];
      forms.push(...percent, ...percent.map(lowercaseHex));
    }
    const short = form.length < shortForm;
    const result = forms.map((shownForm) => [shownForm, short] as const);
    encoded.set(form, result);
    return result;
  });
  return value.length === 0
    ? forms
    : [...forms, [Buffer.from(value).toString("base64"), value.length < shortForm] as const];
};

/**
 * Every form of `value`, each once: as given, percent-encoded, form-encoded (`+` for a space and
 * `!'()~` percent-encoded), base64-encoded and JSON-escaped, then every other form a page or URL
 * shows it in (`shownForms`). A value holding a lone surrogate throws, as `encodeURIComponent`
 * does.
 */
export const observedForms = (value: string): readonly string[] => {
  const json = JSON.stringify(value);
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      // HTML forms and URLSearchParams: `+` for a space and `!'()~` percent-encoded.
      new URLSearchParams({ v: value }).toString().slice(2),
      Buffer.from(value).toString("base64"),
      json.slice(1, -1),
      ...shownForms(value).map(([form]) => form),
    ]),
  ];
};

/** One run of percent escapes decoded, or undefined when it is not UTF-8. */
const decodedEscapes = (run: string): string | undefined => {
  try {
    return decodeURIComponent(run);
    // error-reporting-allow: parse-predicate an escape run that is not UTF-8 stays as written
  } catch {
    return undefined;
  }
};

/** A `+` or a run of percent escapes. */
const formEscape = /\+|(?:%[0-9a-f]{2})+/giu;

/**
 * Form and percent decoding, so a value sent by any other percent-encoder is seen as sent:
 * `+` is a space, and each run of escapes that is valid UTF-8 is decoded. Undefined when the
 * text has nothing to decode.
 */
export const formDecoded = (text: string): string | undefined => {
  if (!text.includes("%") && !text.includes("+")) return undefined;
  const decoded = text.replace(formEscape, (run) =>
    run === "+" ? " " : (decodedEscapes(run) ?? run),
  );
  return decoded === text ? undefined : decoded;
};
