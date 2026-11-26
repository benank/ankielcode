import { View } from "react-native";

import { AppText as Text } from "./AppText";
import type { SheetIntroProps } from "./SheetIntro.types";
export type { SheetIntroProps } from "./SheetIntro.types";

/** Material sheets lead with the question itself, so the eyebrow is left out. */
export function SheetIntro(props: SheetIntroProps) {
  return (
    <View className="gap-2 rounded-card bg-card p-3">
      <Text className="text-xl font-ankiel-medium">{props.title}</Text>
      <Text className="text-base leading-normal text-foreground-secondary">
        {props.description}
      </Text>
    </View>
  );
}
