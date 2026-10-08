const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');

test('Thunderbird registers ordered scripts for both mail contexts at startup', async () => {
  const registered = {};
  const context = vm.createContext({ browser: {
    composeScripts: { register: async args => { registered.compose = args; } },
    messageDisplayScripts: { register: async args => { registered.display = args; } }
  }, console });
  await vm.runInContext(source('thunderbird-background.js'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(registered)), {
    compose: { js: [{ file: 'thunderbird-compose.js' }, { file: 'selection.js' }] },
    display: { js: [{ file: 'thunderbird-message.js' }, { file: 'selection.js' }] }
  });
});

function mailContext(text = 'Hello world', error = false) {
  const requests = [];
  const panels = [];
  const element = () => ({ style: {}, children: [], setAttribute() {},
    append(...children) { this.children.push(...children); }, addEventListener() {}, remove() {} });
  const document = { hasFocus: () => true, createElement: element,
    documentElement: { appendChild: panel => panels.push(panel) } };
  const context = vm.createContext({ document, console,
    window: { getSelection: () => ({ toString: () => text }) },
    browser: { storage: { local: { get: async () => ({ translationApiUrl: 'http://localhost:5001' }) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async request => {
        requests.push(request);
        if (error) return { ok: false, body: { error: 'Server unavailable' } };
        return { ok: true, body: { jobId: 'a'.repeat(32), status: 'done', translatedText: '<b>Ahoj světe</b>' } };
      } } }, setTimeout: fn => fn()
  });
  vm.runInContext(source('thunderbird-message.js'), context);
  vm.runInContext(source('selection.js'), context);
  return { context, requests, panels, document };
}

test('Selected received mail translates auto → cs as plain text without backups or replacement', async () => {
  const h = mailContext();
  await vm.runInContext('translateReceivedSelection()', h.context);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].body)), {
    q: 'Hello world', source: 'auto', target: 'cs'
  });
  assert.equal(h.panels[0].children[1].textContent, '<b>Ahoj světe</b>');
  assert.equal(vm.runInContext('translating', h.context), false);
});

test('Received mail shows API errors and skips empty or oversized selections', async () => {
  const h = mailContext('Hello', true);
  await vm.runInContext('translateReceivedSelection()', h.context);
  assert.equal(h.panels[0].children[1].textContent, 'Server unavailable');
  for (const text of ['', 'x'.repeat(10001)]) {
    const invalid = mailContext(text);
    await vm.runInContext('translateReceivedSelection()', invalid.context);
    assert.equal(invalid.requests.length, 0);
  }
});

test('Thunderbird designMode compose selection saves original and uses native editor replacement', async () => {
  const h = mailContext();
  vm.runInContext(source('thunderbird-compose.js'), h.context);
  h.context.WTP_READ_MESSAGE = false;
  const textNode = {};
  const body = { tagName: 'BODY', textContent: 'Ahoj', isContentEditable: false,
    isConnected: true, contains: node => node === textNode || node === body };
  const range = { startContainer: textNode, endContainer: textNode,
    startOffset: 0, endOffset: 4, cloneRange() { return this; } };
  const selection = { isCollapsed: false, rangeCount: 1,
    getRangeAt: () => range, toString: () => 'Ahoj' };
  Object.assign(h.document, { activeElement: body, body, designMode: 'on',
    execCommand: (command, ui, value) => {
      assert.equal(command, 'insertText'); body.textContent = value; return true;
    } });
  h.context.window.getSelection = () => selection;
  const messages = [];
  h.context.browser.runtime.sendMessage = async request => {
    messages.push(request);
    if (request.type === 'backup-save') return { ok: true };
    return { ok: true, body: { jobId: 'a'.repeat(32), status: 'done', translatedText: 'Hello' } };
  };
  await vm.runInContext('translateSelection()', h.context);
  assert.equal(messages[0].type, 'backup-save');
  assert.equal(messages[0].text, 'Ahoj');
  assert.equal(messages[1].body.target, 'en');
  assert.equal(body.textContent, 'Hello');
});
