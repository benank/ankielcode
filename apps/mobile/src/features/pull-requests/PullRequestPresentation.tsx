import type { PullRequestActor } from "@ankielcode/contracts";
import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function PullRequestAvatar(props: {
  readonly actor: PullRequestActor | null;
  readonly size?: number;
}) {
  const size = props.size ?? 24;
  return props.actor?.avatarUrl ? (
    <Image
      source={{ uri: props.actor.avatarUrl }}
      recyclingKey={props.actor.avatarUrl}
      accessibilityLabel={props.actor.login}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      cachePolicy="memory-disk"
    />
  ) : (
    <View
      className="items-center justify-center rounded-full bg-grouped-card"
      style={{ width: size, height: size }}
    >
      <Text className="font-ankiel-medium text-foreground-muted" style={{ fontSize: size * 0.45 }}>
        {props.actor?.login.slice(0, 1).toUpperCase() ?? "?"}
      </Text>
    </View>
  );
}
