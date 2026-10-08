globalThis.WTP_READ_MESSAGE = true;

async function translateReceivedSelection() {
  if (!document.hasFocus()) return;
  if (translating) return;
  const selection = window.getSelection();
  const text = selection?.toString() || '';
  if (!text.trim()) {
    showNotice('Nejprve označ text v e-mailu.');
    return;
  }
  if (text.length > 10000) {
    showNotice('Vybraný text je delší než limit 10 000 znaků.');
    return;
  }
  translating = true;
  const panel = document.createElement('aside');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Překlad do češtiny');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
    'padding:16px;background:#014380;color:white;border:1px solid #2397ff;' +
    'border-radius:8px;font:14px sans-serif;width:420px;max-width:80vw;max-height:60vh;overflow:auto;';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Zavřít překlad';
  close.addEventListener('click', () => panel.remove());
  const result = document.createElement('p');
  result.style.whiteSpace = 'pre-wrap';
  result.setAttribute('role', 'status');
  result.textContent = 'Překládám…';
  panel.append(close, result);
  document.documentElement.appendChild(panel);
  try {
    // Translation stays separate from the original and never changes stored mail.
    result.textContent = await translate(text, 'auto', 'cs');
  } catch (error) {
    result.textContent = error.message;
  } finally {
    translating = false;
  }
}
