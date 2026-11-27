import { useGT } from "gt-react-native";
import { Platform, View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function NavigationAppearanceSection() {
  const gt = useGT();
  if (Platform.OS !== "android") return null;
  return (
    <SettingsSection title={gt("Navigation")}>
      <AndroidNavigationStyleChoices />
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
