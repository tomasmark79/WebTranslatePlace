const selectionApi = globalThis.browser ?? globalThis.chrome;
const POLL_INTERVAL_MS = 500;
const TRANSLATION_TIMEOUT_MS = 180000;
const TEXT_INPUT_TYPES = new Set(['text', 'search']);
let translating = false;

function activeEditor() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function selectedText() {
  if (!document.hasFocus()) return null;
  const active = activeEditor();
  if (!active || active.tagName === 'IFRAME') return null;
  if (active.tagName === 'TEXTAREA' ||
      (active.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(active.type))) {
    if (active.disabled || active.readOnly || active.selectionStart == null ||
        active.selectionStart === active.selectionEnd) return null;
    const start = active.selectionStart;
    const end = active.selectionEnd;
    return { kind: 'control', element: active, start, end, value: active.value,
      text: active.value.slice(start, end) };
  }
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
      active.isContentEditable === false) return null;

  const editor = active.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]');
  const selection = window.getSelection();
  if (!editor || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  return { kind: 'editable', editor, range, text: selection.toString(),
    editorText: editor.textContent };
}

function selectionUnchanged(snapshot) {
  if (!document.hasFocus()) return false;
  const active = activeEditor();
  if (snapshot.kind === 'control') {
    const element = snapshot.element;
    return element.isConnected && active === element && element.value === snapshot.value &&
      element.selectionStart === snapshot.start && element.selectionEnd === snapshot.end;
  }
  const { editor, range } = snapshot;
  const selection = window.getSelection();
  if (!editor.isConnected || !editor.contains(active) ||
      editor.textContent !== snapshot.editorText || !selection || selection.rangeCount !== 1) {
    return false;
  }
  const current = selection.getRangeAt(0);
  return current.startContainer === range.startContainer && current.startOffset === range.startOffset &&
    current.endContainer === range.endContainer && current.endOffset === range.endOffset &&
    selection.toString() === snapshot.text;
}

async function replaceSelection(snapshot, translated) {
  if (!selectionUnchanged(snapshot)) {
    throw new Error('Výběr se během překladu změnil. Původní text zůstal zachovaný.');
  }
  if (snapshot.kind === 'editable' && snapshot.editor.matches?.('[data-slate-editor]')) {
    // Slate drží obsah zprávy ve vlastním modelu. Přímá změna DOM by pouze
    // zobrazila překlad, zatímco při odeslání by se použil původní text.
    const event = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: translated
    });
    snapshot.editor.dispatchEvent(event);
    if (!event.defaultPrevented) {
      throw new Error('Editor překlad nepřijal. Původní text zůstal zachovaný.');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (translated !== snapshot.text && snapshot.editor.textContent === snapshot.editorText) {
      throw new Error('Editor překlad nepotvrdil. Původní text zůstal zachovaný.');
    }
    return;
  }
  if (document.execCommand('insertText', false, translated)) return;
  if (snapshot.kind !== 'control') {
    throw new Error('Tento editor nepodporuje bezpečné nahrazení vybraného textu.');
  }
  const { element, start, end } = snapshot;
  element.setRangeText(translated, start, end, 'end');
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true, inputType: 'insertReplacementText', data: translated
  }));
}

function showNotice(message) {
  const notice = document.createElement('div');
  notice.textContent = message;
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
    'padding:10px 14px;border-radius:8px;background:#014380;color:white;border:1px solid #2397ff;' +
    'font:14px sans-serif;box-shadow:0 2px 10px #0005;max-width:360px;';
  document.documentElement.appendChild(notice);
  setTimeout(() => notice.remove(), 4000);
}

async function request(path, body, apiUrl) {
  const response = await selectionApi.runtime.sendMessage({ type: 'translation-request', path, body, apiUrl });
  if (!response?.ok) throw new Error(response?.body?.error || 'Překlad se nezdařil.');
  return response.body;
}

async function translate(text) {
  const stored = await selectionApi.storage.local.get('translationApiUrl');
  const apiUrl = stored.translationApiUrl || 'http://127.0.0.1:5001';
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let result = await request('/translate', { q: text, source: 'cs', target: 'en' }, apiUrl);
  if (!/^[a-f0-9]{32}$/.test(result.jobId || '')) {
    throw new Error('Server nevrátil platné ID překladu.');
  }
  const jobId = result.jobId;
  while (result.status === 'pending') {
    if (Date.now() >= deadline) throw new Error('Vypršel čas na překlad.');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    result = await request(`/translations/${jobId}`, undefined, apiUrl);
  }
  if (result.status === 'failed') throw new Error(result.error || 'Překlad se nezdařil.');
  if (result.status !== 'done' || !result.translatedText?.trim()) {
    throw new Error('Server nevrátil přeložený text.');
  }
  return result.translatedText;
}

async function translateSelection() {
  if (!document.hasFocus()) return;
  if (translating) {
    showNotice('Překlad už probíhá.');
    return;
  }
  const snapshot = selectedText();
  if (!snapshot?.text.trim()) {
    if (activeEditor()?.tagName !== 'IFRAME') showNotice('Nejprve označ text v editoru.');
    return;
  }
  if (snapshot.text.length > 10000) {
    showNotice('Vybraný text je delší než limit 10 000 znaků.');
    return;
  }
  translating = true;
  try {
    // Původní výběr musí být bezpečně uložený dřív, než začne překlad.
    const backup = await selectionApi.runtime.sendMessage({ type: 'backup-save', text: snapshot.text });
    if (!backup?.ok) {
      throw new Error(backup?.body?.error || 'Původní text nelze uložit. Překlad nebyl spuštěn.');
    }
    const translated = await translate(snapshot.text);
    await replaceSelection(snapshot, translated);
  } catch (error) {
    showNotice(error.message);
  } finally {
    translating = false;
  }
}

selectionApi.runtime.onMessage.addListener(message => {
  if (message?.type === 'translate-selection') void translateSelection();
});
