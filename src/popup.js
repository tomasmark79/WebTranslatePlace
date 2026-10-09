// Thunderbird uses the same settings and backups, without Discord controls.
if (composerApi.runtime.getManifest?.().compose_action) {
  document.getElementById('discord-settings').hidden = true;
}

const entriesElement = document.getElementById('entries');
const historyToggle = document.getElementById('toggle-history');
const historyControls = document.getElementById('history-visibility');
// Visibility lasts only for this popup. Every new opening starts with hidden history.
let historyVisible = false;
const statusElement = document.getElementById('status');
const clearButton = document.getElementById('clear');
const apiForm = document.getElementById('api-settings');
const apiField = document.getElementById('api-url');
const apiSave = document.getElementById('api-save');
const apiReset = document.getElementById('api-reset');
const apiStatus = document.getElementById('api-status');
const discordToggle = document.getElementById('discord-enabled');
const discordStatus = document.getElementById('discord-status');
const historyField = document.getElementById('history-limit');
const historyCount = document.getElementById('history-count');

composerApi.storage.local.get('translatorActive').then(stored => {
  discordToggle.checked = stored.translatorActive !== false;
  discordToggle.disabled = false;
}).catch(error => { discordStatus.textContent = error.message; });

discordToggle.addEventListener('change', async () => {
  const enabled = discordToggle.checked;
  discordToggle.disabled = true;
  discordStatus.textContent = '';
  try {
    await composerApi.storage.local.set({ translatorActive: enabled });
  } catch (error) {
    discordToggle.checked = !enabled;
    discordStatus.textContent = error.message;
  } finally {
    discordToggle.disabled = false;
  }
});

let apiReady = false;
let historyReady = false;
let savingSettings = false;
function updateSettingsControls() {
  apiSave.disabled = !apiReady || !historyReady || savingSettings;
  apiReset.disabled = apiSave.disabled;
  apiField.disabled = savingSettings;
  historyField.disabled = !historyReady || savingSettings;
  let defaultApi = false;
  try { defaultApi = API_SETTINGS.normalize(apiField.value) === API_SETTINGS.defaultUrl; }
  catch { /* Invalid input differs from the defaults. */ }
  apiReset.hidden = !apiReady || !historyReady || (defaultApi && Number(historyField.value) === 50);
}

apiField.addEventListener('input', updateSettingsControls);
historyField.addEventListener('input', updateSettingsControls);

apiForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (apiSave.disabled) return;
  savingSettings = true;
  updateSettingsControls();
  try {
    const apiUrl = API_SETTINGS.normalize(apiField.value);
    const limit = Number(historyField.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Enter a whole number from 1 to 1,000.');
    }
    await backupRequest('settings-save', { apiUrl, limit });
    apiField.value = apiUrl;
    await render();
    apiStatus.textContent = 'Settings saved.';
  } catch (error) {
    apiStatus.textContent = error.message;
  } finally {
    savingSettings = false;
    updateSettingsControls();
  }
});
apiReset.addEventListener('click', () => {
  apiField.value = API_SETTINGS.defaultUrl;
  historyField.value = 50;
  apiStatus.textContent = 'Default values are ready. Click Save to apply them.';
  updateSettingsControls();
  apiSave.focus();
});

API_SETTINGS.load().then(url => {
  apiField.value = url;
}).catch(error => {
  apiField.value = API_SETTINGS.defaultUrl;
  apiStatus.textContent = error.message;
}).finally(() => { apiReady = true; updateSettingsControls(); });

async function backupRequest(type, data = {}) {
  const result = await composerApi.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.body?.error || 'Storage is unavailable.');
  return result;
}

function status(message) {
  statusElement.textContent = message;
}

