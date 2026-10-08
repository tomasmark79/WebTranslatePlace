const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const apiNamespace = process.env.WEBTRANSLATEPLACE_API_NAMESPACE || 'chrome';

function load(responses) {
  const requests = [];
  const context = vm.createContext({
    console, setTimeout,
    [apiNamespace]: { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async message => {
      requests.push(JSON.parse(message));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    } } }
  });
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8').split('// MAIN ENTRY POINT')[0];
  vm.runInContext(source + `\nCONFIG.POLL_INTERVAL_MS = 0;
    globalThis.service = TranslationService;
    globalThis.Translator = DiscordTranslator;
    globalThis.config = CONFIG;`, context);
  return { context, requests };
}
const envelope = (body, ok = true, status = 200) => ({ ok, status, text: JSON.stringify(body) });
const job = { status: 'pending', jobId: 'a'.repeat(32) };

test('překlad projde obálkou background skriptu a čekáním na úlohu', async () => {
  const { context, requests } = load([
    envelope(job, true, 202), envelope({ status: 'pending' }),
    envelope({ status: 'done', translatedText: 'Ahoj světe' })
  ]);
  assert.equal(await context.service.translate('Hello world'), 'Ahoj světe');
  assert.deepEqual(JSON.parse(requests[0].args[1].body), { q: 'Hello world', source: 'auto', target: 'cs' });
  assert.equal(requests[0].args[0], 'http://127.0.0.1:5001/translate');
  assert.equal(requests[2].args[1].method, 'GET');
});

test('rozpracovaný překlad se předává během čekání', async () => {
  const { context } = load([
    envelope(job, true, 202), envelope({ status: 'pending', partialText: 'Ah' }),
    envelope({ status: 'pending', partialText: 'Aho' }),
    envelope({ status: 'done', translatedText: 'Ahoj' })
  ]);
  const progress = [];
  assert.equal(await context.service.translate('Hello', text => progress.push(text)), 'Ahoj');
  assert.deepEqual(progress, ['Ah', 'Aho']);
});

test('uložená adresa platí pro nové úlohy, polling zůstane na původním serveru', async () => {
  const { context, requests } = load([
    envelope(job), envelope({ status: 'done', translatedText: 'Ahoj' }),
    envelope(job), envelope({ status: 'done', translatedText: 'Zdravím' })
  ]);
  let apiUrl = 'https://first.example:8443/api';
  context[apiNamespace].storage.local.get = async () => ({ translationApiUrl: apiUrl });
  const sendMessage = context[apiNamespace].runtime.sendMessage;
  context[apiNamespace].runtime.sendMessage = async message => {
    apiUrl = 'http://second.example:5002';
    return sendMessage(message);
  };
  assert.equal(await context.service.translate('Hello'), 'Ahoj');
  assert.equal(requests[0].args[0], 'https://first.example:8443/api/translate');
  assert.equal(requests[1].args[0], `https://first.example:8443/api/translations/${job.jobId}`);
  assert.equal(await context.service.translate('Hi'), 'Zdravím');
  assert.equal(requests[2].args[0], 'http://second.example:5002/translate');
});

for (const [name, responses, error] of [
  ['nedostupný server', [{ error: 'Failed to fetch' }], /Failed to fetch/],
  ['plná fronta', [envelope({ error: 'Fronta je plná' }, false, 429)], /Fronta/],
  ['chyba modelu', [envelope(job), envelope({ status: 'failed', error: 'Chyba modelu' })], /Chyba modelu/],
  ['prázdný překlad', [envelope(job), envelope({ status: 'done', translatedText: '' })], /nevrátil přeložený/],
  ['neplatné ID', [envelope({ status: 'pending', jobId: '../health' })], /platné ID/],
  ['neplatný JSON', [{ ok: true, text: '<html>' }], /neplatnou odpověď/]
]) {
  test(name, async () => {
    const { context } = load(responses);
    await assert.rejects(context.service.translate('Hello'), error);
  });
}

