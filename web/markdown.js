// Small, dependency-free Markdown renderer.
// Everything is HTML-escaped before formatting, so raw markup in model output
// is always shown as text. Links are limited to http(s).
(function () {
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inline(raw) {
    let text = escapeHtml(raw);
    const code = [];
    text = text.replace(/`([^`]+)`/g, function (_, value) {
      code.push(value);
      return "\u0000" + (code.length - 1) + "\u0000";
    });
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      function (_, label, url) {
        return (
          '<a href="' +
          escapeHtml(url) +
          '" target="_blank" rel="noreferrer noopener">' +
          label +
          "</a>"
        );
      },
    );
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return "<code>" + code[Number(index)] + "</code>";
    });
    return text;
  }

  function splitBlocks(text) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let index = 0;

    function isHeading(line) {
      return /^(#{1,6})\s+/.test(line);
    }
    function isRule(line) {
      return /^\s*([-*_])\1{2,}\s*$/.test(line);
    }
    function isQuote(line) {
      return /^>\s?/.test(line);
    }
    function isBullet(line) {
      return /^\s*[-*+]\s+/.test(line);
    }
    function isNumbered(line) {
      return /^\s*\d+[.)]\s+/.test(line);
    }

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      if (line.trim().startsWith("```")) {
        const start = index;
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push(lines.slice(start, index).join("\n"));
        continue;
      }

      if (isHeading(line) || isRule(line) || isQuote(line)) {
        blocks.push(line);
        index += 1;
        continue;
      }

      if (isBullet(line) || isNumbered(line)) {
        const ordered = isNumbered(line);
        const start = index;
        index += 1;
        while (index < lines.length) {
          const next = lines[index];
          if (!next.trim()) break;
          const continues =
            (ordered ? isNumbered(next) : isBullet(next)) ||
            /^\s{2,}\S/.test(next);
          if (!continues) break;
          index += 1;
        }
        blocks.push(lines.slice(start, index).join("\n"));
        continue;
      }

      const start = index;
      while (index < lines.length) {
        const next = lines[index];
        if (
          !next.trim() ||
          next.trim().startsWith("```") ||
          isHeading(next) ||
          isRule(next) ||
          isQuote(next) ||
          isBullet(next) ||
          isNumbered(next)
        ) {
          break;
        }
        index += 1;
      }
      if (index === start) index += 1;
      blocks.push(lines.slice(start, index).join("\n"));
    }
    return blocks;
  }

  function renderSource(text) {
    if (!text) return "";
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let fence = null;
    let list = null;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length === 0) return;
      out.push(
        "<p>" + inline(paragraph.join("\n")).replace(/\n/g, "<br>") + "</p>",
      );
      paragraph = [];
    }

    function closeList() {
      if (!list) return;
      out.push("</" + list + ">");
      list = null;
    }

    for (const line of lines) {
      if (fence) {
        if (line.trim().startsWith("```")) {
          const language = fence.language
            ? ' class="language-' + escapeHtml(fence.language) + '"'
            : "";
          out.push(
            "<pre><code" +
              language +
              ">" +
              escapeHtml(fence.lines.join("\n")) +
              "</code></pre>",
          );
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }

      if (line.trim().startsWith("```")) {
        flushParagraph();
        closeList();
        fence = { language: line.trim().slice(3).trim(), lines: [] };
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
        continue;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        flushParagraph();
        closeList();
        out.push("<hr>");
        continue;
      }

      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeList();
        out.push("<blockquote>" + inline(quote[1]) + "</blockquote>");
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + inline(bullet[1]) + "</li>");
        continue;
      }

      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) {
        flushParagraph();
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + inline(numbered[1]) + "</li>");
        continue;
      }

      if (line.trim() === "") {
        flushParagraph();
        closeList();
        continue;
      }

      paragraph.push(line);
    }

    if (fence) {
      out.push(
        "<pre><code>" + escapeHtml(fence.lines.join("\n")) + "</code></pre>",
      );
    }
    flushParagraph();
    closeList();
    return out.join("\n");
  }

  function renderBlocks(text) {
    return splitBlocks(text).map(function (source) {
      return { source: source, html: renderSource(source) };
    });
  }

  function render(text) {
    return renderBlocks(text)
      .map(function (block) {
        return block.html;
      })
      .join("\n");
  }

  globalThis.renderMarkdown = render;
  globalThis.renderMarkdownBlocks = renderBlocks;
})();
