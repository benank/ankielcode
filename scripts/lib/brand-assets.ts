export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/prod/app-icon.icon",
  developmentIosIconPng: "assets/prod/black-ios-1024.png",
  developmentUniversalIconPng: "assets/prod/black-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/ankiel-black-windows.ico",
  productionWebFaviconIco: "assets/prod/ankiel-black-web-favicon.ico",
  productionWebAppleTouchIconPng: "assets/prod/ankiel-black-web-apple-touch-180.png",
  productionWebIcon192Png: "assets/prod/ankiel-black-web-icon-192x192.png",

  nightlyIconComposerProject: "assets/prod/app-icon.icon",
  nightlyIosIconPng: "assets/prod/black-ios-1024.png",
  nightlyMacIconPng: "assets/prod/black-macos-1024.png",
  nightlyLinuxIconPng: "assets/prod/black-universal-1024.png",
  nightlyWindowsIconIco: "assets/prod/ankiel-black-windows.ico",
  nightlyWebFaviconIco: "assets/prod/ankiel-black-web-favicon.ico",
  nightlyWebAppleTouchIconPng: "assets/prod/ankiel-black-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/prod/black-macos-1024.png",
  developmentWindowsIconIco: "assets/prod/ankiel-black-windows.ico",
  developmentWebFaviconIco: "assets/prod/ankiel-black-web-favicon.ico",
  developmentWebAppleTouchIconPng: "assets/prod/ankiel-black-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
