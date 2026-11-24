import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function AnkielWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 190 / 200;
  return (
    <Svg
      accessibilityLabel="Ankiel"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="40 40 190 200"
    >
      <ThemedPath
        d="M122.2 40h25.6l3.63 8.84L72.87 240H40ZM122.2 40h25.6L230 240h-32.87L118.57 48.84Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
