import { T, useGT } from "gt-react-native";
import { Button } from "../../components/ui/Button";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

export function ThreadCreationFailedCard(props: {
  readonly reason: string;
  readonly onEditTask: () => void;
}) {
  const gt = useGT();
  return (
    <View className="gap-2.5 rounded-card border border-border-subtle bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="exclamationmark.circle"
          size={16}
          tintColorClassName="accent-danger-foreground"
        />
        <Text className="min-w-0 flex-1 font-ankiel-medium text-sm text-foreground">
          <T>Could not start task</T>
        </Text>
      </View>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.reason}
      </Text>
      <Text className="font-sans text-xs leading-normal text-foreground-secondary">
        <T>Your prompt was kept in the project draft.</T>
      </Text>
      <View className="flex-row">
        <Button label={gt("Edit task")} tone="primary" onPress={props.onEditTask} />
      </View>
    </View>
  );
}
