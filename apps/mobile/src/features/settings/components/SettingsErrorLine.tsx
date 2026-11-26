import type { ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";

/** A failure inside a settings row: the icon carries the red, the message stays readable. */
export function SettingsErrorLine(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly numberOfLines?: number;
  readonly selectable?: boolean;
  readonly alert?: boolean;
}) {
  return (
    <View className={cn("flex-row items-start gap-2", props.className)}>
      <View className="pt-0.5">
        <SymbolView
          name="exclamationmark.circle"
          size={14}
          tintColorClassName="accent-danger-foreground"
        />
      </View>
      <Text
        accessibilityRole={props.alert === true ? "alert" : undefined}
        selectable={props.selectable}
        numberOfLines={props.numberOfLines}
        className="min-w-0 flex-1 text-sm text-foreground-muted"
      >
        {props.children}
      </Text>
    </View>
  );
}
