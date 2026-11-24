import { extractRelayBasePath } from "@ankielcode/shared/remote";

export * from "@ankielcode/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const basePath = extractRelayBasePath(url.pathname);
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.pathname = basePath === "/" ? normalizedPath : `${basePath.slice(0, -1)}${normalizedPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
