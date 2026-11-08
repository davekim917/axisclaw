import { createHash } from 'crypto';

export const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 17px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 22rem; padding: 2rem 1.5rem; text-align: center; }
  a { display: block; margin: 1.5rem 0; padding: 1.1rem 1rem; border-radius: 0.8rem; background: #1f6feb; color: #fff; text-decoration: none; font-size: 1.25rem; font-weight: 700; }
  p { opacity: 0.8; }
  [hidden] { display: none; }
`;

export const inlineHash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/**
 * A page a DMed link opens, which hands the one-time value in its fragment to the app. The fragment never reaches the
 * host, and the page spends nothing, so a link preview fetching it costs the person nothing.
 */
function linkPage(page: { title: string; deepLink: string; field: string; help: string; incomplete: string }) {
  const script = `
  var value = location.hash.slice(1);
  var open = document.getElementById('open');
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    open.href = ${JSON.stringify(`${page.deepLink}?${page.field}=`)} + encodeURIComponent(value) + '&host=' + encodeURIComponent(location.host);
  } else {
    open.hidden = true;
    document.getElementById('note').textContent = ${JSON.stringify(page.incomplete)};
  }
`;
  return {
    csp: `default-src 'none'; script-src ${inlineHash(script)}; style-src ${inlineHash(PAGE_STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${page.title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${page.title}</h1>
<a id="open">Open in Anderton</a>
<p id="note">${page.help}</p>
</main>
<script>${script}</script>
</body>
</html>
`,
  };
}

export const PAIR_PAGE = linkPage({
  title: 'Pair Anderton',
  deepLink: 'anderton://pair',
  field: 'code',
  help: "If nothing opens, copy this page's link and paste it into the app.",
  incomplete: 'This link is incomplete. Ask your agent to pair the app again.',
});

export const REPLIES_PAGE = linkPage({
  title: 'Reply from Anderton',
  deepLink: 'anderton://replies-enabled',
  field: 'claim',
  help: 'If nothing opens, open this link on the phone that asked for it.',
  incomplete: 'This link is incomplete. Turn on replies in the app again.',
});
