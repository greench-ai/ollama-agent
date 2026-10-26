import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTweakcnTheme,
  normalizeTweakcnUrl,
  parseThemeCss,
  parseTweakcnRegistry,
  safeThemeValue,
  validateCustomTheme,
} from "../src/core/theme.ts";

const registry = {
  name: "Demo",
  cssVars: {
    theme: { radius: "0.75rem" },
    light: {
      background: "oklch(0.98 0.01 95)",
      foreground: "oklch(0.34 0.02 95)",
      card: "#ffffff",
      primary: "#c96442",
      "primary-foreground": "#fffdf8",
      border: "#e2ded3",
      "muted-foreground": "#6f6b62",
      destructive: "#b5432f",
      "chart-1": "#2f5fa8",
      "chart-2": "#3d7a3d",
    },
    dark: {
      background: "#262624",
      foreground: "#f5f4ef",
      card: "#1f1e1d",
      primary: "#d97757",
      "primary-foreground": "#1f1e1d",
      border: "#41403d",
      "muted-foreground": "#a6a39b",
      destructive: "#e0715f",
      "chart-1": "#82aaff",
      "chart-2": "#9ece6a",
    },
  },
};

test("maps a tweakcn registry item into app theme tokens", () => {
  const theme = parseTweakcnRegistry(registry, "https://tweakcn.com/r/themes/demo");
  assert.equal(theme.name, "Demo");
  assert.equal(theme.light.bg, "oklch(0.98 0.01 95)");
  assert.equal(theme.light["bg-elevated"], "#ffffff");
  assert.equal(theme.light.accent, "#c96442");
  assert.equal(theme.light.radius, "0.75rem");
  assert.equal(theme.dark.bg, "#262624");
  assert.equal(theme.dark.accent, "#d97757");
});

test("normalizes share URLs to the registry endpoint", () => {
  assert.equal(
    normalizeTweakcnUrl("https://tweakcn.com/themes/claude"),
    "https://tweakcn.com/r/themes/claude.json",
  );
  assert.equal(
    normalizeTweakcnUrl("https://www.tweakcn.com/r/themes/claude.json"),
    "https://tweakcn.com/r/themes/claude.json",
  );
  assert.equal(
    normalizeTweakcnUrl("https://tweakcn.com/themes/claude.json"),
    "https://tweakcn.com/r/themes/claude.json",
  );
  const cuid = "c123456789012345678901234";
  assert.equal(
    normalizeTweakcnUrl(`https://tweakcn.com/themes/${cuid}`),
    `https://tweakcn.com/r/themes/${cuid}`,
  );
  assert.throws(() => normalizeTweakcnUrl("https://example.com/themes/x"), /tweakcn/);
});

test("parses pasted CSS and rejects unsafe values", () => {
  const theme = parseThemeCss(`
    :root {
      --background: #ffffff;
      --foreground: #111111;
      --primary: #336699;
      --destructive: url(https://evil.example/x);
      --radius: 0.5rem;
    }
    .dark {
      --background: #000000;
      --foreground: #eeeeee;
      --primary: #88aaff;
    }
  `);
  assert.equal(theme.light.bg, "#ffffff");
  assert.equal(theme.dark.bg, "#000000");
  assert.equal(theme.light.radius, "0.5rem");
  assert.equal(safeThemeValue("red; }"), undefined);
  assert.equal(safeThemeValue("oklch(0.5 0.1 20)"), "oklch(0.5 0.1 20)");
});

test("fetches a theme with a mock transport", async () => {
  let requested = "";
  const mockFetch = (async (url: string | URL | Request) => {
    requested = String(url);
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const theme = await fetchTweakcnTheme(
    "https://tweakcn.com/themes/demo",
    mockFetch,
  );
  assert.equal(requested, "https://tweakcn.com/r/themes/demo.json");
  assert.equal(theme.name, "Demo");
});

test("stored themes are validated and completed with fallbacks", () => {
  const valid = validateCustomTheme({
    name: "Stored",
    source: "test",
    light: { bg: "#fff", text: "#000" },
    dark: { bg: "#000", text: "#fff" },
  });
  assert.ok(valid);
  assert.equal(valid?.light.accent, "#c96442");
  assert.equal(valid?.dark.bg, "#000");

  const invalid = validateCustomTheme({
    light: { bg: "red; }", text: "#000" },
    dark: {},
  });
  assert.equal(invalid, undefined);
});
