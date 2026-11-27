import type { MenuProps } from "../../components/ui/Menu.types";

export interface PullRequestFilterMenu {
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
  /** Whether any filter, the environment, or a non-default sort is active. */
  readonly customized: boolean;
}
