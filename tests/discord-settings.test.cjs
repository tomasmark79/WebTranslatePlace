const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const namespace = process.env.WEBTRANSLATEPLACE_API_NAMESPACE || 'chrome';
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const quiet = { log() {}, debug() {}, warn() {}, error() {} };

function popup(stored = {}, failWrite = false) {
  const nodes = new Map();
  const node = () => ({ checked: true, disabled: true, value: '', textContent: '', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    appendChild() {}, replaceChildren() {} });
  const api = { storage: { local: {
    get: async () => stored,
    set: async change => {
      if (failWrite) throw new Error('Storage unavailable');
      Object.assign(stored, change);
    }
  } }, runtime: { sendMessage: async () => ({ ok: true, entries: [] }) } };
  const context = vm.createContext({ [namespace]: api, console: quiet, URL,
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    }, createElement: node }
  });
  vm.runInContext(source('api-settings.js'), context);
  vm.runInContext(source('popup.js'), context);
  return { nodes, stored };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Discord defaults to enabled and the popup persists both switch positions', async () => {
  const h = popup();
  await settle();
  const toggle = h.nodes.get('discord-enabled');
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  toggle.checked = false;
  await toggle.listeners.change();
  assert.equal(h.stored.translatorActive, false);
  const reopened = popup(h.stored);
  await settle();
  assert.equal(reopened.nodes.get('discord-enabled').checked, false);
  toggle.checked = true;
  await toggle.listeners.change();
  assert.equal(h.stored.translatorActive, true);
});

test('failed preference writes restore the switch and show the error', async () => {
  const h = popup({}, true);
  await settle();
  const toggle = h.nodes.get('discord-enabled');
  toggle.checked = false;
  await toggle.listeners.change();
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.equal(h.nodes.get('discord-status').textContent, 'Storage unavailable');
});

function discord(initialState) {
  let settingsListener;
  const markers = [{ removeAttribute() { this.removed = true; } }];
  const context = vm.createContext({ console: quiet,
    document: { querySelectorAll: () => markers },
    [namespace]: { storage: { onChanged: { addListener(fn) { settingsListener = fn; } } },
      runtime: { id: 'test', onMessage: { addListener() {} },
        sendMessage: async () => JSON.stringify({ isActive: initialState }) } }
  });
  vm.runInContext(source('content.js').split('// MAIN ENTRY POINT')[0] +
    '\nglobalThis.Translator = DiscordTranslator;', context);
  const translator = Object.create(context.Translator.prototype);
  let starts = 0, stops = 0, cleanups = 0;
  Object.assign(translator, { isActive: true, stateRevision: 0,
    context: { isInvalid: false }, translationCache: new Map(), processedMessages: new Set(['message']),
    startProcessing() { if (this.isActive) starts++; },
    stopProcessing() { stops++; }, cleanupTranslations() { cleanups++; } });
  return { translator, context, markers,
    change(value, area = 'local') { settingsListener({ translatorActive: { newValue: value } }, area); },
    target(value) { settingsListener({ translationTarget: { oldValue: 'cs', newValue: value } }, 'local'); },
    get starts() { return starts; }, get stops() { return stops; }, get cleanups() { return cleanups; } };
}

test('saved disabled state prevents Discord processing; changes apply without reload', async () => {
  const h = discord(false);
  await h.translator.start();
  assert.equal(h.starts, 0);
  h.change(true);
  assert.equal(h.starts, 1);
  h.change(false, 'sync');
  assert.equal(h.translator.isActive, true);
  h.change(false);
  assert.equal(h.stops, 1);
  assert.equal(h.cleanups, 1);
  assert.equal(h.translator.processedMessages.size, 0);
  assert.equal(h.markers[0].removed, true);
  h.change(undefined);
  assert.equal(h.translator.isActive, true);
});

test('an old state response cannot undo a preference change during startup', async () => {
  const h = discord(true);
  let respond;
  h.context[namespace].runtime.sendMessage = () => new Promise(resolve => { respond = resolve; });
  const starting = h.translator.start();
  h.change(false);
  respond(JSON.stringify({ isActive: true }));
  await starting;
  assert.equal(h.translator.isActive, false);
  assert.equal(h.starts, 0);
});

test('disabling Discord while a manual request runs discards progress and completion', async () => {
  const h = discord(true);
  let finish, progress;
  Object.assign(h.translator, { messageTranslations: new Map(), translationCache: new Map(),
    extractCleanText: () => 'Hello', setFlagStatus() {},
    displaySingleTranslation() { assert.fail('Disabled translation rendered'); },
    translateText: (_, callback) => { progress = callback; return new Promise(resolve => { finish = resolve; }); } });
  const flag = { classList: { contains: () => false }, setAttribute() {} };
  await h.translator.start();
  const request = h.translator.translateSingleMessage({ isConnected: true }, 'message', flag);
  h.change(false);
  h.change(true);
  progress('Aho');
  finish('Ahoj');
  await request;
  assert.equal(h.translator.translationCache.size, 0);
});


test('Changing the target restores messages, clears the old cache and invalidates running jobs', async () => {
  const h = discord(true);
  await h.translator.start();
  h.translator.translationCache.set('Hello', 'Ahoj');
  const revision = h.translator.stateRevision;
  h.target('de');
  assert.equal(h.translator.translationCache.size, 0);
  assert.equal(h.translator.processedMessages.size, 0);
  assert.equal(h.cleanups, 1);
  assert.equal(h.translator.isActive, true);
  assert.ok(h.translator.stateRevision > revision);
});


test('An old target job cannot render progress or cache its result after the target changes', async () => {
  const h = discord(true);
  let finish, progress;
  Object.assign(h.translator, { messageTranslations: new Map(), translationCache: new Map(),
    extractCleanText: () => 'Hello', setFlagStatus() {},
    displaySingleTranslation() { assert.fail('Old target translation rendered'); },
    translateText: (_, callback) => { progress = callback; return new Promise(resolve => { finish = resolve; }); } });
  const flag = { classList: { contains: () => false }, setAttribute() {} };
  await h.translator.start();
  const request = h.translator.translateSingleMessage({ isConnected: true }, 'message', flag);
  h.target('de');
  progress('Aho');
  finish('Ahoj');
  await request;
  assert.equal(h.translator.translationCache.size, 0);
});
