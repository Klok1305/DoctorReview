"use strict";

(function (root, factory) {
  const sanitizer = factory();
  if (typeof module === "object" && module.exports) module.exports = sanitizer;
  else root.viewerHtmlSanitizer = sanitizer;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_PAGE_BYTES = 8 * 1024 * 1024;

  function sanitizeReportHtml(value) {
    let html = String(value || "");
    const byteLength = typeof Buffer !== "undefined" ? Buffer.byteLength(html, "utf8") : new TextEncoder().encode(html).length;
    if (byteLength > MAX_PAGE_BYTES) throw new Error("Одна страница отчёта превышает 8 МБ");
    html = html.replace(/<\s*(script|iframe|object|embed|form|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
    html = html.replace(/<\s*(script|iframe|object|embed|form|meta|link|base)\b[^>]*\/?\s*>/gi, "");
    html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    html = html.replace(/\s(?:href|src)\s*=\s*(?:"\s*(?:javascript:|file:|https?:)[^"]*"|'\s*(?:javascript:|file:|https?:)[^']*'|(?:javascript:|file:|https?:)[^\s>]*)/gi, "");
    return html;
  }

  return Object.freeze({ sanitizeReportHtml });
});
