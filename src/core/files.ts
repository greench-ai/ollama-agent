import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { imageMimeTypeForPath } from "./images.ts";
import type { FileAttachment } from "./types.ts";

export interface FilePreview {
  path: string;
  name: string;
  content: string;
  size: number;
  truncated: boolean;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 1_000_000;
export const MAX_PDF_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
const MAX_EXTRACTED_TEXT = 2_000_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini",
  "csv", "tsv", "log", "xml", "html", "htm", "css", "scss", "less", "js",
  "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish",
  "sql", "graphql", "gql", "env",
]);

const TEXT_BASENAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "changelog",
]);

export function isPdfAttachment(mimeType: string, name?: string): boolean {
  return (
    mimeType === "application/pdf" ||
    (name ? path.extname(name).toLowerCase() === ".pdf" : false)
  );
}

export function isTextAttachment(mimeType: string, name?: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-yaml",
      "application/yaml",
      "application/toml",
    ].includes(mimeType)
  ) {
    return true;
  }
  if (!name) return false;
  const extension = path.extname(name).toLowerCase().slice(1);
  if (extension && TEXT_EXTENSIONS.has(extension)) return true;
  return TEXT_BASENAMES.has(path.basename(name).toLowerCase());
}

export function attachmentMimeTypeForPath(filePath: string): string {
  const image = imageMimeTypeForPath(filePath);
  if (image) return image;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  const key = extension.slice(1);
  if (
    TEXT_BASENAMES.has(path.basename(filePath).toLowerCase()) ||
    TEXT_EXTENSIONS.has(key)
  ) {
    if (key === "json") return "application/json";
    if (["js", "mjs", "cjs", "jsx"].includes(key)) return "text/javascript";
    if (["ts", "tsx"].includes(key)) return "text/typescript";
    if (["md", "markdown"].includes(key)) return "text/markdown";
    if (["yaml", "yml"].includes(key)) return "application/yaml";
    if (["html", "htm"].includes(key)) return "text/html";
    if (key === "css") return "text/css";
    return "text/plain";
  }
  return "application/octet-stream";
}

async function extractPdfText(
  base64: string,
): Promise<{ content: string; size: number }> {
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) throw new Error("PDF attachment is empty.");
  if (buffer.length > MAX_PDF_ATTACHMENT_BYTES) {
    throw new Error(
      `PDF is ${buffer.length} bytes; the limit is ${MAX_PDF_ATTACHMENT_BYTES}.`,
    );
  }

  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn("pdftotext", ["-layout", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_EXTRACTED_TEXT) {
        output = output.slice(0, MAX_EXTRACTED_TEXT);
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.on("error", (error) => {
      reject(
        new Error(
          `PDF extraction requires pdftotext (${error.message}). Install poppler-utils.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`pdftotext failed: ${errors.slice(0, 200)}`));
    });
    child.stdin.end(buffer);
  });

  const content = text.trim();
  if (!content) {
    throw new Error("No text could be extracted from this PDF.");
  }
  return { content, size: buffer.length };
}

/** Validate a text or PDF attachment arriving from HTTP or IPC. */
export async function validateFileAttachment(
  value: unknown,
): Promise<FileAttachment> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Attachment must be an object.");
  }
  const record = value as Record<string, unknown>;
  const rawName = typeof record.name === "string" ? record.name : "attachment";
  const name = path.basename(rawName).slice(0, 200) || "attachment";
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";

  if (isPdfAttachment(mimeType, name)) {
    if (typeof record.data !== "string" || !record.data) {
      throw new Error("PDF attachment is missing base64 data.");
    }
    const extracted = await extractPdfText(record.data);
    return {
      name,
      mimeType: "application/pdf",
      content: extracted.content,
      kind: "pdf",
      size: extracted.size,
    };
  }

  if (isTextAttachment(mimeType, name)) {
    let content: string;
    if (typeof record.content === "string") {
      content = record.content;
    } else if (typeof record.data === "string") {
      content = Buffer.from(record.data, "base64").toString("utf8");
    } else {
      throw new Error("Text attachment is missing content.");
    }
    if (content.includes("\u0000")) {
      throw new Error("Binary files cannot be attached as text.");
    }
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_TEXT_ATTACHMENT_BYTES) {
      content = `${content.slice(0, MAX_TEXT_ATTACHMENT_BYTES)}\n[truncated]`;
    }
    return {
      name,
      mimeType: mimeType || "text/plain",
      content,
      kind: "text",
      size,
    };
  }

  throw new Error(
    `Unsupported attachment type: ${mimeType || name}. ` +
      "Attach images, PDFs, or text/code files.",
  );
}

/** Read a file from disk for the CLI's /file command. */
export async function readFileAttachment(
  filePath: string,
): Promise<FileAttachment> {
  const name = path.basename(filePath);
  const mimeType = attachmentMimeTypeForPath(filePath);

  if (isPdfAttachment(mimeType, name)) {
    const buffer = await readFile(filePath);
    if (buffer.length > MAX_PDF_ATTACHMENT_BYTES) {
      throw new Error(
        `PDF is ${buffer.length} bytes; the limit is ${MAX_PDF_ATTACHMENT_BYTES}.`,
      );
    }
    const extracted = await extractPdfText(buffer.toString("base64"));
    return {
      name,
      mimeType: "application/pdf",
      content: extracted.content,
      kind: "pdf",
      size: buffer.length,
    };
  }

  if (!isTextAttachment(mimeType, name)) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Attach images or text/code/PDF files.`,
    );
  }

  const info = await stat(filePath);
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) throw new Error("Binary files cannot be attached.");
  const content = buffer.toString("utf8");
  return {
    name,
    mimeType,
    content:
      content.length > MAX_TEXT_ATTACHMENT_BYTES
        ? `${content.slice(0, MAX_TEXT_ATTACHMENT_BYTES)}\n[truncated]`
        : content,
    kind: "text",
    size: info.size,
  };
}

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
