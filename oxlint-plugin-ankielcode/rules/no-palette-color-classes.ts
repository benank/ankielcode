import { defineRule, type ESTree } from "@oxlint/plugins";

// Tailwind palette hues, including mobile's `adaptive-<hue>-…` pairs, used as UI color.
const PALETTE_COLOR_CLASS =
  /(?:^|[\s:"'`(])(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|accent|divide|caret|tint)-(?:adaptive-)?(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/u;

const MESSAGE =
  "Use a theme token (text-destructive, text-warning, text-muted-foreground, a status tone) instead of a raw palette color class, so every theme and client draws from one palette.";

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow raw Tailwind palette color classes in UI code; status and surface colors come from theme tokens.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string | null | undefined) => {
      if (text && PALETTE_COLOR_CLASS.test(text)) context.report({ node, message: MESSAGE });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
});
