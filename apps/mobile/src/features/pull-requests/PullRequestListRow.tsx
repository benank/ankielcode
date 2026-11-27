import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { pullRequestLabelColor } from "./pullRequestList";

/** A label as list rows show it: small, tinted by its color, truncating. */
export function ListRowLabel(props: {
  readonly label: { readonly name: string; readonly color: string | null };
  readonly textClassName: string;
}) {
  const color = pullRequestLabelColor(props.label.color);
  return (
    <View
      className="min-w-0 shrink flex-row items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5"
      style={{ maxWidth: 160, ...(color ? { backgroundColor: `${color}20` } : {}) }}
    >
      {color ? (
        <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
      ) : null}
      <Text
        className={cn("shrink text-2xs font-ankiel-medium", props.textClassName)}
        numberOfLines={1}
      >
        {props.label.name}
      </Text>
    </View>
  );
}
