import { Text, type TextProps } from "react-native";

import { CHROME_MAX_FONT_SCALE, type MOBILE_TEXT_CLASSES } from "../../lib/typography";

export function ChromeText({
  textRole: _textRole,
  ...props
}: TextProps & {
  readonly className?: string;
  readonly selectionColorClassName?: string;
  readonly textRole: keyof typeof MOBILE_TEXT_CLASSES;
}) {
  return <Text maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE} {...props} />;
}
