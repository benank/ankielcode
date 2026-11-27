import {
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputInstance,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";

import { MOBILE_TEXT_CLASSES } from "../../lib/typography";

import { cn } from "../../lib/cn";
import { ChromeText } from "./ChromeText";

type TextRole = keyof typeof MOBILE_TEXT_CLASSES;

export type AppTextProps = RNTextProps & {
  readonly className?: string;
} & (
    | { readonly textRole?: TextRole; readonly chrome?: false }
    /** Compact chrome in a fixed-height holder: stops growing at `CHROME_MAX_FONT_SCALE`. */
    | { readonly textRole: TextRole; readonly chrome: true }
  );

export function AppText({ className, textRole, chrome, ...props }: AppTextProps) {
  const textProps = {
    className: cn(
      "font-sans text-foreground",
      textRole && MOBILE_TEXT_CLASSES[textRole],
      className,
    ),
    selectionColorClassName: Platform.OS === "android" ? "accent-focus/32" : undefined,
  };
  if (chrome) return <ChromeText textRole={textRole} {...textProps} {...props} />;
  return <RNText {...textProps} {...props} />;
}

export type AppTextInputProps = Omit<RNTextInputProps, "placeholderTextColor"> & {
  readonly className?: string;
  readonly ref?: React.Ref<TextInputInstance>;
};

export function AppTextInput({ className, ref, ...props }: AppTextInputProps) {
  return (
    <RNTextInput
      ref={ref}
      className={cn(
        "min-h-13.5 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName={"accent-focus/32"}
      cursorColorClassName={"accent-focus"}
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-focus" : undefined}
      {...props}
    />
  );
}
