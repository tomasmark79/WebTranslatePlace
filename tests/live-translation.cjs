// Optional real API test, including the Chrome or Firefox request origin.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const target = process.argv[2] || 'chrome';
if (!['chrome', 'firefox'].includes(target)) {
  throw new Error('Use chrome or firefox; WebKit origins require browser runtime validation.');
}
const apiNamespace = target === 'chrome' ? 'chrome' : 'browser';
const origin = target === 'chrome'
  ? 'chrome-extension://' + 'a'.repeat(32)
  : 'moz-extension://01234567-89ab-4cde-8fab-0123456789ab';
const apiUrl = process.env.WEBTRANSLATEPLACE_API_URL || 'http://127.0.0.1:5001';
const backgroundListeners = [];
const quiet = { log() {}, debug() {}, warn() {}, error: console.error };
const background = vm.createContext({
  console: quiet, AbortSignal, URL,
  fetch: (url, options) => fetch(url, {
    ...options, headers: { ...options.headers, Origin: origin }
  }),
  [apiNamespace]: {
    commands: { onCommand: { addListener() {} } },
    runtime: {
      onMessage: { addListener: fn => { backgroundListeners.push(fn); } },
      onInstalled: { addListener() {} },
      getManifest: () => ({ version: 'test' })
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  }
});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../src/background.js'), 'utf8'), background);
const content = vm.createContext({
  console: quiet, setTimeout,
  [apiNamespace]: { storage: { local: { get: async () => ({ translationApiUrl: apiUrl }) } }, runtime: { onMessage: { addListener() {} }, sendMessage: message => new Promise(resolve => {
    for (const listener of backgroundListeners) {
      if (listener(message, { url: 'https://discord.com/channels/1/2' }, resolve) === true) break;
    }
  }) } }
});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8').split('// MAIN ENTRY POINT')[0]
  + '\nglobalThis.translate = text => TranslationService.translate(text);', content);
const selection = vm.createContext({
  console: quiet, setTimeout, document: {}, window: {},
  [apiNamespace]: content[apiNamespace]
});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../src/selection.js'), 'utf8')
  + '\nglobalThis.translateDraft = translate;', selection);
(async () => {
  for (const text of [
    'Hello, how are you today? I hope you are having a wonderful day.',
    'Guten Morgen! Können Sie mir bitte helfen? Ich kann den Server nicht starten.',
    'Dobrý den, dnes zkoušíme překlad zpráv do češtiny.'
  ]) {
    const start = Date.now();
    const result = await content.translate(text);
    assert.ok(result.trim());
    if (text.startsWith('Dobrý')) assert.equal(result, text);
    if (text.startsWith('Hello')) {
      assert.match(result, /Ahoj|Dobrý den/i);
      assert.match(result, /Doufám/i);
    }
    console.log(JSON.stringify({ text, result, seconds: (Date.now() - start) / 1000 }));
  }
  const draft = 'Ahoj, dnes zkoušíme překlad českého návrhu do angličtiny.';
  const translated = await selection.translateDraft(draft);
  assert.ok(translated.trim());
  assert.notEqual(translated, draft);
  console.log(JSON.stringify({ draft, translated }));
  const sentence = 'Že by to detekovalo jazyk a ten pak přeložilo do angličtiny?';
  for (const suffix of ['\n ', '\n \uFEFF', '\n \u200B']) {
    const input = sentence + suffix;
    const result = await selection.translateDraft(input);
    assert.ok(result.trim());
    assert.match(result, /English/i);
    assert.ok(result.endsWith('\n '), 'Keep the trailing line break and space');
    assert.ok(!result.includes('\uFEFF') && !result.includes('\u200B'));
    console.log(JSON.stringify({ input, translated: result }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