test('čekání na překlad má konečný limit', async () => {
  const { context } = load([envelope(job)]);
  context.config.TRANSLATION_TIMEOUT_MS = -1;
  await assert.rejects(context.service.translate('Hello'), /Vypršel čas/);
});

test('chyba ručního překladu umožní opakování a neuloží chybu do cache', async () => {
  const { context } = load([]);
  const translator = Object.create(context.Translator.prototype);
  Object.assign(translator, {
    messageTranslations: new Map(), translationCache: new Map(),
    extractCleanText: () => 'Hello',
    displaySingleTranslation: () => {},
    updateTranslation: () => {},
    translateText: async () => { throw new Error('Server neběží'); }
  });
  const flag = fakeElement('BUTTON');
  await translator.translateSingleMessage({}, '1', flag);
  assert.equal(flag.classList.contains('translating'), false);
  assert.equal(translator.translationCache.size, 0);
  assert.match(flag.title, /Server neběží/);
  translator.translateText = async () => 'Ahoj';
  translator.displaySingleTranslation = (_, text) => assert.equal(text, 'Ahoj');
  translator.removeTranslationIcon = () => {};
  await translator.translateSingleMessage({}, '1', flag);
  assert.equal(translator.translationCache.get('Hello'), 'Ahoj');
});

test('pomalý automatický překlad se při dalším cyklu nespustí podruhé', async () => {
  const { context } = load([]);
  const translator = Object.create(context.Translator.prototype);
  let finish;
  let calls = 0;
  translator.processMessageBatch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = translator.processMessages();
  await translator.processMessages();
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(translator.isTranslating, false);
  translator.processMessageBatch = async () => { throw new Error('failure'); };
  await assert.rejects(translator.processMessages(), /failure/);
  assert.equal(translator.isTranslating, false);
});

test('background sdělí adresu, pokud síťové spojení selže', async () => {
  let listener;
  const context = vm.createContext({
    console: { log() {}, debug() {}, warn() {}, error() {} },
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    AbortSignal, URL,
    [apiNamespace]: {
      commands: { onCommand: { addListener() {} } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        onInstalled: { addListener() {} },
        getManifest: () => ({ version: 'test' })
      },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    }
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../src/background.js'), 'utf8'), context);
  const reply = await new Promise(resolve => listener(JSON.stringify({
    type: 'fetch', args: ['http://127.0.0.1:5001/translate', { method: 'POST' }]
  }), { url: 'https://discord.com/channels/1/2' }, resolve));
  assert.match(JSON.parse(reply).error, /127\.0\.0\.1:5001.*Failed to fetch/);
});

function fakeStyle(initial = '') {
  const values = new Map(initial ? [['display', [initial, '']]] : []);
  return {
    getPropertyValue: key => values.get(key)?.[0] || '',
    getPropertyPriority: key => values.get(key)?.[1] || '',
    setProperty: (key, value, priority = '') => values.set(key, [value, priority]),
    removeProperty: key => values.delete(key)
  };
}

function fakeElement(tagName = 'DIV') {
  const attributes = new Map();
  const classes = new Set();
  return {
    tagName, textContent: '', isConnected: true, parentElement: null,
    style: fakeStyle(), hidden: false, children: [],
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, active) => active ? classes.add(name) : classes.delete(name)
    },
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key),
    removeAttribute: key => attributes.delete(key),
    insertBefore(child, sibling) {
      const index = this.children.indexOf(sibling);
      child.parentElement = this;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
      }
      this.isConnected = false;
    },
    querySelector: () => null
  };
}

