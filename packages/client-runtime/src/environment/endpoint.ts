import { extractRelayBasePath } from "@t3tools/shared/remote";

export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  const basePath = extractRelayBasePath(url.pathname);
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  url.pathname = basePath === "/" ? normalizedPath : `${basePath.slice(0, -1)}${normalizedPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
