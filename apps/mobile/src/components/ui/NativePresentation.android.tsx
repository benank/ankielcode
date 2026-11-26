import { View } from "react-native";

import type { PresentationSourceProps } from "./NativePresentation";

// Android has no drag out of the app here; the drag props are iOS-only.
export function PresentationSource({
  identifier: _identifier,
  dragUri: _dragUri,
  dragName: _dragName,
  dragMimeType: _dragMimeType,
  ...props
}: PresentationSourceProps) {
  return <View {...props} />;
}
