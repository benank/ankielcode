import { collectLimitAccounts } from "@ankielcode/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import type { ReactNode } from "react";

import type { AppBarAction } from "../../components/ui/AppBar.types";
import { environmentPresentations } from "../../state/presentation";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  connectedLimitPresentations,
  highestUsagePercent,
  usageLimitsRouteParams,
} from "./headerUsageLimits.logic";
import { usageRingPngUri } from "./usageRingPng";

export interface HeaderUsageLimitsControl {
  readonly action?: AppBarAction;
  readonly trailing?: ReactNode;
}

/**
 * iOS uses a native UIBarButtonItem with a rendered ring image so taps are handled by UIKit
 * directly instead of a JS Pressable inside a custom header view (which can nudge the thread feed).
 */
export function useHeaderUsageLimitsControl(): HeaderUsageLimitsControl {
  const gt = useGT();
  const navigation = useNavigation();
  const { selectedThreadDetailRef } = useThreadSelection();
  const { themeVariables } = useAppearancePreferences();
  const allPresentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const presentations = connectedLimitPresentations(allPresentations);
  const accounts = collectLimitAccounts(presentations);
  const highestUsage = highestUsagePercent(accounts);

  const summary =
    highestUsage === undefined
      ? gt("Provider usage limits")
      : gt("Provider usage limits · highest usage {percent}%", {
          percent: Math.round(highestUsage),
        });

  const activeColor =
    highestUsage !== undefined && highestUsage >= 90
      ? themeVariables["--color-danger-foreground"]
      : themeVariables["--color-foreground"];
  const uri = usageRingPngUri({
    percent: highestUsage,
    activeColor,
    trackColor: themeVariables["--color-foreground-muted"],
  });

  return {
    action: {
      accessibilityLabel: summary,
      icon: "circle.dashed",
      iosImageIcon: {
        type: "image",
        source: { uri, width: 20, height: 20, scale: 3 },
        tinted: false,
      },
      separateBackground: false,
      onPress: () => {
        void Haptics.selectionAsync();
        navigation.navigate("UsageLimits", usageLimitsRouteParams(selectedThreadDetailRef));
      },
    },
  };
}
