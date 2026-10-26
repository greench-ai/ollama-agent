export interface UpdateCheck {
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  releaseUrl?: string;
  notes?: string;
  publishedAt?: string;
  error?: string;
}

/** Compare dotted versions; a stable release outranks its prerelease. */
export function compareVersions(a: string, b: string): number {
  const clean = (value: string) => value.replace(/^v/i, "").split("+")[0];
  const [coreA, preA] = clean(a).split("-", 2);
  const [coreB, preB] = clean(b).split("-", 2);
  const partsA = coreA.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = coreB.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(partsA.length, partsB.length, 3); index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (Boolean(preA) === Boolean(preB)) return 0;
  return preA ? -1 : 1;
}

/** Query the latest public GitHub release and compare it to `currentVersion`. */
export async function checkForLatestRelease(
  currentVersion: string,
  repo = "greench-ai/ollama-agent",
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheck> {
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "ollama-agent",
        },
      },
    );
    if (!response.ok) {
      return {
        currentVersion,
        available: false,
        error: `GitHub returned ${response.status} ${response.statusText}`,
      };
    }
    const data = (await response.json()) as Record<string, unknown>;
    const latestVersion =
      typeof data.tag_name === "string"
        ? data.tag_name.replace(/^v/i, "")
        : undefined;
    return {
      currentVersion,
      latestVersion,
      available: latestVersion
        ? compareVersions(latestVersion, currentVersion) > 0
        : false,
      releaseUrl: typeof data.html_url === "string" ? data.html_url : undefined,
      notes: typeof data.body === "string" ? data.body.slice(0, 2000) : undefined,
      publishedAt:
        typeof data.published_at === "string" ? data.published_at : undefined,
    };
  } catch (error) {
    return {
      currentVersion,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
