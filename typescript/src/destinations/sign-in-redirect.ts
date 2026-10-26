import { Schema } from "effect";
import { trustableSignInUrl } from "../runtime/sign-in-origins.js";

/**
 * Where the page went on its own from a host's click of a sign-in step's submit until it settled:
 * the origin of each navigation of the primary tab's main frame in order, server redirects
 * included, and when the document it settled on began loading (`performance.timeOrigin`). Host-only:
 * the page chose these origins after the host typed, so one may hold part of what was typed.
 */
export const SiteNavigation = Schema.Struct({
  origins: Schema.Array(Schema.String),
  document: Schema.optional(Schema.Number),
});
export type SiteNavigation = typeof SiteNavigation.Type;

/** The most navigations a redirect chain may hold for a sign-in to carry its trust along it. */
export const maximumRedirectHops = 10;

/**
 * The origin a sign-in may carry its trust to, from a trusted screen it submitted on `from`, when
 * the live page is where the site's own navigation from that submit settled, else undefined:
 * - the host's click started a chain of at most `maximumRedirectHops` navigations, each https;
 * - the chain ended on the live page's origin, another than `from`;
 * - the live page is still the document the chain settled on (the same `performance.timeOrigin`),
 *   so nothing navigated it since, the minter's own steps included;
 * - and the live page is an address a host may trust for a sign-in at all (`trustableSignInUrl`).
 * A navigation the page made after the click's settle wait, such as a script's later redirect, is
 * a new document, so it carries nothing and the screen is judged as before.
 */
export const redirectCandidate = (input: {
  readonly from: string;
  readonly navigated: SiteNavigation;
  readonly live: { readonly url: string; readonly document?: number | undefined };
}): string | undefined => {
  const { origins, document } = input.navigated;
  if (origins.length === 0 || origins.length > maximumRedirectHops) return undefined;
  if (document === undefined || input.live.document !== document) return undefined;
  if (!origins.every((origin) => URL.parse(origin)?.protocol === "https:")) return undefined;
  const live = URL.parse(input.live.url);
  if (live === null || !trustableSignInUrl(live)) return undefined;
  const from = URL.parse(input.from)?.origin;
  if (live.origin !== origins.at(-1) || live.origin === from) return undefined;
  return live.origin;
};
