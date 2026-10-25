import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/markdown.js", import.meta.url), "utf8");
const context: Record<string, unknown> = {};
context.globalThis = context;
vm.runInNewContext(source, context);
const renderMarkdown = context.renderMarkdown as (text: string) => string;

test("markdown escapes raw HTML", () => {
  const html = renderMarkdown('<script>alert("x")</script>');
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("markdown renders headings, emphasis, and lists", () => {
  const html = renderMarkdown("# Title\n\n**bold** and *italic*\n\n- one\n- two");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<ul>\n<li>one<\/li>/);
});

test("fenced code stays literal", () => {
  const html = renderMarkdown("```js\nconst x = '<b>';\n```");
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /&lt;b&gt;/);
  assert.ok(!html.includes("<b>"));
});

test("links are limited to http(s)", () => {
  assert.match(
    renderMarkdown("[docs](https://example.com/a)"),
    /<a href="https:\/\/example\.com\/a"/,
  );
  const unsafe = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!unsafe.includes("href="));
  assert.match(unsafe, /\[click\]\(javascript:alert\(1\)\)/);
});
