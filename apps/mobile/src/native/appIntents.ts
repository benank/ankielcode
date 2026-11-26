import { requireOptionalNativeModule } from "expo";

export interface DonatedThread {
  readonly path: string;
  readonly title: string;
}

interface AppIntentsModule {
  /** Replaces the on-device Spotlight entries and the App Shortcuts thread list. */
  setRecentThreads(threads: ReadonlyArray<DonatedThread>): void;
  /** The app path an App Shortcut or Spotlight tap asked for, once. */
  takePendingPath(): string | null;
  addListener(event: "onPendingPath", listener: () => void): { remove(): void };
}

/** iOS only; null on Android and in dev clients built before the module shipped. */
export const appIntents = requireOptionalNativeModule<AppIntentsModule>("AnkielAppIntents");
