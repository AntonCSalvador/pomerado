import type { AutofillSignedInCheck } from "../destinations/autofill-step.js";
import { sessionOnPage } from "./session-sign-in.js";

/**
 * Whether a page is neither a recorded screen nor the entry: a saved profile's session went past
 * the sign-in, so an account-page check need not wait out each screen before it runs.
 */
export const leftSignInScreens = (
  onScreens: (page: string) => boolean,
  entryUrl: string,
  url: string | undefined,
) => {
  const pageOf = (value: string | undefined) => {
    const at = URL.parse(value ?? "");
    return at === null ? undefined : `${at.origin}${at.pathname}`;
  };
  const here = pageOf(url);
  return here !== undefined && !onScreens(here) && here !== pageOf(entryUrl);
};

/** How long a page off the recorded screens must stay put before the account-page check opens. */
export const landingSettleMs = 1_500;
/** The page's address when it is none of the recorded screens. */
export const offScreens = (onScreens: (page: string) => boolean, url: string | undefined) => {
  const at = URL.parse(url ?? "");
  return at === null || onScreens(`${at.origin}${at.pathname}`) ? undefined : url;
};
/** A page off the recorded screens and since when it showed. */
export type OffScreens = { readonly url: string; readonly since: number };
/** The page off the recorded screens and since when it showed, or undefined while on them. */
export const stillOff = (previous: OffScreens | undefined, url: string | undefined, now: number) =>
  url === undefined ? undefined : previous?.url === url ? previous : { url, since: now };

/** An account-page recipe can stop waiting after the current session has left its login screens. */
export const settledSessionLanding = (
  openPath: string | undefined,
  off: OffScreens | undefined,
  sent: boolean,
  now: number,
) => openPath !== undefined && off !== undefined && (!sent || now - off.since >= landingSettleMs);

/**
 * A page that can't tell, as `markerCantTell` reads it: the marker is missing or the page
 * is off the site, and `sessionOnPage` does not read it signed out, as on an account picker a site
 * shows before its marker. One of the sign-in's own recorded screens, or a page that shows its
 * password field, did not get past the sign-in, whatever path the marker names.
 */
export const cantTell = (
  check: AutofillSignedInCheck,
  recipe: Parameters<typeof sessionOnPage>[1],
  onScreens: (page: string) => boolean,
) =>
  !check.signedIn &&
  (check.failed === "indicator_not_visible" ||
    check.failed === "path_mismatch" ||
    check.failed === "off_site") &&
  !("passwordFieldVisible" in check && check.passwordFieldVisible === true) &&
  offScreens(onScreens, check.url) !== undefined &&
  sessionOnPage(check, recipe) === "unknown";

/**
 * The session on a checked page, as `sessionOnPage` reads it, except once the marker has
 * confirmed the latest sign-in (`markerConfirmed`): then a page whose marker names no path and
 * doesn't show reads signed out, though it shows no sign-in form. A site's own screen between its
 * sign-in and its pages comes before the marker, so such a page after it is a session the site
 * ended, as one that shows only a "Sign in" link.
 */
export const sessionAfterMarker = (
  check: AutofillSignedInCheck,
  recipe: Parameters<typeof sessionOnPage>[1],
  markerConfirmed: boolean,
) => {
  const session = sessionOnPage(check, recipe);
  return markerConfirmed &&
    session === "unknown" &&
    !check.signedIn &&
    check.failed === "indicator_not_visible" &&
    recipe.signedIn.urlPath === undefined
    ? "signed_out"
    : session;
};
