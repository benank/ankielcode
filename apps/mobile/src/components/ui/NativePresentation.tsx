import { requireNativeView } from "expo";
import type { ComponentType, ReactElement } from "react";
import type { ViewProps } from "react-native";

import type { PresentationDragProps } from "../../lib/presentationDrag";

export interface PresentationSourceProps extends ViewProps, Partial<PresentationDragProps> {
  readonly children: ReactElement;
  readonly identifier: string;
}

const NativeSource: ComponentType<PresentationSourceProps> = requireNativeView(
  "AnkielNativeControls",
  "PresentationSource",
);

export function PresentationSource(props: PresentationSourceProps) {
  return <NativeSource {...props} collapsableChildren={false} />;
}