async function render() {
  const { entries, limit = 50 } = await backupRequest('backup-list');
  if (!historyReady || savingSettings) historyField.value = limit;
  historyReady = true;
  updateSettingsControls();
  historyCount.textContent = `Saved: ${entries.length} / ${limit}`;
  entriesElement.replaceChildren();
  clearButton.disabled = entries.length === 0;
  clearButton.hidden = entries.length === 0;
  historyControls.hidden = entries.length === 0;
  if (!entries.length) {
    historyVisible = false;
    entriesElement.hidden = true;
    historyToggle.textContent = 'Show history';
    historyToggle.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!historyVisible) return;
  for (const entry of entries) {
    const article = document.createElement('article');
    const heading = document.createElement('p');
    heading.textContent = `${new Date(entry.createdAt).toLocaleString('en-GB')} · ${entry.site || 'Website'}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    article.append(heading);
    function addText(label, text) {
      const caption = document.createElement('label');
      caption.textContent = label;
      const field = document.createElement('textarea');
      field.id = `${entry.id}-${label.toLowerCase()}`;
      caption.htmlFor = field.id;
      field.readOnly = true;
      field.value = text;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = `Copy ${label.toLowerCase()}`;
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          status('Text copied to the clipboard.');
        } catch {
          field.focus();
          field.select();
          status('Could not copy the text. It is selected for manual copying.');
        }
      });
      article.append(caption, field);
      actions.append(copy);
    }
    addText('Original', entry.text);
    if (typeof entry.translatedText === 'string' && entry.translatedText.trim()) {
      addText('Translation', entry.translatedText);
    } else {
      const unavailable = document.createElement('p');
      unavailable.textContent = 'No saved translation.';
      article.append(unavailable);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      try {
        await backupRequest('backup-delete', { id: entry.id });
        status('Entry deleted.');
        await render();
      } catch (error) { status(error.message); }
    });
    actions.append(remove);
    article.append(actions);
    entriesElement.appendChild(article);
  }
}

historyToggle.addEventListener('click', async () => {
  historyVisible = !historyVisible;
  historyToggle.textContent = historyVisible ? 'Hide history' : 'Show history';
  historyToggle.setAttribute('aria-expanded', String(historyVisible));
  entriesElement.hidden = !historyVisible;
  if (!historyVisible) {
    entriesElement.replaceChildren();
    return;
  }
  try {
    await render();
  } catch (error) {
    status(error.message);
  }
});

const clearSummary = document.getElementById('clear-summary');
const clearConfirmation = document.getElementById('clear-confirmation');
const clearCancel = document.getElementById('clear-cancel');
const clearConfirm = document.getElementById('clear-confirm');

function closeClearConfirmation() {
  clearConfirmation.hidden = true;
  clearSummary.hidden = false;
  (clearButton.disabled ? statusElement : clearButton).focus();
}

clearButton.addEventListener('click', () => {
  clearSummary.hidden = true;
  clearConfirmation.hidden = false;
  clearCancel.focus();
});
clearCancel.addEventListener('click', closeClearConfirmation);
clearConfirmation.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !clearCancel.disabled) {
    event.preventDefault();
    closeClearConfirmation();
  }
});
clearConfirm.addEventListener('click', async () => {
  if (clearConfirm.disabled) return;
  clearConfirm.disabled = clearCancel.disabled = true;
  try {
    await backupRequest('backup-clear');
    status('All entries deleted.');
    await render();
    closeClearConfirmation();
  } catch (error) {
    status(error.message);
  } finally {
    clearConfirm.disabled = clearCancel.disabled = false;
  }
});

render().catch(error => status(error.message));


// Show the actual shortcut, including changes in the extension manager.
async function showShortcut() {
  const hint = document.getElementById('shortcut-help');
  if (!hint || !composerApi.commands?.getAll) return;
  try {
    const commands = await composerApi.commands.getAll();
    const command = commands.find(item => item.name === 'translate-selection');
    hint.textContent = command?.shortcut
      ? `TranslatePlace (${command.shortcut})`
      : 'TranslatePlace (no shortcut assigned)';
  } catch { /* Browsers without support use the default hint. */ }
}
void showShortcut();
