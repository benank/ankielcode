import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(ankielHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(ankielHome)) {
    return Option.none();
  }
  const trimmed = ankielHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly ankielHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.ankielHome), () =>
    input.joinPath(input.homeDirectory, ".ankiel"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly ankielHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.ankielHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
