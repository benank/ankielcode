import { Text, useWindowDimensions, type TextProps } from "react-native";

import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import {
  androidCappedLineHeight,
  CHROME_MAX_FONT_SCALE,
  type MOBILE_TEXT_CLASSES,
} from "../../lib/typography";

export function ChromeText({
  textRole,
  ...props
}: TextProps & {
  readonly className?: string;
  readonly selectionColorClassName?: string;
  readonly textRole: keyof typeof MOBILE_TEXT_CLASSES;
}) {
  const maxFontScale = props.maxFontSizeMultiplier ?? CHROME_MAX_FONT_SCALE;
  const lineHeight = androidCappedLineHeight(
    useScaledTextRole(textRole).lineHeight,
    useWindowDimensions().fontScale,
    maxFontScale,
  );
  return (
    <Text
      {...props}
      maxFontSizeMultiplier={maxFontScale}
      style={lineHeight === undefined ? props.style : [{ lineHeight }, props.style]}
    />
  );
}
