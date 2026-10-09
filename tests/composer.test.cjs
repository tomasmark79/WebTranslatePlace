const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../src');
const apiNamespace = process.env.WEBTRANSLATEPLACE_API_NAMESPACE || 'chrome';
const JOB_ID = 'a'.repeat(32);

function loadBackground(globals) {
  globals.chrome.storage ??= { local: { get: async () => ({}), set: async () => {} } };
  globals.chrome.storage.local.set ??= async () => {};
  globals.chrome.runtime.onInstalled ??= { addListener() {} };
  globals.chrome.runtime.getManifest ??= () => ({ version: '0.1.0' });
  if (apiNamespace === 'browser') { globals.browser = globals.chrome; delete globals.chrome; }
  // Model the browser's multiple listeners and only claim handled messages.
  const runtime = globals[apiNamespace].runtime;
  const register = runtime.onMessage.addListener;
  const listeners = [];
  runtime.onMessage.addListener = listener => {
    listeners.push(listener);
    register((...args) => {
      for (const handler of listeners) {
        if (handler(...args) === true) return true;
      }
    });
  };
  const context = vm.createContext({ URL, ...globals });
  context.importScripts = file => vm.runInContext(
    fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context);
}

function loadContent(editor, responses = []) {
  const calls = [];
  const backups = [];
  const notices = [];
  let listener;
  const document = {
    activeElement: editor,
    hasFocus: () => true,
    documentElement: { appendChild: notice => notices.push(notice) },
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    execCommand: () => false
  };
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async request => {
      if (request.type === 'backup-save') {
        backups.push(request.text);
        return { ok: true };
      }
      calls.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    }
  } };
  const context = vm.createContext({
    document, window: { getSelection: () => null }, [apiNamespace]: chrome, console, InputEvent: class {
      constructor(type, options) {
        this.type = type;
        this.defaultPrevented = false;
        Object.assign(this, options);
      }
      preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    }, setTimeout: fn => { fn(); }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'selection.js'), 'utf8'), context);
  return { context, calls, backups, notices, listener, document };
}

function textarea(value, start = 0, end = value.length) {
  return {
    tagName: 'TEXTAREA', value, selectionStart: start, selectionEnd: end,
    isConnected: true, disabled: false, readOnly: false,
    events: [],
    setRangeText(replacement, from, to) {
      this.value = this.value.slice(0, from) + replacement + this.value.slice(to);
      this.selectionStart = this.selectionEnd = from + replacement.length;
    },
    dispatchEvent(event) { this.events.push(event); }
  };
}

test('Ctrl+A vybere český text a dokončený překlad ho nahradí bez odeslání', async () => {
  const field = textarea('Ahoj světe');
  const { context, calls, backups, notices } = loadContent(field, [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello world' } }
  ]);
  await vm.runInContext('translateSelection()', context);
  assert.equal(field.value, 'Hello world');
  assert.equal(field.events.length, 1);
  assert.equal(field.events[0].type, 'input');
  assert.deepEqual(backups, ['Ahoj světe']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    q: 'Ahoj světe', source: 'cs', target: 'en'
  });
  assert.equal(calls[1].path, `/translations/${JOB_ID}`);
  assert.equal(notices.length, 0);
});

test('nahradí pouze označenou část, ostatní text zachová', async () => {
  const field = textarea('Před Ahoj za', 5, 9);
  const { context } = loadContent(field, [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello' } }
  ]);
  await vm.runInContext('translateSelection()', context);
  assert.equal(field.value, 'Před Hello za');
});

test('změněný návrh během čekání nikdy nepřepíše', async () => {
  const field = textarea('Ahoj');
  const { context, notices } = loadContent(field);
  context.translate = async () => {
    field.value = 'Ahoj, právě píšu dál';
    return 'Hello';
  };
  await vm.runInContext('translateSelection()', context);
  assert.equal(field.value, 'Ahoj, právě píšu dál');
  assert.match(notices[0].textContent, /Výběr se během překladu změnil/);
});

test('heslo se nepřekládá ani neposílá serveru', async () => {
  const field = { ...textarea('tajné heslo'), tagName: 'INPUT', type: 'password' };
  const { context, calls } = loadContent(field);
  await vm.runInContext('translateSelection()', context);
  assert.equal(calls.length, 0);
  assert.equal(field.value, 'tajné heslo');
});

