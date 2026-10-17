import { sameSite, siteDomain } from "./same-site.js";

/**
 * Whether a URL is on the site or one of its configured sign-in origins, with no user name or
 * password in it: where the host types a sign-in's values.
 */
export const trustedUrl = (
  siteOrigin: string,
  authenticationOrigins: readonly string[],
  value: string,
) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    !url.username &&
    !url.password &&
    (authenticationOrigins.includes(url.origin) || sameSite(siteOrigin, url))
  );
};

/**
 * Whether a URL could be a sign-in page on any site, for a host that trusts any sign-in origin: an
 * https address with no user name or password, on a host with a registrable domain, never plain
 * http, an IP address, localhost or a bare public suffix such as github.io.
 */
export const anySignInUrl = (value: string) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    siteDomain(url.origin) !== undefined
  );
};
