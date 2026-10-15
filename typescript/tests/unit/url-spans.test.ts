import { describe, expect, it } from "vitest";
import { urlReaches, urlSpans } from "../../src/privacy/url-spans.js";
import {
  failureDetail,
  failureDetailBounds,
  failureDetailMetadata,
  redactDiagnosticText,
} from "../../src/runtime/failure-detail.js";

const spanTexts = (text: string) => urlSpans(text).map(({ start, end }) => text.slice(start, end));

describe("URL boundaries", () => {
  it.each([
    [
      "a key glued by a comma",
      "see https://portal.example/a,password=Synthetic1 now",
      "Synthetic1",
    ],
    [
      "a Markdown link followed by a field",
      "[portal](https://portal.example/a),password=Synthetic2 failed",
      "Synthetic2",
    ],
    [
      "a credential-named key glued by a semicolon",
      "url=https://portal.example/a;password=Synthetic3 rejected",
      "Synthetic3",
    ],
    [
      "a pipe table cell after the URL",
      "|https://portal.example/a|Bearer synthetic-bearer-0123456789|",
      "synthetic-bearer-0123456789",
    ],
    [
      "a credential key after a comma in the query",
      "see https://portal.example/a?next=1,password=Synthetic5 now",
      "Synthetic5",
    ],
    [
      "a credential key after a comma in the fragment",
      "see https://portal.example/a#frag,password=Synthetic6 now",
      "Synthetic6",
    ],
    [
      "a credential key after a pipe in the fragment",
      "see https://portal.example/a#frag|password=Synthetic7 now",
      "Synthetic7",
    ],
    [
      "a credential key after a semicolon in the query",
      "see https://portal.example/a?x=1;password=Synthetic8 now",
      "Synthetic8",
    ],
    [
      "a credential key after a pipe",
      "see https://portal.example/a|password=Synthetic9 now",
      "Synthetic9",
    ],
    [
      "a lowercase bearer credential",
      "see https://portal.example/a,bearer synthetic-bearer-0123456789 now",
      "synthetic-bearer-0123456789",
    ],
    ["an AWS access key ID", "see https://portal.example/a;AKIAFAKEFAKEFAKE1234 now", "AKIAFAKE"],
    [
      "a provider API key",
      "see https://portal.example/a,sk-proj-FAKEabc123def456ghi789 now",
      "sk-proj-FAKE",
    ],
    [
      "a JSON Web Token",
      "see https://portal.example/a;eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ now",
      "ZmFrZXNpZ25hdHVyZQ",
    ],
  ])("screens text glued after a URL: %s", (_label, text, secret) => {
    const redacted = redactDiagnosticText(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("https://portal.example/a");
  });

  it.each([
    ["/cb,password=Synthetic10 failed", "/cb", "Synthetic10"],
    ["/v1/login,password=Synthetic11", "/v1/login", "Synthetic11"],
    ["/v1/items?page=2|password=Synthetic12 failed", "/v1/items?page=2", "Synthetic12"],
  ])("ends a leading route as a URL ends: %s", (text, route, secret) => {
    const redacted = redactDiagnosticText(text);
    expect(redacted.startsWith(route)).toBe(true);
    expect(redacted).not.toContain(secret);
  });

  it("screens a credential key glued by a pipe outside any URL", () => {
    expect(redactDiagnosticText("a|api_key=SyntheticTok0123456789 b")).not.toContain(
      "SyntheticTok0123456789",
    );
  });

  it("keeps a credential inside the URL raw while screening the field glued after it", () => {
    const url = "https://portal.example/cb?access_token=SyntheticQuery1";
    const redacted = redactDiagnosticText(`callback (${url}),password=Synthetic4 refused`);
    expect(redacted).toContain(url);
    expect(redacted).not.toContain("Synthetic4");
  });

  it.each([
    ["a list in the query", "https://shop.example/items?ids=1,2,3"],
    ["a matrix parameter", "https://shop.example/a;v=1/b"],
    ["a pipe in the query", "https://fonts.example/css?family=Roboto|Open+Sans"],
    ["balanced parentheses", "https://wiki.example/wiki/Foo_(bar)"],
    ["percent-encoding", "https://shop.example/s%20p?q=a%2Cb%3Bc"],
    ["JSON-escaped slashes", "https:\\/\\/shop.example\\/a?b=1\\u0026c=2"],
    [
      "nested redirects",
      "https://login.example/auth?next=https%3A%2F%2Fapp.example%2Fhome%3Fa%3D1&r=https://app.example/cb?x=1,2",
    ],
    ["a character reference", "https://shop.example/a?x=1&amp;y=2&#38;z=3"],
    ["a key after a comma in the query", "https://shop.example/a?q=x,y=2"],
    ["a list of dates in the query", "https://shop.example/a?from=x,to=y&ids=7,8"],
    ["a word after a comma in the fragment", "https://shop.example/a#top,section"],
    ["a scheme-relative URL", "//cdn.example/lib.js?v=1,2"],
    ["a schemeless host", "www.shop.example/a?ids=4,5"],
  ])("keeps a real URL whole: %s", (_label, url) => {
    const text = `failed at ${url}. Retry later`;
    expect(spanTexts(text)).toEqual([url]);
    expect(redactDiagnosticText(text)).toBe(text);
  });

  it.each([
    ["the separator written before it", "1001,https://portal.example/a,Synthetic", "1001,"],
    ["an address field", "https://portal.example/a,ada@mail.example", ""],
    ["a long number field", "https://portal.example/a;555-010-0199", ""],
    ["a date field", "https://portal.example/a,2026-01-31", ""],
    ["a name field", "https://portal.example/a,Ada Lovelace", ""],
    ["a key after a comma", "https://portal.example/a,mode=fast", ""],
    ["a pipe outside the query", "https://portal.example/a|b", ""],
    ["an unbalanced bracket", "(https://portal.example/a)", "("],
    ["a backslash escape", "https://portal.example/a\\nnext line", ""],
  ])("ends a URL at %s", (_label, text, before) => {
    expect(urlSpans(text)).toEqual([
      { start: before.length, end: before.length + "https://portal.example/a".length },
    ]);
  });

  it("still accepts a stored detail whose URL an older release measured to the next space", () => {
    const url = `https://portal.example/a,mode=${"x".repeat(17_000)}`;
    const stored = { failureDetail: { subCause: "unclassified", context: { url } } };
    expect(failureDetailMetadata(stored)?.failureDetail.context?.["url"]).toBe(url);
  });

  it("writes a truncated detail an older release still decodes", () => {
    const note = `${"https://wiki.example/w/A_(b) ".repeat(200)}${"word ".repeat(5_000)}`;
    const written = failureDetail("origin_url_invalid", { context: { note } }).context?.["note"];
    if (typeof written !== "string") throw new Error("the note was dropped");
    // An older release counted text outside URLs read to the next space, trimmed of a closer.
    const inside = urlReaches(written).reduce((sum, span) => sum + span.end - span.start, 0);
    expect(written.length - inside).toBeLessThanOrEqual(failureDetailBounds.contextValue + 32);
  });

  it("stays linear on long runs of delimiters and many glued URLs", () => {
    const inputs = [
      `https://a.example/${",;|()\\".repeat(500_000)}`,
      `https://a.example/?${",;|()\\".repeat(500_000)}`,
      "https://a.example/x,".repeat(25_000),
      "https://a.example/?a=1,password=x".repeat(10_000),
      `https://a.example/${",bearer x".repeat(30_000)}`,
      `https://a.example/${",sk-proj-".repeat(30_000)}`,
      `https://a.example/${";eyJxxxx.".repeat(30_000)}`,
      `/${",;|()\\".repeat(500_000)}`,
      `/v1/a?b=1${",x".repeat(100_000)}`,
      `${"https://w.example/a_(b) ".repeat(20_000)}`,
      `https://a.example/${"(".repeat(1_000_000)}${".".repeat(1_000_000)}`,
      `https://a.example/?${`,${"a".repeat(63)}`.repeat(8_000)}`,
      `${"|https://a.example/a".repeat(50_000)}|`,
      "https://a.example/a ".repeat(50_000),
      `${"&amp;".repeat(50_000)}https://a.example/${"&amp;".repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const text of inputs) {
      urlSpans(text);
      redactDiagnosticText(text);
    }
    // About 3 s here; a scan that rereads the text at each delimiter or URL takes minutes.
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 20_000);
});
