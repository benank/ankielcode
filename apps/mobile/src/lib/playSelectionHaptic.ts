import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

export function playSelectionHaptic() {
  if (Platform.OS === "ios") {
    void Haptics.selectionAsync().catch(() => undefined);
  }
}
