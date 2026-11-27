import { requireNativeView } from "expo";
import type { PropsWithChildren } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

import type { HardwareKeyboardCommand } from "../features/keyboard/hardwareKeyboardCommands";

interface NativeKeyboardCommandsProps extends ViewProps {
  readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
  readonly commandTitles?: Readonly<Record<string, string>>;
  readonly onCommand: (
    event: NativeSyntheticEvent<{ readonly command: HardwareKeyboardCommand }>,
  ) => void;
}

const NativeKeyboardCommands =
  requireNativeView<NativeKeyboardCommandsProps>("AnkielKeyboardCommands");

export function AnkielKeyboardCommands(
  props: PropsWithChildren<{
    readonly enabledCommands: ReadonlyArray<HardwareKeyboardCommand>;
    /** App-wide titles for the shortcut overlay and the iPadOS menu bar; iOS only. */
    readonly commandTitles?: Readonly<Record<string, string>>;
    readonly onCommand: (command: HardwareKeyboardCommand) => void;
  }>,
) {
  return (
    <NativeKeyboardCommands
      onCommand={(event) => props.onCommand(event.nativeEvent.command)}
      enabledCommands={props.enabledCommands}
      commandTitles={props.commandTitles}
      style={{ flex: 1 }}
    >
      {props.children}
    </NativeKeyboardCommands>
  );
}
