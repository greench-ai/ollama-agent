import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.ts";
import { agentHome } from "./session.ts";

export type ThemeSetting = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemeSetting;
  /** Default model for new sessions and app startup. */
  model?: string;
  /** Default permission mode. */
  mode: PermissionMode;
  showThinking: boolean;
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
  return value === "system" || value === "light" || value === "dark";
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      theme: validTheme(raw.theme) ? raw.theme : DEFAULTS.theme,
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
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await loadSettings();
  const next: AppSettings = {
    theme: validTheme(patch.theme) ? patch.theme : current.theme,
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
