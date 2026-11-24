import { buildHostedPairingUrl } from "../../hostedPairing";
import { extractRelayBasePath, setPairingTokenOnUrl } from "@ankielcode/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  const basePath = extractRelayBasePath(url.pathname);
  url.pathname = basePath === "/" ? "/pair" : `${basePath}pair`;
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
