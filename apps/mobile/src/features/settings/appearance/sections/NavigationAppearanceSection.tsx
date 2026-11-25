import { useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import { PullRequestGlyph } from "../../../pull-requests/pullRequestGlyphs";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function NavigationAppearanceSection() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  return (
    <SettingsSection title={gt("Navigation")}>
      <SettingsSwitchRow
        icon={PullRequestGlyph.pullRequest}
        label={gt("Show pull requests tab")}
        subtitle={gt("Show the pull requests list in workspace navigation. Saved on this device.")}
        value={
          AsyncResult.isSuccess(preferences) && preferences.value.pullRequestTabEnabled === true
        }
        disabled={!AsyncResult.isSuccess(preferences)}
        onValueChange={(value) => void savePreferences({ pullRequestTabEnabled: value })}
      />
      {Platform.OS === "android" ? <AndroidNavigationStyleChoices /> : null}
    </SettingsSection>
  );
}

function AndroidNavigationStyleChoices() {
  const gt = useGT();
  const { isReady, androidNavigationStyle, setAndroidNavigationStyle } = useAppearancePreferences();
  return (
    <View accessibilityRole="radiogroup">
      <SettingsChoiceRow
        label="One UI"
        description={gt("Floating navigation with a separate compose button.")}
        disabled={!isReady}
        selected={androidNavigationStyle === "one-ui"}
        onPress={() => setAndroidNavigationStyle("one-ui")}
        separated
      />
      <SettingsChoiceRow
        label="Material"
        description={gt("Standard Android navigation bar and side rail.")}
        disabled={!isReady}
        selected={androidNavigationStyle === "material"}
        onPress={() => setAndroidNavigationStyle("material")}
        separated
      />
    </View>
  );
}