test('selhání zálohy zabrání překladu a ponechá český text', async () => {
  const field = textarea('Dlouhý český návrh');
  const { context, calls, notices } = loadContent(field);
  context[apiNamespace].runtime.sendMessage = async () => ({
    ok: false, body: { error: 'Úložiště je plné.' }
  });
  await vm.runInContext('translateSelection()', context);
  assert.equal(field.value, 'Dlouhý český návrh');
  assert.equal(calls.length, 0);
  assert.match(notices[0].textContent, /Úložiště je plné/);
});

test('contenteditable předá výběr příkazu insertText', async () => {
  const textNode = { nodeType: 3 };
  const editor = {
    tagName: 'DIV', textContent: 'Ahoj', isConnected: true,
    closest: () => editor, contains: node => node === textNode || node === editor
  };
  const range = {
    startContainer: textNode, endContainer: textNode, startOffset: 0, endOffset: 4,
    cloneRange() { return this; }
  };
  const selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => range, toString: () => 'Ahoj'
  };
  const { context, document } = loadContent(editor, [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello' } }
  ]);
  context.window = { getSelection: () => selection };
  const commands = [];
  document.execCommand = (...args) => { commands.push(args); editor.textContent = args[2]; return true; };
  await vm.runInContext('translateSelection()', context);
  assert.deepEqual(commands, [['insertText', false, 'Hello']]);
  assert.equal(editor.textContent, 'Hello');
});

test('Slate nahradí text přes stav editoru, ne přímou změnou DOM', async () => {
  const textNode = { nodeType: 3 };
  let model = 'Ahoj';
  const editor = {
    tagName: 'DIV', textContent: model, isConnected: true,
    closest: () => editor, contains: node => node === textNode || node === editor,
    matches: selector => selector === '[data-slate-editor]',
    dispatchEvent(event) {
      assert.equal(event.type, 'beforeinput');
      assert.equal(event.inputType, 'insertText');
      assert.equal(event.data, 'Hello');
      event.preventDefault();
      model = event.data;
      this.textContent = model;
    }
  };
  const range = {
    startContainer: textNode, endContainer: textNode, startOffset: 0, endOffset: 4,
    cloneRange() { return this; }
  };
  const selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => range, toString: () => 'Ahoj'
  };
  const { context, document, notices } = loadContent(editor, [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello' } }
  ]);
  context.window = { getSelection: () => selection };
  document.execCommand = () => { throw new Error('Slate nesmí měnit DOM přes execCommand'); };
  await vm.runInContext('translateSelection()', context);
  assert.equal(model, 'Hello');
  assert.equal(editor.textContent, 'Hello');
  assert.equal(notices.length, 0);
});

test('Slate bez potvrzení ponechá český návrh', async () => {
  const textNode = { nodeType: 3 };
  const editor = {
    tagName: 'DIV', textContent: 'Ahoj', isConnected: true,
    closest: () => editor, contains: node => node === textNode || node === editor,
    matches: selector => selector === '[data-slate-editor]',
    dispatchEvent() {}
  };
  const range = {
    startContainer: textNode, endContainer: textNode, startOffset: 0, endOffset: 4,
    cloneRange() { return this; }
  };
  const selection = {
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => range, toString: () => 'Ahoj'
  };
  const { context, document, notices } = loadContent(editor, [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello' } }
  ]);
  context.window = { getSelection: () => selection };
  document.execCommand = () => { throw new Error('Nesmí se měnit pouze DOM'); };
  await vm.runInContext('translateSelection()', context);
  assert.equal(editor.textContent, 'Ahoj');
  assert.match(notices[0].textContent, /Editor překlad nepřijal/);
});

test('Chrome zkratka předá příkaz aktivní kartě', () => {
  let commandHandler;
  const messages = [];
  const chrome = {
    commands: { onCommand: { addListener: fn => { commandHandler = fn; } } },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (id, message) => { messages.push([id, message]); }
    },
    runtime: { onMessage: { addListener() {} } }
  };
  loadBackground({
    chrome, console, fetch, AbortSignal
  });
  commandHandler('translate-selection', { id: 42 });
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [[42, { type: 'translate-selection' }]]);
  commandHandler('other-command', { id: 42 });
  assert.equal(messages.length, 1);
  return Promise.resolve(commandHandler('translate-selection')).then(() => {
    assert.deepEqual(JSON.parse(JSON.stringify(messages[1])), [7, { type: 'translate-selection' }]);
  });
});

