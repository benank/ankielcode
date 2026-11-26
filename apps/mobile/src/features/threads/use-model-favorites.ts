import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@ankielcode/contracts";
import { resolveModelPreferences } from "@ankielcode/shared/serverSettings";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { modelFavoriteKey } from "./thread-settings-sheet-state";

const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];

/** Server favorites, falling back to the device's pre-migration list until the server has its own. */
export function useModelFavorites(environmentId: EnvironmentId | null) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const settings = environmentId ? configs.get(environmentId)?.settings : undefined;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const loaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const favoriteKeys: ReadonlySet<string> = new Set(
    resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
      favorites: legacyFavorites,
    }).favorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  return { preferences, legacyFavorites, loaded, favoriteKeys };
}
