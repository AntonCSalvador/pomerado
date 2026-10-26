import { expect, it } from "vitest";
import { maximumRedirectHops, redirectCandidate } from "../../src/destinations/sign-in-redirect.js";

// Core's gate before a host's review of a new sign-in origin the site's own redirect led to.

const from = "https://login.example.net/login";
const idp = "https://auth.example.org";
const document = 1000.5;
const chain = ["https://login.example.net", idp];

it("names the origin the site's redirect settled on when the live page is still that document", () => {
  expect(
    redirectCandidate({
      from,
      navigated: { origins: chain, document },
      live: { url: `${idp}/password`, document },
    }),
  ).toBe(idp);
});

it.each([
  ["no navigation", { origins: [], document }, `${idp}/password`, document],
  ["no settled document", { origins: chain }, `${idp}/password`, document],
  ["a later document", { origins: chain, document }, `${idp}/password`, document + 1],
  ["a live page elsewhere than the chain's end", { origins: chain, document }, "https://other.example.com/", document],
  ["a hop over plain http", { origins: ["http://login.example.net", idp], document }, `${idp}/password`, document],
  ["the screen's own origin", { origins: ["https://login.example.net"], document }, `${from}#next`, document],
  ["a name only a private network resolves", { origins: ["https://auth.example.test"], document }, "https://auth.example.test/", document],
  ["an IP address", { origins: ["https://192.0.2.10"], document }, "https://192.0.2.10/", document],
  [
    "too long a chain",
    { origins: [...Array.from({ length: maximumRedirectHops }, () => "https://hop.example.com"), idp], document },
    `${idp}/password`,
    document,
  ],
] as const)("carries nothing for %s", (_, navigated, url, liveDocument) => {
  expect(redirectCandidate({ from, navigated, live: { url, document: liveDocument } })).toBeUndefined();
});