test('background předá překlad místnímu serveru a odmítne neznámou cestu', async () => {
  let messageHandler;
  const requests = [];
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage: async () => {} },
    runtime: { onMessage: { addListener: fn => { messageHandler = fn; } } }
  };
  loadBackground({
    chrome, console, AbortSignal,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ status: 'pending', jobId: JOB_ID }) };
    }
  });
  const response = await new Promise(resolve => messageHandler({
    type: 'translation-request', path: '/translate',
    body: { q: 'Ahoj', source: 'cs', target: 'en' }
  }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:5001/translate');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    q: 'Ahoj', source: 'cs', target: 'en'
  });
  const rejected = await new Promise(resolve => messageHandler({
    type: 'translation-request', path: '/anything'
  }, {}, resolve));
  assert.equal(rejected.ok, false);
  assert.equal(requests.length, 1);
});

test('zálohy se ukládají místně, řadí bezpečně a lze je smazat', async () => {
  let messageHandler;
  let stored = [];
  let sequence = 0;
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage: async () => {} },
    runtime: { onMessage: { addListener: fn => { messageHandler = fn; } } },
    storage: { local: {
      get: async () => ({ originalTexts: stored }),
      set: async value => { if ('originalTexts' in value) stored = value.originalTexts; }
    } }
  };
  loadBackground({
    chrome, console, fetch, AbortSignal, URL,
    crypto: { randomUUID: () => String(++sequence) }
  });
  const send = (message, sender = { url: 'https://discord.com/channels/123' }) =>
    new Promise(resolve => messageHandler(message, sender, resolve));
  const results = await Promise.all(Array.from({ length: 51 }, (_, index) =>
    send({ type: 'backup-save', text: `Zpráva ${index}` })));
  assert.ok(results.every(result => result.ok));
  assert.equal(stored.length, 50);
  assert.equal(stored[0].text, 'Zpráva 50');
  assert.equal(stored.at(-1).text, 'Zpráva 1');
  assert.equal(stored[0].site, 'discord.com');
  const listed = await send({ type: 'backup-list' });
  assert.equal(listed.entries.length, 50);
  await send({ type: 'backup-delete', id: stored[0].id });
  assert.equal(stored.length, 49);
  await send({ type: 'backup-clear' });
  assert.equal(stored.length, 0);
});

test('limit historie se ukládá, odmítá neplatné hodnoty a řadí změny se zálohami', async () => {
  let messageHandler;
  let sequence = 0;
  let failWrite = false;
  const stored = {};
  loadBackground({
    chrome: {
      commands: { onCommand: { addListener() {} } },
      runtime: { onMessage: { addListener: fn => { messageHandler = fn; } } },
      storage: { local: {
        get: async () => ({ ...stored }),
        set: async change => {
          if (failWrite) throw new Error('Úložiště není dostupné.');
          Object.assign(stored, change);
        }
      } }
    }, console, crypto: { randomUUID: () => String(++sequence) }
  });
  const send = message => new Promise(resolve => messageHandler(message, {}, resolve));
  assert.equal((await send({ type: 'backup-list' })).limit, 50);
  for (const text of ['První', 'Druhý', 'Třetí']) {
    assert.equal((await send({ type: 'backup-save', text })).ok, true);
  }
  await Promise.all([
    send({ type: 'settings-save', apiUrl: 'https://translator.example/api/', limit: 2 }),
    send({ type: 'backup-save', text: 'Čtvrtý' })
  ]);
  assert.equal(stored.historyLimit, 2);
  assert.equal(stored.translationApiUrl, 'https://translator.example/api');
  assert.deepEqual(Array.from(stored.originalTexts, entry => entry.text), ['Čtvrtý', 'Třetí']);
  const before = JSON.stringify(stored);
  for (const apiUrl of ['invalid', 'file:///tmp/api', 'https://user:secret@example.com']) {
    assert.equal((await send({ type: 'settings-save', apiUrl, limit: 1 })).ok, false);
    assert.equal(JSON.stringify(stored), before);
  }
  for (const limit of [0, -1, 1001, 1.5, '5', null]) {
    assert.equal((await send({ type: 'settings-save', apiUrl: 'https://translator.example/api/', limit })).ok, false);
    assert.equal(JSON.stringify(stored), before);
  }
  failWrite = true;
  assert.equal((await send({ type: 'settings-save', apiUrl: 'https://translator.example/api/', limit: 1 })).ok, false);
  assert.equal(JSON.stringify(stored), before);
  failWrite = false;
  assert.equal((await send({ type: 'settings-save', apiUrl: 'https://translator.example/api/', limit: 1000 })).ok, true);
  assert.equal((await send({ type: 'backup-list' })).limit, 1000);
  await send({ type: 'backup-save', text: 'Pátý' });
  assert.equal(stored.originalTexts.length, 3);
  await send({ type: 'backup-clear' });
  assert.equal((await send({ type: 'backup-list' })).limit, 1000);
});

