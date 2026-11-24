import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";

import { resolveTrustedRelayForwardedPrefix } from "./relay/RelayTunnelClient.ts";

/**
 * `HttpServerRequest.toURL` that honors `X-Forwarded-Proto: https` and trusted
 * in-process relay path prefixes (`/h/<hostId>`). Effect 4.1 stopped reading
 * forwarded headers, but TLS-terminating proxies and relays rely on them for
 * OAuth, DPoP `htu`, and pairing URLs.
 */
export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  ).pipe(
    Option.map((url) => {
      const prefix = resolveTrustedRelayForwardedPrefix(request.headers);
      if (!prefix) return url;
      const prefixed = new URL(url.href);
      const suffix = prefixed.pathname.startsWith("/")
        ? prefixed.pathname
        : `/${prefixed.pathname}`;
      prefixed.pathname = `${prefix}${suffix}`;
      return prefixed;
    }),
  );
