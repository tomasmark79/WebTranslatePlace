// Copyright (C) 2026 Tomáš Mark
// SPDX-License-Identifier: GPL-3.0-or-later

globalThis.WTP_READ_MESSAGE = true;

async function translateReceivedSelection(secondary = false) {
  if (!document.hasFocus()) return;
  if (translating) return;
  const selection = window.getSelection();
  const text = selection?.toString() || '';
  if (!text.trim()) {
    showNotice('Select some text in the email first.');
    return;
  }
  if (text.length > 10000) {
    showNotice('The selected text exceeds the 10,000-character limit.');
    return;
  }
  translating = true;
  const panel = document.createElement('aside');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Translation');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
    'padding:16px;background:#014380;color:white;border:1px solid #2397ff;' +
    'border-radius:8px;font:14px sans-serif;width:420px;max-width:80vw;max-height:60vh;overflow:auto;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close translation';
  close.addEventListener('click', () => panel.remove());
  const result = document.createElement('p');
  result.style.whiteSpace = 'pre-wrap';
  result.setAttribute('role', 'status');
  result.textContent = 'Translating…';
  panel.append(close, result);
  document.documentElement.appendChild(panel);
  try {
    // Translation stays separate from the original and never changes stored mail.
    result.textContent = await translate(text, await selectionTarget(secondary));
  } catch (error) {
    result.textContent = error.message;
  } finally {
    translating = false;
  }
}
