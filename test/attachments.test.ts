import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readFileAttachment,
  validateFileAttachment,
} from "../src/core/files.ts";

const hasPdftotext = !spawnSync("pdftotext", ["-v"]).error;

const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

test("text attachments validate and reject binaries and unknown types", async () => {
  const text = await validateFileAttachment({
    name: "notes.txt",
    mimeType: "text/plain",
    content: "hello attachment",
  });
  assert.equal(text.kind, "text");
  assert.equal(text.content, "hello attachment");
  assert.equal(text.size, 16);

  const base64Text = await validateFileAttachment({
    name: "data.json",
    mimeType: "application/json",
    data: Buffer.from('{"a":1}').toString("base64"),
  });
  assert.equal(base64Text.content, '{"a":1}');

  await assert.rejects(
    () =>
      validateFileAttachment({
        name: "blob.bin",
        mimeType: "application/octet-stream",
        data: "AAAA",
      }),
    /Unsupported attachment type/,
  );
  await assert.rejects(
    () =>
      validateFileAttachment({
        name: "text.txt",
        mimeType: "text/plain",
        content: "null\u0000byte",
      }),
    /Binary/,
  );
});

test(
  "pdf attachments are converted to text with pdftotext",
  { skip: !hasPdftotext },
  async () => {
    const attachment = await validateFileAttachment({
      name: "sample.pdf",
      mimeType: "application/pdf",
      data: Buffer.from(MINIMAL_PDF).toString("base64"),
    });
    assert.equal(attachment.kind, "pdf");
    assert.match(attachment.content, /Hello PDF/);
  },
);

test("readFileAttachment reads code files and PDFs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-attach-"));
  const code = path.join(dir, "app.ts");
  await writeFile(code, "export const answer = 42;\n");

  const attachment = await readFileAttachment(code);
  assert.equal(attachment.kind, "text");
  assert.equal(attachment.mimeType, "text/typescript");
  assert.match(attachment.content, /answer = 42/);

  if (!hasPdftotext) return;
  const pdfPath = path.join(dir, "sample.pdf");
  await writeFile(pdfPath, MINIMAL_PDF);
  const pdf = await readFileAttachment(pdfPath);
  assert.equal(pdf.kind, "pdf");
  assert.match(pdf.content, /Hello PDF/);
});
