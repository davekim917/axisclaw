import { inlineHash, PAGE_STYLE } from './pair-page.js';
import type { ConnectPage } from './slack-send.js';

export const CONNECT_PAGE_CSP = `default-src 'none'; style-src ${inlineHash(PAGE_STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function connectPageHtml({ heading, note, claimLink }: ConnectPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${claimLink ? `<meta http-equiv="refresh" content="0;url=${escape(claimLink)}">\n` : ''}<title>${escape(heading)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${escape(heading)}</h1>
${claimLink ? `<a href="${escape(claimLink)}">Open Anderton</a>\n` : ''}<p>${escape(note)}</p>
</main>
</body>
</html>
`;
}
