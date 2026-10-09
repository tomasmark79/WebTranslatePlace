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
      (active.isContentEditable === false && !(globalThis.WTP_COMPOSE && document.designMode === 'on'))) return null;

  const editor = active.closest?.('[contenteditable="true"], [contenteditable="plaintext-only"]') ||
    (globalThis.WTP_COMPOSE && document.designMode === 'on' ? document.body : null);
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
    throw new Error('The selection changed during translation. The original text was kept.');
  }
  if (snapshot.kind === 'editable' && snapshot.editor.matches?.('[data-slate-editor]')) {
    // Slate keeps message content in its own model. A direct DOM change would only
    // display the translation, while sending would use the original text.
    const event = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: translated
    });
    snapshot.editor.dispatchEvent(event);
    if (!event.defaultPrevented) {
      throw new Error('The editor did not accept the translation. The original text was kept.');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (translated !== snapshot.text && snapshot.editor.textContent === snapshot.editorText) {
      throw new Error('The editor did not confirm the translation. The original text was kept.');
    }
    return;
  }
  if (document.execCommand('insertText', false, translated)) return;
  if (snapshot.kind !== 'control') {
    throw new Error('This editor does not support safely replacing the selected text.');
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
  if (!response?.ok) throw new Error(response?.body?.error || 'Translation failed.');
  return response.body;
}

async function translate(text, target) {
  const stored = await selectionApi.storage.local.get(['translationApiUrl', 'translationTarget']);
  const apiUrl = stored.translationApiUrl || 'http://127.0.0.1:5001';
  target ??= stored.translationTarget || 'en';
  const deadline = Date.now() + TRANSLATION_TIMEOUT_MS;
  let result = await request('/translate', { q: text, source: 'auto', target }, apiUrl);
  if (!/^[a-f0-9]{32}$/.test(result.jobId || '')) {
    throw new Error('The server did not return a valid translation ID.');
  }
  const jobId = result.jobId;
  while (result.status === 'pending') {
    if (Date.now() >= deadline) throw new Error('Translation timed out.');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    result = await request(`/translations/${jobId}`, undefined, apiUrl);
  }
  if (result.status === 'failed') throw new Error(result.error || 'Translation failed.');
  if (result.status !== 'done' || !result.translatedText?.trim()) {
    throw new Error('The server did not return translated text.');
  }
  return result.translatedText;
}

async function selectionTarget(secondary = false) {
  const key = secondary ? 'secondaryTranslationTarget' : 'translationTarget';
  const stored = await selectionApi.storage.local.get(key);
  return stored[key] || (secondary ? 'cs' : 'en');
}

async function translateSelection(secondary = false) {
  if (!document.hasFocus()) return;
  if (translating) {
    showNotice('A translation is already in progress.');
    return;
  }
  const snapshot = selectedText();
  if (!snapshot?.text.trim()) {
    if (activeEditor()?.tagName !== 'IFRAME') showNotice('Select some text in the editor first.');
    return;
  }
  if (snapshot.text.length > 10000) {
    showNotice('The selected text exceeds the 10,000-character limit.');
    return;
  }
  translating = true;
  try {
    // Save the original selection successfully before starting translation.
    const target = await selectionTarget(secondary);
    const backup = await selectionApi.runtime.sendMessage({ type: 'backup-save', text: snapshot.text, target });
    if (!backup?.ok) {
      throw new Error(backup?.body?.error || 'Could not save the original text. Translation was not started.');
    }
    const translated = await translate(snapshot.text, target);
    const saved = await selectionApi.runtime.sendMessage({
      type: 'backup-complete', id: backup.id, translatedText: translated
    });
    if (!saved?.ok) {
      throw new Error(saved?.body?.error || 'Could not save the translation. The original text was kept.');
    }
    await replaceSelection(snapshot, translated);
  } catch (error) {
    showNotice(error.message);
  } finally {
    translating = false;
  }
}

selectionApi.runtime.onMessage.addListener(message => {
  if (['translate-selection', 'translate-selection-secondary'].includes(message?.type)) {
    const secondary = message.type === 'translate-selection-secondary';
    if (globalThis.WTP_READ_MESSAGE) void translateReceivedSelection(secondary);
    else void translateSelection(secondary);
  }
});
