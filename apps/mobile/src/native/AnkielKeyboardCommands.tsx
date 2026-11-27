import type { PropsWithChildren } from "react";
import { View } from "react-native";

import type { HardwareKeyboardCommand } from "../features/keyboard/hardwareKeyboardCommands";

export function AnkielKeyboardCommands(
  props: PropsWithChildren<{
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    readonly commandTitles?: Readonly<Record<string, string>>;
    readonly onCommand: (command: HardwareKeyboardCommand) => void;
  }>,
) {
  return <View className="flex-1">{props.children}</View>;
}
