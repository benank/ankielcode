import { useGT } from "gt-react-native";
import { Platform } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { CHROME_MAX_FONT_SCALE } from "../../../lib/typography";

/** The issues tab's header title. */
export function IssuesListTitle() {
  const gt = useGT();
  const { scale } = useAndroidControlSizing();
  return (
    <Text
      allowFontScaling={Platform.OS === "ios"}
      maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}
      numberOfLines={1}
      className="font-ankiel-bold text-foreground"
      style={{ fontSize: 20 * scale, letterSpacing: -0.4 * scale }}
    >
      {gt("Issues", { $context: "screen title, list of issues" })}
    </Text>
  );
}
