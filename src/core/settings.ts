import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.ts";
import { agentHome } from "./session.ts";
import {
  validateCustomTheme,
  type CustomTheme,
} from "./theme.ts";

export type ThemeSetting = "system" | "light" | "dark" | "custom";

export interface AppSettings {
  theme: ThemeSetting;
  /** Imported tweakcn theme with mapped light/dark tokens. */
  customTheme?: CustomTheme;
  /** Default model for new sessions and app startup. */
  model?: string;
  /** Default permission mode. */
  mode: PermissionMode;
  showThinking: boolean;
}

export interface SettingsPatch {
  theme?: ThemeSetting;
  customTheme?: CustomTheme | null;
  model?: string;
  mode?: PermissionMode;
  showThinking?: boolean;
}

const DEFAULTS: AppSettings = {
  theme: "system",
  mode: "default",
  showThinking: true,
};

export function settingsPath(): string {
  return path.join(agentHome(), "settings.json");
}

function validTheme(value: unknown): value is ThemeSetting {
  return (
    value === "system" ||
    value === "light" ||
    value === "dark" ||
    value === "custom"
  );
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), "utf8")) as Record<
      string,
      unknown
    >;
    const customTheme = validateCustomTheme(raw.customTheme);
    const storedTheme = validTheme(raw.theme) ? raw.theme : DEFAULTS.theme;
    const theme =
      storedTheme === "custom" && !customTheme ? "system" : storedTheme;
    return {
      theme,
      ...(customTheme ? { customTheme } : {}),
      model:
        typeof raw.model === "string" && raw.model.trim()
          ? raw.model.trim()
          : undefined,
      mode:
        typeof raw.mode === "string" &&
        PERMISSION_MODES.includes(raw.mode as PermissionMode)
          ? (raw.mode as PermissionMode)
          : DEFAULTS.mode,
      showThinking: raw.showThinking !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function updateSettings(
  patch: SettingsPatch,
): Promise<AppSettings> {
  const current = await loadSettings();
  const customTheme =
    patch.customTheme === null
      ? undefined
      : patch.customTheme !== undefined
        ? (validateCustomTheme(patch.customTheme) ?? current.customTheme)
        : current.customTheme;
  let theme = validTheme(patch.theme) ? patch.theme : current.theme;
  if (theme === "custom" && !customTheme) theme = "system";
  const next: AppSettings = {
    theme,
    ...(customTheme ? { customTheme } : {}),
    model:
      typeof patch.model === "string"
        ? patch.model.trim() || undefined
        : current.model,
    mode:
      typeof patch.mode === "string" &&
      PERMISSION_MODES.includes(patch.mode as PermissionMode)
        ? (patch.mode as PermissionMode)
        : current.mode,
    showThinking:
      patch.showThinking === undefined
        ? current.showThinking
        : Boolean(patch.showThinking),
  };
  await mkdir(path.dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
