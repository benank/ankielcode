export type MobileStageLabel = "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  // oxlint-disable-next-line ankielcode/no-untranslated-copy -- release channel name, part of the product name
  if (appVariant === "development") return "Dev";
  // oxlint-disable-next-line ankielcode/no-untranslated-copy -- release channel name, part of the product name
  if (appVariant === "preview") return "Nightly";
  return null;
}
