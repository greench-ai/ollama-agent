import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ImageAttachment } from "./types.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXTENSION));

export function imageMimeTypeForPath(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

/** Load an image file into a base64 attachment, enforcing the size cap. */
export async function loadImageAttachment(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<ImageAttachment> {
  const mimeType = imageMimeTypeForPath(filePath);
  if (!mimeType) {
    throw new Error(`Unsupported image type: ${path.extname(filePath) || "(none)"}`);
  }
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const buffer = await readFile(filePath);
  if (buffer.length > maxBytes) {
    throw new Error(
      `Image is ${buffer.length} bytes; the limit is ${maxBytes} bytes.`,
    );
  }
  return {
    data: buffer.toString("base64"),
    mimeType,
    name: path.basename(filePath),
  };
}

/**
 * Validate an attachment arriving from an untrusted surface (HTTP or IPC).
 * Accepts a data: URL or raw base64. Returns the normalized attachment.
 */
export function validateImageAttachment(
  value: unknown,
  options: { maxBytes?: number } = {},
): ImageAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Image must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.data !== "string" || record.data.length === 0) {
    throw new Error("Image is missing base64 data.");
  }

  let data = record.data.trim();
  let mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (dataUrl) {
    if (!mimeType) mimeType = dataUrl[1];
    data = dataUrl[2];
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error(`Unsupported image type: ${mimeType || "(missing)"}.`);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) {
    throw new Error("Image data is not valid base64.");
  }

  const bytes = Math.floor((data.replace(/\s+/g, "").length * 3) / 4);
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`Image is about ${bytes} bytes; the limit is ${maxBytes}.`);
  }

  const name = typeof record.name === "string" ? record.name.slice(0, 200) : undefined;
  return { data: data.replace(/\s+/g, ""), mimeType, name };
}