test('okno rozšíření zpřístupní uložený text ke kopírování', async () => {
  function element() {
    return {
      children: [], listeners: {}, value: '', textContent: '',
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      setAttribute() {}, focus() { this.focused = true; }
    };
  }
  const entries = element();
  const status = element();
  const clear = element();
  const nodes = { entries, status, clear, 'toggle-history': element(),
    'clear-summary': element(), 'clear-confirmation': element(),
    'clear-cancel': element(), 'clear-confirm': element(), 'api-settings': element(),
    'history-limit': element(), 'history-count': element(),
    'discord-enabled': element(), 'discord-status': element(),
    'api-url': element(), 'api-save': element(), 'api-reset': element(), 'api-status': element() };
  const copied = [];
  const document = {
    getElementById: id => nodes[id],
    createElement: element
  };
  const chrome = { storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: async message => {
    assert.equal(message.type, 'backup-list');
    return { ok: true, entries: [{ id: 'one', text: 'Dlouhý český návrh',
      site: 'discord.com', createdAt: 1700000000000 }] };
  } } };
  const context = vm.createContext({ document, [apiNamespace]: chrome,
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    confirm: () => true, Date, console, URL
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'api-settings.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8'), context);
  await vm.runInContext('render()', context);
  assert.equal(entries.children.length, 0);
  await nodes['toggle-history'].listeners.click();
  assert.equal(entries.hidden, false);
  const article = entries.children[0];
  assert.equal(article.children[1].value, 'Dlouhý český návrh');
  assert.match(article.children[0].textContent, /discord.com/);
  await article.children[2].children[0].listeners.click();
  assert.deepEqual(copied, ['Dlouhý český návrh']);
  assert.equal(status.textContent, 'Text je ve schránce.');
  await nodes['toggle-history'].listeners.click();
  assert.equal(entries.hidden, true);
  assert.equal(entries.children.length, 0);
  await vm.runInContext('render()', context);
  assert.equal(entries.children.length, 0);
});

test('uložená adresa včetně základní cesty řídí POST i polling a změna platí ihned', async () => {
  let handler;
  let translationApiUrl = 'https://translator.example/api/';
  const requests = [];
  loadBackground({
    chrome: {
      commands: { onCommand: { addListener() {} } },
      runtime: { onMessage: { addListener: fn => { handler = fn; } } },
      storage: { local: { get: async () => ({ translationApiUrl }) } }
    },
    console, AbortSignal,
    fetch: async (url, options) => {
      requests.push([url, options.method]);
      return { ok: true, json: async () => ({}) };
    }
  });
  const send = path => new Promise(resolve => handler({
    type: 'translation-request', path, body: { q: 'Ahoj' }
  }, {}, resolve));
  assert.equal((await send('/translate')).ok, true);
  assert.equal((await send(`/translations/${JOB_ID}`)).ok, true);
  translationApiUrl = 'http://localhost:6000';
  assert.equal((await send('/translate')).ok, true);
  assert.deepEqual(requests, [
    ['https://translator.example/api/translate', 'POST'],
    [`https://translator.example/api/translations/${JOB_ID}`, 'GET'],
    ['http://localhost:6000/translate', 'POST']
  ]);
});

