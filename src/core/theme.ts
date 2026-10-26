export const APP_THEME_KEYS = [
  "bg",
  "bg-elevated",
  "sidebar",
  "surface",
  "surface-2",
  "border",
  "text",
  "muted",
  "accent",
  "accent-ink",
  "red",
  "green",
  "radius",
  "syn-comment",
  "syn-keyword",
  "syn-string",
  "syn-number",
  "syn-function",
  "syn-operator",
  "syn-punctuation",
] as const;

export type AppThemeKey = (typeof APP_THEME_KEYS)[number];

export interface CustomTheme {
  name: string;
  source: string;
  importedAt: string;
  light: Record<AppThemeKey, string>;
  dark: Record<AppThemeKey, string>;
}

const MAX_THEME_BYTES = 512 * 1024;
const ALLOWED_VALUE = /^[A-Za-z0-9#%.,()\-\s/+]+$/;

/** Reject values that could escape a CSS declaration or load a resource. */
export function safeThemeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return undefined;
  if (!ALLOWED_VALUE.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("url(") ||
    lower.includes("expression(") ||
    lower.includes("image-set(") ||
    lower.includes("javascript:")
  ) {
    return undefined;
  }
  return trimmed;
}

function pick(
  vars: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = safeThemeValue(vars[key]);
    if (value) return value;
  }
  return undefined;
}

function mapPalette(
  raw: Record<string, unknown>,
  shared: Record<string, unknown>,
  fallback: Record<AppThemeKey, string>,
): Record<AppThemeKey, string> {
  const background = pick(raw, ["background"]) ?? fallback.bg;
  const foreground = pick(raw, ["foreground"]) ?? fallback.text;
  const card = pick(raw, ["card"]) ?? background;
  const secondary = pick(raw, ["secondary", "muted", "accent"]) ?? card;
  const mutedForeground = pick(raw, ["muted-foreground"]) ?? fallback.muted;
  const primary = pick(raw, ["primary"]) ?? fallback.accent;
  const primaryInk =
    pick(raw, ["primary-foreground"]) ?? background;
  return {
    bg: background,
    "bg-elevated": card,
    sidebar: pick(raw, ["sidebar"]) ?? card,
    surface: card,
    "surface-2": secondary,
    border: pick(raw, ["border", "input"]) ?? fallback.border,
    text: foreground,
    muted: mutedForeground,
    accent: primary,
    "accent-ink": primaryInk,
    red: pick(raw, ["destructive"]) ?? fallback.red,
    green: pick(raw, ["chart-2", "chart-3"]) ?? fallback.green,
    radius:
      safeThemeValue(shared.radius) ??
      safeThemeValue(raw.radius) ??
      fallback.radius,
    "syn-comment": mutedForeground,
    "syn-keyword": primary,
    "syn-string": pick(raw, ["chart-2"]) ?? fallback.green,
    "syn-number": pick(raw, ["destructive"]) ?? fallback.red,
    "syn-function": pick(raw, ["chart-1"]) ?? primary,
    "syn-operator": pick(raw, ["ring", "chart-4"]) ?? primary,
    "syn-punctuation": mutedForeground,
  };
}

const LIGHT_FALLBACK: Record<AppThemeKey, string> = {
  bg: "#faf9f5",
  "bg-elevated": "#fffdf8",
  sidebar: "#f0eee6",
  surface: "#fffdf8",
  "surface-2": "#f5f2ea",
  border: "#e2ded3",
  text: "#1f1e1d",
  muted: "#6f6b62",
  accent: "#c96442",
  "accent-ink": "#fffdf8",
  red: "#b5432f",
  green: "#4f7a3a",
  radius: "12px",
  "syn-comment": "#8a8377",
  "syn-keyword": "#9a3d8f",
  "syn-string": "#3d7a3d",
  "syn-number": "#a8542f",
  "syn-function": "#2f5fa8",
  "syn-operator": "#2f6f8f",
  "syn-punctuation": "#6f6b62",
};

const DARK_FALLBACK: Record<AppThemeKey, string> = {
  bg: "#262624",
  "bg-elevated": "#1f1e1d",
  sidebar: "#1f1e1d",
  surface: "#30302e",
  "surface-2": "#3a3937",
  border: "#41403d",
  text: "#f5f4ef",
  muted: "#a6a39b",
  accent: "#d97757",
  "accent-ink": "#1f1e1d",
  red: "#e0715f",
  green: "#8fb573",
  radius: "12px",
  "syn-comment": "#7f848e",
  "syn-keyword": "#c792ea",
  "syn-string": "#9ece6a",
  "syn-number": "#f78c6c",
  "syn-function": "#82aaff",
  "syn-operator": "#89ddff",
  "syn-punctuation": "#a6a39b",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function themeName(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80)
    : "tweakcn theme";
}

function buildTheme(
  name: unknown,
  source: string,
  lightRaw: Record<string, unknown>,
  darkRaw: Record<string, unknown>,
  shared: Record<string, unknown>,
): CustomTheme {
  const light = mapPalette(lightRaw, shared, LIGHT_FALLBACK);
  const dark = mapPalette(
    Object.keys(darkRaw).length > 0 ? darkRaw : lightRaw,
    shared,
    DARK_FALLBACK,
  );
  return {
    name: themeName(name),
    source: source.slice(0, 300),
    importedAt: new Date().toISOString(),
    light,
    dark,
  };
}

