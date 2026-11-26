import type { ReactNode } from "react";

export interface FullSheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** The close button's label. Defaults to "Close {title}". */
  readonly accessibilityLabel?: string;
  /** Blocks the close button, the swipe and Back, such as while the content holds a drag. */
  readonly dismissDisabled?: boolean;
}
