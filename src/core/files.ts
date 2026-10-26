import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface FilePreview {
  path: string;
  name: string;
  content: string;
  size: number;
  truncated: boolean;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Read a text file, but only when it resolves inside the project root. */
export async function readProjectFile(
  cwd: string,
  requested: string,
): Promise<FilePreview> {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error("A file path is required.");
  }
  const root = await realpath(cwd);
  const target = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  // Catch escapes that do not exist on disk before realpath reports ENOENT.
  if (
    !path.isAbsolute(requested) &&
    target !== root &&
    !target.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("Path is outside the project.");
  }
  const real = await realpath(target);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside the project.");
  }

  const info = await stat(real);
  if (!info.isFile()) throw new Error("Not a regular file.");
  const buffer = await readFile(real);
  if (buffer.includes(0)) throw new Error("Binary files cannot be previewed.");
  const content = buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");

  return {
    path: real,
    name: path.basename(real),
    content,
    size: info.size,
    truncated: info.size > MAX_PREVIEW_BYTES,
  };
}
