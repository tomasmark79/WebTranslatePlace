const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const namespace = process.env.WEBTRANSLATEPLACE_API_NAMESPACE || 'chrome';
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const quiet = { log() {}, debug() {}, warn() {}, error() {} };

function tracker() {
  const listeners = new Map();
  return { listeners, addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); } };
}

function scheduler() {
  const timers = new Map();
  let sequence = 0;
  let observer;
  let scans = 0;
  const document = { ...tracker(), body: {}, hidden: false };
  const window = tracker();
  const context = vm.createContext({ console: quiet, document, window,
    setTimeout: fn => { timers.set(++sequence, fn); return sequence; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => { throw new Error('Periodic scanning is forbidden'); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    },
    [namespace]: {}
  });
  vm.runInContext(source('content.js').split('// MAIN ENTRY POINT')[0] +
    '\nglobalThis.Translator = DiscordTranslator;', context);
  const translator = Object.create(context.Translator.prototype);
  Object.assign(translator, {
    context: { isInvalid: false }, isActive: true, processingStarted: false,
    processingTimer: null, processingDirty: false, isTranslating: false,
    FLAG_CONTAINER_CLASS: 'discord-translator-flag-container',
    TRANSLATION_CLASS: 'discord-translator-translation',
    translationCache: new Map(), processMessageBatch: async () => { scans++; }
  });
  translator.onPageChange = () => translator.scheduleProcessing();
  translator.onVisibilityChange = () => translator.updateVisibility();
  const flush = async () => {
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  return { translator, document, window, timers, flush,
    get observer() { return observer; }, get scans() { return scans; } };
}

const node = (markup = false, own = false) => ({
  nodeType: 1,
  closest(selector) { return (selector.includes('[class*="markup"]') ? markup : own) ? this : null; },
  matches(selector) { return selector.includes('[class*="markup"]') ? markup : own; },
  querySelector() { return null; }
});

test('Discord startup outside supported hosts does no work', () => {
  for (const hostname of ['example.com', 'discord.com.example.com', 'support.discord.com']) {
    const context = vm.createContext({ [namespace]: {},
      location: { hostname, protocol: 'https:' }, window: {}, console: quiet });
    // No document/timers/storage are provided: touching them would fail.
    vm.runInContext(source('content.js'), context);
    assert.equal(context.window.discordTranslator, undefined);
  }
});

test('selection script is idle until invoked', () => {
  let registrations = 0;
  vm.runInNewContext(source('selection.js'), {
    [namespace]: { runtime: { onMessage: { addListener() { registrations++; } } } }
  });
  assert.equal(registrations, 1);
});

test('idle Discord has no polling, ignores unrelated and own DOM changes, batches message changes', async () => {
  const h = scheduler();
  await h.translator.startProcessing();
  await h.flush();
  assert.equal(h.scans, 1);
  assert.equal(typeof h.document.listeners.get('click'), 'function');
  assert.equal(h.timers.size, 0);
  h.observer.callback([{ type: 'characterData', target: node() }]);
  h.observer.callback([{ type: 'childList', target: node(true),
    addedNodes: [node(false, true)], removedNodes: [] }]);
  assert.equal(h.timers.size, 0);
  for (let i = 0; i < 100; i++) {
    h.observer.callback([{ type: 'childList', target: node(true),
      addedNodes: [node()], removedNodes: [] }]);
  }
  assert.equal(h.timers.size, 1);
  await h.flush();
  assert.equal(h.scans, 2);
  assert.equal(h.timers.size, 0);
});

test('hidden Discord pauses scans, resumes on visibility and disconnects on stop', async () => {
  const h = scheduler();
  await h.translator.startProcessing();
  await h.flush();
  h.document.listeners.get('scroll')();
  assert.equal(h.timers.size, 1);
  h.document.hidden = true;
  h.document.listeners.get('visibilitychange')();
  assert.equal(h.timers.size, 0);
  assert.equal(h.observer.connected, false);
  h.observer.callback([{ type: 'characterData', target: node(true) }]);
  assert.equal(h.timers.size, 0);
  h.document.hidden = false;
  h.document.listeners.get('visibilitychange')();
  await h.flush();
  assert.equal(h.scans, 2);
  const observer = h.observer;
  h.document.listeners.get('scroll')();
  h.translator.stopProcessing();
  assert.equal(h.timers.size, 0);
  assert.equal(observer.connected, false);
  assert.equal(h.document.listeners.size, 0);
  assert.equal(h.window.listeners.size, 0);
});

test('changes during a slow batch trigger one follow-up scan', async () => {
  const h = scheduler();
  await h.translator.startProcessing();
  await h.flush();
  let finish;
  h.translator.processMessageBatch = () => new Promise(resolve => { finish = resolve; });
  const pending = h.translator.processMessages();
  h.translator.scheduleProcessing();
  h.translator.scheduleProcessing();
  assert.equal(h.timers.size, 0);
  finish();
  await pending;
  assert.equal(h.timers.size, 1);
  h.translator.stopProcessing();
});

test('translation cache remains bounded and refreshes reused entries', () => {
  const h = scheduler();
  for (let i = 0; i < 200; i++) h.translator.cacheTranslation(String(i), 'translation');
  h.translator.cacheTranslation('0', 'refreshed');
  h.translator.cacheTranslation('200', 'new');
  assert.equal(h.translator.translationCache.size, 200);
  assert.equal(h.translator.translationCache.get('0'), 'refreshed');
  assert.equal(h.translator.translationCache.has('1'), false);
});

test('background loads Discord state only on Discord requests', async () => {
  const listeners = [];
  let reads = 0;
  let writes = 0;
  const context = vm.createContext({ URL, console: quiet,
    [namespace]: {
      commands: { onCommand: { addListener() {} } },
      runtime: { onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: { addListener() {} } },
      storage: { local: { get: async () => { reads++; return { translatorActive: false }; },
        set: async () => { writes++; } } }
    }
  });
  vm.runInContext(source('background.js'), context);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  const listener = listeners[1];
  const message = JSON.stringify({ type: 'getState', args: [] });
  for (const url of ['https://example.com/', 'https://discord.com.example.com/', 'https://support.discord.com/']) {
    assert.equal(listener(message, { url }, () => assert.fail('Offsite Discord response')), undefined);
  }
  assert.equal(reads, 0);
  const reply = await new Promise(resolve => listener(message,
    { url: 'https://discord.com/channels/1/2' }, resolve));
  assert.equal(JSON.parse(reply).isActive, false);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});