export function parseTweakcnRegistry(
  raw: unknown,
  source: string,
): CustomTheme {
  if (!raw || typeof raw !== "object") {
    throw new Error("Theme registry item must be an object.");
  }
  const item = raw as Record<string, unknown>;
  const vars = record(item.cssVars);
  const light = record(vars.light);
  const dark = record(vars.dark);
  const shared = record(vars.theme);
  if (Object.keys(light).length === 0) {
    throw new Error("Theme has no light color variables.");
  }
  return buildTheme(item.name, source, light, dark, shared);
}

function declarations(block: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of block.matchAll(/--([A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const value = safeThemeValue(match[2]);
    if (value) vars[match[1]] = value;
  }
  return vars;
}

/** Parse the CSS-variable form copied from the tweakcn editor. */
export function parseThemeCss(css: string): CustomTheme {
  if (css.length > MAX_THEME_BYTES) {
    throw new Error("Theme CSS is larger than 512 KB.");
  }
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let light: Record<string, string> = {};
  let dark: Record<string, string> = {};
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().toLowerCase();
    const vars = declarations(match[2]);
    if (Object.keys(vars).length === 0) continue;
    if (
      selector.includes(".dark") ||
      selector.includes('[data-theme="dark"]') ||
      selector.includes("[data-theme=dark]")
    ) {
      dark = { ...dark, ...vars };
    } else if (selector.includes(":root")) {
      light = { ...light, ...vars };
    }
  }
  if (Object.keys(light).length === 0) {
    throw new Error("No :root CSS variables were found.");
  }
  return buildTheme("Pasted tweakcn theme", "Pasted CSS variables", light, dark, light);
}

export function normalizeTweakcnUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a full https://tweakcn.com/... theme URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Tweakcn theme URLs must use https.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== "tweakcn.com" && host !== "www.tweakcn.com") {
    throw new Error("Only tweakcn.com theme URLs are supported.");
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("tweakcn theme URLs cannot include credentials or a custom port.");
  }
  const match =
    /^\/themes\/([^/]+)\/?$/.exec(url.pathname) ??
    /^\/r\/themes\/([^/]+?)(?:\.json)?\/?$/.exec(url.pathname);
  if (!match) {
    throw new Error("Use a share URL like https://tweakcn.com/themes/<id>.");
  }
  const id = decodeURIComponent(match[1]).replace(/\.json$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.length > 120) {
    throw new Error("Invalid tweakcn theme id.");
  }
  const cuid = /^c[a-z0-9]{24}$/.test(id);
  const suffix = cuid ? "" : ".json";
  return `https://tweakcn.com/r/themes/${id}${suffix}`;
}

export async function fetchTweakcnTheme(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomTheme> {
  let url = normalizeTweakcnUrl(input);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Tweakcn redirected without a location.");
      const next = new URL(location, url);
      if (
        next.protocol !== "https:" ||
        (next.hostname.toLowerCase() !== "tweakcn.com" &&
          next.hostname.toLowerCase() !== "www.tweakcn.com")
      ) {
        throw new Error("Tweakcn redirected outside the allowed host.");
      }
      url = next.toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Tweakcn returned HTTP ${response.status}.`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_THEME_BYTES) {
      throw new Error("Theme response is larger than 512 KB.");
    }
    const text = await response.text();
    if (text.length > MAX_THEME_BYTES) {
      throw new Error("Theme response is larger than 512 KB.");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("Tweakcn did not return a theme JSON document.");
    }
    return parseTweakcnRegistry(raw, url);
  }
  throw new Error("Too many tweakcn redirects.");
}

export async function importTweakcnTheme(input: {
  url?: string;
  css?: string;
}): Promise<CustomTheme> {
  if (typeof input.css === "string" && input.css.trim()) {
    return parseThemeCss(input.css);
  }
  if (typeof input.url === "string" && input.url.trim()) {
    return fetchTweakcnTheme(input.url);
  }
  throw new Error("Provide a tweakcn theme URL or CSS variables.");
}

export function validateCustomTheme(value: unknown): CustomTheme | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const light = record(raw.light);
  const dark = record(raw.dark);
  const cleanedLight: Partial<Record<AppThemeKey, string>> = {};
  const cleanedDark: Partial<Record<AppThemeKey, string>> = {};
  for (const key of APP_THEME_KEYS) {
    const lightValue = safeThemeValue(light[key]);
    const darkValue = safeThemeValue(dark[key]);
    if (lightValue) cleanedLight[key] = lightValue;
    if (darkValue) cleanedDark[key] = darkValue;
  }
  if (!cleanedLight.bg || !cleanedLight.text) return undefined;
  const complete = (
    palette: Partial<Record<AppThemeKey, string>>,
    fallback: Record<AppThemeKey, string>,
  ): Record<AppThemeKey, string> => {
    const result = {} as Record<AppThemeKey, string>;
    for (const key of APP_THEME_KEYS) {
      result[key] = palette[key] ?? fallback[key];
    }
    return result;
  };
  return {
    name: themeName(raw.name),
    source:
      typeof raw.source === "string" ? raw.source.slice(0, 300) : "custom",
    importedAt:
      typeof raw.importedAt === "string"
        ? raw.importedAt
        : new Date().toISOString(),
    light: complete(cleanedLight, LIGHT_FALLBACK),
    dark: complete(cleanedDark, DARK_FALLBACK),
  };
}