test('pole pro psaní se nezamění za odeslanou zprávu', () => {
  const { context } = load([]);
  const translator = Object.create(context.Translator.prototype);
  const editor = fakeElement();
  const draft = fakeElement();
  draft.className = 'markup';
  editor.insertBefore(draft);
  draft.closest = selector => selector.includes('[contenteditable]') ? editor : null;
  context.document = { body: fakeElement() };

  assert.equal(translator.isMessageBeingEdited(draft), true);
  assert.equal(translator.createFlagIcon(draft, 'draft'), null);
  assert.equal(editor.children.length, 1);

  const message = fakeElement();
  const messageContainer = fakeElement();
  messageContainer.role = 'article';
  messageContainer.insertBefore(message);
  message.closest = () => null;
  assert.equal(translator.isMessageBeingEdited(message), false);
});

test('ruční kliknutí zamění viditelný text a další kliknutí vrátí originál bez API', async () => {
  const { context } = load([]);
  context.document = { createElement: tag => fakeElement(tag.toUpperCase()), querySelectorAll: () => [] };
  const translator = Object.create(context.Translator.prototype);
  const parent = fakeElement();
  const original = fakeElement();
  original.textContent = 'Hello world';
  original.className = 'markupContent text16';
  original.style = fakeStyle('block');
  original.style.cssText = 'font-size: 15px; line-height: 20px;';
  parent.insertBefore(original);
  const iconContainer = fakeElement();
  const icon = fakeElement('BUTTON');
  icon.closest = () => iconContainer;
  parent.insertBefore(iconContainer);
  let calls = 0;
  Object.assign(translator, {
    context: { isInvalid: false }, messageTranslations: new Map(),
    translationCache: new Map(), processedMessages: new Set(),
    TRANSLATION_CLASS: 'discord-translator-translation',
    FLAG_CONTAINER_CLASS: 'discord-translator-flag-container',
    extractCleanText: () => 'Hello world',
    isMessageBeingEdited: () => false,
    translateText: async () => { calls++; return 'Ahoj světe'; }
  });

  await translator.translateSingleMessage(original, '1', icon);
  const state = translator.messageTranslations.get('1');
  assert.equal(parent.children[0], state.translatedElement);
  assert.equal(original.textContent, 'Hello world');
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(state.translatedElement.textContent, 'Ahoj světe');
  assert.equal(state.translatedElement.className, 'markupContent text16 discord-translator-translation');
  assert.equal(state.translatedElement.style.cssText, original.style.cssText);
  assert.equal(state.translatedElement.getAttribute('lang'), 'cs');
  assert.equal(icon.title, 'Zobrazit originál');
  assert.equal(icon.classList.contains('translating'), false);
  assert.equal(icon.classList.contains('translation-complete'), true);
  assert.equal(icon.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(icon.innerHTML, /<animate/);
  assert.equal(icon.getAttribute('aria-pressed'), 'true');
  assert.equal(calls, 1);

  await translator.translateSingleMessage(original, '1', icon);
  assert.equal(original.style.getPropertyValue('display'), 'block');
  assert.equal(state.translatedElement.hidden, true);
  assert.equal(icon.title, 'Zobrazit překlad');
  assert.equal(icon.classList.contains('translation-complete'), true);
  assert.equal(calls, 1);

  await translator.translateSingleMessage(original, '1', icon);
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(state.translatedElement.hidden, false);
  original.textContent = 'Edited original';
  translator.reconcileTranslations();
  assert.equal(original.style.getPropertyValue('display'), 'block');
  assert.equal(translator.messageTranslations.size, 0);
  assert.equal(parent.children.includes(state.translatedElement), false);
  // Obnovení kanálu musí také vrátit původní styl zprávy.
  original.textContent = 'Hello world';
  await translator.translateSingleMessage(original, '1', icon);
  translator.cleanupTranslations();
  assert.equal(original.style.getPropertyValue('display'), 'block');
  assert.equal(parent.children.includes(state.translatedElement), false);
  assert.equal(translator.messageTranslations.size, 0);
});

test('automatický režim vytvoří přepínač a nahradí originál', () => {
  const { context } = load([]);
  context.document = { createElement: tag => fakeElement(tag.toUpperCase()) };
  const translator = Object.create(context.Translator.prototype);
  const parent = fakeElement();
  const original = fakeElement();
  original.textContent = 'Hello';
  parent.insertBefore(original);
  const icon = fakeElement('BUTTON');
  Object.assign(translator, {
    messageTranslations: new Map(), processedMessages: new Set(),
    TRANSLATION_CLASS: 'discord-translator-translation',
    FLAG_ICON_CLASS: 'discord-translator-flag-icon',
    isMessageBeingEdited: () => false,
    createFlagIcon: () => ({ firstElementChild: icon })
  });
  translator.displayTranslation(original, 'Ahoj', 0, '2');
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(translator.messageTranslations.get('2').translatedElement.textContent, 'Ahoj');
  translator.toggleTranslation('2');
  assert.equal(original.style.getPropertyValue('display'), '');
  assert.equal(translator.messageTranslations.get('2').translatedElement.hidden, true);
});

test('průběžný překlad mění stejný uzel a během generování lze přepnout na originál', async () => {
  const { context } = load([]);
  context.document = { createElement: tag => fakeElement(tag.toUpperCase()) };
  const translator = Object.create(context.Translator.prototype);
  const parent = fakeElement();
  const original = fakeElement();
  original.textContent = 'Hello';
  parent.insertBefore(original);
  const icon = fakeElement('BUTTON');
  let report;
  let finish;
  Object.assign(translator, {
    messageTranslations: new Map(), translationCache: new Map(),
    TRANSLATION_CLASS: 'discord-translator-translation',
    FLAG_CONTAINER_CLASS: 'discord-translator-flag-container',
    extractCleanText: () => 'Hello', isMessageBeingEdited: () => false,
    translateText: (_text, onProgress) => new Promise(resolve => {
      report = onProgress; finish = resolve;
    })
  });
  const pending = translator.translateSingleMessage(original, '1', icon);
  assert.equal(translator.messageTranslations.has('1'), false);
  assert.equal(icon.classList.contains('translating'), true);
  assert.equal(icon.classList.contains('translation-complete'), false);
  assert.equal(icon.getAttribute('aria-busy'), 'true');
  assert.equal(original.style.getPropertyValue('display'), '');
  assert.equal(parent.children.length, 1);
  report('Ah');
  const state = translator.messageTranslations.get('1');
  const translatedElement = state.translatedElement;
  assert.equal(translatedElement.textContent, 'Ah');
  assert.equal(original.style.getPropertyValue('display'), 'none');
  await translator.translateSingleMessage(original, '1', icon);
  assert.equal(original.style.getPropertyValue('display'), '');
  report('Aho');
  assert.equal(icon.classList.contains('translating'), true);
  assert.equal(translatedElement.textContent, 'Aho');
  assert.equal(translatedElement.hidden, true);
  finish('Ahoj');
  await pending;
  assert.equal(state.translatedElement, translatedElement);
  assert.equal(state.complete, true);
  assert.equal(icon.classList.contains('translating'), false);
  assert.equal(icon.classList.contains('translation-complete'), true);
  assert.equal(icon.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(icon.innerHTML, /<animate/);
  assert.equal(translatedElement.textContent, 'Ahoj');
  assert.equal(translator.translationCache.get('Hello'), 'Ahoj');
  assert.equal(original.style.getPropertyValue('display'), '');
  await translator.translateSingleMessage(original, '1', icon);
  assert.equal(translatedElement.hidden, false);
  assert.equal(icon.title, 'Zobrazit originál');
  assert.equal(icon.classList.contains('translating'), false);
  assert.equal(icon.classList.contains('translation-complete'), true);
  assert.equal(icon.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(icon.innerHTML, /<animate/);
});

test('další prvek se stejným ID ani obnovený styl neschová hotový překlad', async () => {
  const { context } = load([]);
  const original = fakeElement();
  original.textContent = 'Hello';
  const duplicate = fakeElement();
  duplicate.textContent = 'Other markup';
  const parent = fakeElement();
  parent.insertBefore(original);
  parent.insertBefore(duplicate);
  context.document = {
    createElement: tag => fakeElement(tag.toUpperCase()),
    querySelectorAll: () => [original, duplicate]
  };
  const translator = Object.create(context.Translator.prototype);
  const icon = fakeElement('BUTTON');
  icon.closest = () => null;
  Object.assign(translator, {
    messageTranslations: new Map(), processedMessages: new Set(['1']),
    TRANSLATION_CLASS: 'discord-translator-translation',
    FLAG_CONTAINER_CLASS: 'discord-translator-flag-container',
    getMessageId: () => '1', isMessageBeingEdited: () => false
  });
  translator.displaySingleTranslation(original, 'Ahoj', '1', icon);
  const state = translator.messageTranslations.get('1');
  await translator.addFlagIcons();
  assert.equal(translator.messageTranslations.get('1'), state);
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(state.translatedElement.textContent, 'Ahoj');

  original.style.removeProperty('display');
  await translator.addFlagIcons();
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(translator.messageTranslations.get('1'), state);
});

test('po odstranění přeloženého uzlu Discordem se hotový překlad obnoví', async () => {
  const { context } = load([]);
  const original = fakeElement();
  original.textContent = 'Hello';
  const parent = fakeElement();
  parent.insertBefore(original);
  context.document = {
    createElement: tag => fakeElement(tag.toUpperCase()),
    querySelectorAll: () => [original]
  };
  const translator = Object.create(context.Translator.prototype);
  const icon = fakeElement('BUTTON');
  icon.closest = () => null;
  Object.assign(translator, {
    messageTranslations: new Map(), processedMessages: new Set(['1']),
    TRANSLATION_CLASS: 'discord-translator-translation',
    FLAG_CONTAINER_CLASS: 'discord-translator-flag-container',
    getMessageId: () => '1', isMessageBeingEdited: () => false,
    hasFlagNearby: () => false, shouldSkipMessage: () => false,
    isElementVisible: () => true, analyzeMessageStructure: () => {},
    createFlagIcon: () => ({ firstElementChild: icon })
  });
  translator.displaySingleTranslation(original, 'Ahoj', '1', icon);
  translator.messageTranslations.get('1').translatedElement.remove();
  await translator.addFlagIcons();
  assert.equal(original.style.getPropertyValue('display'), 'none');
  assert.equal(translator.messageTranslations.get('1').translatedElement.textContent, 'Ahoj');
  assert.equal(translator.processedMessages.has('1'), true);
});


test('hotový překlad z cache má fajfku a žádnou nekonečnou SVG animaci', async () => {
  const { context } = load([]);
  context.document = { createElement: tag => fakeElement(tag.toUpperCase()) };
  const translator = Object.create(context.Translator.prototype);
  const parent = fakeElement();
  const original = fakeElement();
  original.textContent = 'Hello';
  parent.insertBefore(original);
  const icon = fakeElement('BUTTON');
  Object.assign(translator, {
    messageTranslations: new Map(), translationCache: new Map([['Hello', 'Ahoj']]),
    TRANSLATION_CLASS: 'discord-translator-translation',
    extractCleanText: () => 'Hello', isMessageBeingEdited: () => false,
    translateText: async () => assert.fail('Cache must not start a new request')
  });
  await translator.translateSingleMessage(original, 'cached', icon);
  assert.equal(icon.classList.contains('translating'), false);
  assert.equal(icon.classList.contains('translation-complete'), true);
  assert.equal(icon.getAttribute('data-translation-state'), 'done');
  assert.doesNotMatch(icon.innerHTML, /<animate/);
});
