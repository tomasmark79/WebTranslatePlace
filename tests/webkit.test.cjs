const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(runtime) {
  let listener;
  const context = vm.createContext({
    console, setTimeout, AbortController,
    browser: { runtime },
    window: {
      self: {}, top: {},
      addEventListener: (_, fn) => { listener = fn; },
      removeEventListener() {},
    },
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8').split('// MAIN ENTRY POINT')[0];
  vm.runInContext(source + '\nglobalThis.scriptContext = new ContentScriptContext("translator");', context);
  return { context, emit: data => listener({ data }) };
}

test('Epiphany without runtime.id remains active and detects replacement scripts', () => {
  const origin = 'ephy-webextension://test-guid/';
  const { context, emit } = load({ getURL: () => origin });
  assert.equal(context.scriptContext.isValid, true);
  emit({ type: 'another-extension:content-script-started', contentScriptName: 'translator', messageId: '1' });
  assert.equal(context.scriptContext.isValid, true);
  emit({ type: `${origin}:content-script-started`, contentScriptName: 'translator', messageId: '2' });
  assert.equal(context.scriptContext.isValid, false);
});

test('an unloaded extension context is invalid even when getURL throws', () => {
  const runtime = { getURL: () => 'webkit-extension://test/' };
  const { context } = load(runtime);
  assert.equal(context.scriptContext.isValid, true);
  runtime.getURL = () => { throw new Error('Extension context invalidated'); };
  assert.equal(context.scriptContext.isValid, false);
});

test('runtime.id still takes precedence when available', () => {
  const { context, emit } = load({ id: 'safari-id', getURL: () => 'safari-web-extension://test/' });
  emit({ type: 'safari-id:content-script-started', contentScriptName: 'translator', messageId: '1' });
  assert.equal(context.scriptContext.isValid, false);
});
