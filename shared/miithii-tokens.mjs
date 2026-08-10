// Miithii design tokens — Pulse direction.
// Runtime-safe so both the browser editor and Node render fallback consume the
// same serialized palette.

export const miithiiColors = Object.freeze({
  teal950: "#081F1C",
  teal900: "#0B3B36",
  jade500: "#1D9E75",
  jade400: "#35C696",
  lime400: "#C6FF3D",
  cream50: "#F2F5F1",
  white: "#FFFFFF",
});

export const miithiiSemanticColors = Object.freeze({
  light: Object.freeze({
    background: miithiiColors.cream50,
    surface: miithiiColors.white,
    text: miithiiColors.teal900,
    primary: miithiiColors.jade500,
    accent: miithiiColors.lime400,
  }),
  dark: Object.freeze({
    background: miithiiColors.teal950,
    surface: miithiiColors.teal900,
    text: miithiiColors.cream50,
    primary: miithiiColors.jade400,
    accent: miithiiColors.lime400,
  }),
});
