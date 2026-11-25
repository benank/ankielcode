import { extractRelayBasePath, setPairingTokenOnUrl } from "@ankielcode/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  const basePath = extractRelayBasePath(url.pathname);
  url.pathname = basePath === "/" ? "/pair" : `${basePath}pair`;
  return setPairingTokenOnUrl(url, credential).toString();
}
