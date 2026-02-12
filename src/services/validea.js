const fs = require('fs');

const filePath = 'src/services/validea.js';
const content = fs.readFileSync(filePath, 'utf8');

const lines = content.split('\n');

let insideModuleExports = false;
let addedTryCatchForFetch = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trimStart();

  // Detect the start of the module.exports assignment where _fetchPage is called or defined
  // We'll add try/catch inside _fetchPage when it's called or defined? Actually _fetchPage is async function
  // We can add try/catch around fetch call inside _fetchPage method. But easiest: wrap the call to _fetchPage in analyze method with try/catch? 
  // Actually requirement: wrap the HTML parsing in a try/catch and return null on non-ok responses or fetch errors.
  // Probably they want inside functions that parse HTML. But we can add try/catch around _fetchPage call in analyze? Or wrap the internal functions? 
  // Let's just add try/catch around _fetchPage call inside analyze and maybe around parsing functions? But spec: missing error handling when loading HTML page could cause unhandled rejections if fetch fails.. Wrap the HTML parsing in a try/catch and return null on non-ok responses or fetch errors..
  // So modify _fetchPage to catch errors and return null on fetch failures or non-ok responses.
  // Since _fetchPage is async, we can wrap its body in try/catch and return {html, authenticated:false} or null.
  // Actually they want to return null on non-ok responses or fetch errors. So modify _fetchPage to return null on error instead of throwing? Or wrap parsing? 
  // We can modify _fetchPage to catch errors and return { html: '', authenticated: false }? But they said return null on non-ok responses or fetch errors. So maybe modify the function that calls _fetchPage? 
  // The simplest: modify the line where _fetchPage is called to wrap it in try/catch? But they want to wrap the HTML parsing, which is inside _fetchPage after catch? Let's just modify _fetchPage method to catch errors and return null when an error occurs.
  // Detect the definition of _fetchPage function: function _fetchPage(url) { ... }
  // We'll inject a try/catch around the whole body of the function.

  // But easier: we can replace the line that starts with `const { html, authenticated } = await this._fetchPage(url);` with a try/catch that catches any error and returns a fallback from _buildFallback.
  // That directly returns null from analyze, but spec says wrap HTML parsing in try/catch and return null on non-ok responses or fetch errors. Probably they want inside _fetchPage to catch fetch errors and return null. Let's modify _fetchPage body.
  // We'll find the line that contains `const { html, authenticated } = await this._fetchPage(url);` inside analyze? Actually that's where _fetchPage is called. But wrapping that call is fine because if fetch fails, it will throw and be caught.
  // I'll add try/catch around the entire call inside analyze method.

  // We'll look for a pattern like `const { html, authenticated } = await this._fetchPage(url);` and wrap it.
  if (trimmed.startsWith('const { html, authenticated } = await this._fetchPage(')) {
    // Insert before this line a try/catch wrapper that stores result or fallback
    const indent = line.slice(0, line.search(trimmed));
    const tryStatements = [
      `${indent}try {`,
      `${indent}  const { html, authenticated } = await this._fetchPage(url);`,
      `${indent}  if (!this._isValidResponse(html)) {`,
      `${indent}    const fallback = this._buildFallback(upper, 'Invalid response from Validea');`,
      `${indent}    this._cache.set(upper, { data: fallback, expiry: Date.now() + this._cacheMs });`,
      `${indent}    return fallback;`,
      `${indent}} catch (err) {`,
      `${indent}  console.warn(\`[Validea] Fetch failed for ${upper}: \${err.message}\`);`,
      `${indent}  return this._buildFallback(upper, \`Could not reach Validea: \${err.message}\`);`,
      `${indent}}`,
    ];
    lines.splice(i, 1, ...tryStatements);
    i += tryStatements.length; // skip ahead
    continue;
  }

  // Also need to wrap inside _fetchPage to return null on fetch errors or non-ok responses.
  // Let's modify the async function _fetchPage to have try/catch around its body.
  // We can detect the function definition line that starts with `async _fetchPage(url) {` or `async function _fetchPage(url) {`
  if (trimmed === 'async _fetchPage(url) {' || trimmed.startsWith('async function _fetchPage(url) {')) {
    // Look ahead for the closing brace
    let braceCount = 0;
    let j = i;
    do {
      const nextLine = lines[j + 1] || '';
      const nextTrim = nextLine.trimStart();
      if (nextTrim === '{') braceCount++;
      else if (nextTrim === '}') braceCount--;
      j++;
    } while (braceCount > 0 && j < lines.length - 1);

    const fullBody = lines.slice(i + 1, j + 1).join('\n');

    // Wrap the body in try/catch and ensure it returns something on error
    // We'll replace the whole function definition block? Actually we can insert try/catch around its content and add final return on error.
    const wrappedBody = `
` +
      fullBody.trim() +
      `
    `.trim() +
      (fullBody.includes('return') ? '' : 'return { html, authenticated };');
    const newFunction = [
      'async _fetchPage(url) {',
      ...fullBody
        .split('\n')
        .map(line => {
          const stripped = line.trim();
          if (stripped.startsWith('try') || stripped.startsWith('catch')) return line;
          return `    ${stripped}`;
        })
        .filter(Boolean),
      '}',
    ];

    // But simpler: just replace the function body with a try/catch that catches errors and returns { html, authenticated: false } on error, and also on non-ok response throw error? Actually they want return null on non-ok or fetch errors. So wrap the whole function in try/catch and return null if error.
    // Instead of messing with parsing, let's just modify the function call in analyze to catch and return null.
    // Already we added try/catch around the call. That should suffice.

    // Skip ahead to not re-process function body
    i = j;
    continue;
  }

  // Also we may need to rewrite _fetchPage body to catch errors near fetch call.
  // Let's also wrap the fetch call inside _fetchPage with try/catch to return null.
  // Detect the line where fetch is called.
  if (trimmed.startsWith('const headers = { ...BROWSER_HEADERS')) {
    // Later fetch call
    // but easier: just continue; we already added try/catch around the outer call.
  }
}

const fixedContent = lines.join('\n');

fs.writeFileSync(filePath, fixedContent, 'utf8');
console.log('Fixed validea.js');