test('nastavení funguje bez permissions API, odmítne neplatné URL a obnoví výchozí', async () => {
  const nodes = {};
  const document = { getElementById: id => nodes[id] ??= {
    value: '', textContent: '', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    replaceChildren() {}, appendChild() {}
  }, createElement: () => ({}) };
  const stored = { translationApiUrl: 'http://localhost:6000' };
  let storageFailure = false;
  const context = vm.createContext({ document, URL,
    [apiNamespace]: {
      runtime: { sendMessage: async message => {
        if (message.type === 'settings-save') {
          if (storageFailure) return { ok: false, body: { error: 'Úložiště je plné.' } };
          Object.assign(stored, { translationApiUrl: message.apiUrl, historyLimit: message.limit });
        }
        return { ok: true, entries: [], limit: stored.historyLimit ?? 50 };
      } },
      storage: { local: {
        get: async () => stored,
        set: async value => {
          if (storageFailure) throw new Error('Úložiště je plné.');
          Object.assign(stored, value);
        }
      } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'api-settings.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes['api-url'].value, 'http://localhost:6000');
  const submit = async value => {
    nodes['api-url'].value = value;
    await nodes['api-settings'].listeners.submit({ preventDefault() {} });
  };
  await submit(' https://translator.example:8443/api/ ');
  assert.equal(stored.translationApiUrl, 'https://translator.example:8443/api');
  for (const invalid of ['', 'localhost:5001', 'file:///tmp/api',
    'https://user:secret@example.com', 'https://example.com?token=secret',
    'https://example.com#fragment']) {
    await submit(invalid);
    assert.equal(stored.translationApiUrl, 'https://translator.example:8443/api');
  }
  storageFailure = true;
  await submit('https://other.example');
  assert.equal(stored.translationApiUrl, 'https://translator.example:8443/api');
  assert.match(nodes['api-status'].textContent, /Úložiště je plné/);
  storageFailure = false;
  nodes['history-limit'].value = 7;
  await submit(stored.translationApiUrl);
  await nodes['api-reset'].listeners.click();
  assert.equal(stored.historyLimit, 7);
  assert.equal(nodes['history-limit'].value, 50);
  assert.equal(stored.translationApiUrl, 'https://translator.example:8443/api');
  assert.equal(nodes['api-url'].value, 'http://127.0.0.1:5001');
  await submit(nodes['api-url'].value);
  assert.equal(stored.translationApiUrl, 'http://127.0.0.1:5001');
  assert.equal(stored.historyLimit, 50);
  assert.equal(nodes['api-url'].value, stored.translationApiUrl);
  assert.equal(nodes['api-save'].disabled, false);
});


test('výběr drží původní API po změně nastavení během úlohy', async () => {
  const { context, calls } = loadContent(textarea('Ahoj'), [
    { ok: true, body: { status: 'pending', jobId: JOB_ID } },
    { ok: true, body: { status: 'done', translatedText: 'Hello' } }
  ]);
  let server = 'https://first.example/api';
  context[apiNamespace].storage.local.get = async () => ({ translationApiUrl: server });
  const sendMessage = context[apiNamespace].runtime.sendMessage;
  context[apiNamespace].runtime.sendMessage = async request => {
    if (request.type === 'translation-request') server = 'https://second.example';
    return sendMessage(request);
  };
  await vm.runInContext('translateSelection()', context);
  assert.equal(calls[0].apiUrl, 'https://first.example/api');
  assert.equal(calls[1].apiUrl, 'https://first.example/api');
});

test('oba skripty mohou běžet v Discordu bez kolize a bez převzetí cizích zpráv', async () => {
  const field = textarea('Ahoj');
  const { context } = loadContent(field);
  const listeners = [];
  context[apiNamespace].runtime.onMessage.addListener = listener => listeners.push(listener);
  const discord = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8').split('// MAIN ENTRY POINT')[0];
  vm.runInContext(discord + `
    globalThis.discord = Object.create(DiscordTranslator.prototype);
    discord.checkState = async () => {};
    discord.startProcessing = async () => {};
    discord.setActive = active => { globalThis.discordActive = active; };
  `, context);
  await context.discord.start();
  let replies = 0;
  const listener = listeners[0];
  assert.equal(listener({ type: 'translate-selection' }, {}, () => replies++), undefined);
  assert.equal(listener(JSON.stringify({ type: 'unrelated' }), {}, () => replies++), undefined);
  assert.equal(replies, 0);
  assert.equal(listener(JSON.stringify({ type: 'stateChanged', args: [false] }), {}, () => replies++), true);
  assert.equal(context.discordActive, false);
  assert.equal(replies, 1);
});
