import { describe, expect, it } from "vitest";
import { urlSpans } from "../../src/privacy/url-spans.js";
import { failureDetailMetadata, redactDiagnosticText } from "../../src/runtime/failure-detail.js";

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
  ])("screens text glued after a URL: %s", (_label, text, secret) => {
    const redacted = redactDiagnosticText(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("https://portal.example/a");
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

  it("stays linear on long runs of delimiters and many glued URLs", () => {
    const inputs = [
      `https://a.example/${",;|()\\".repeat(500_000)}`,
      `https://a.example/?${",;|()\\".repeat(500_000)}`,
      "https://a.example/x,".repeat(100_000),
      `https://a.example/${"(".repeat(1_000_000)}${".".repeat(1_000_000)}`,
      `https://a.example/?${`,${"a".repeat(63)}`.repeat(30_000)}`,
      `${"|https://a.example/a".repeat(50_000)}|`,
      "https://a.example/a ".repeat(50_000),
      `${"&amp;".repeat(200_000)}https://a.example/${"&amp;".repeat(200_000)}`,
    ];
    const started = performance.now();
    for (const text of inputs) {
      urlSpans(text);
      redactDiagnosticText(text);
    }
    expect(performance.now() - started).toBeLessThan(4_000);
  });
});
