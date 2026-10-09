// Thunderbird uses the same settings and backups, without Discord controls.
if (composerApi.runtime.getManifest?.().compose_action) {
  document.getElementById('discord-settings').hidden = true;
}

const entriesElement = document.getElementById('entries');
const historyToggle = document.getElementById('toggle-history');
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
}

apiForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (apiSave.disabled) return;
  savingSettings = true;
  updateSettingsControls();
  try {
    const apiUrl = API_SETTINGS.normalize(apiField.value);
    const limit = Number(historyField.value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Zadej celé číslo od 1 do 1 000.');
    }
    await backupRequest('settings-save', { apiUrl, limit });
    apiField.value = apiUrl;
    await render();
    apiStatus.textContent = 'Nastavení bylo uloženo.';
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
  apiStatus.textContent = 'Výchozí hodnoty jsou připravené. Potvrď tlačítkem Uložit.';
});

API_SETTINGS.load().then(url => {
  apiField.value = url;
}).catch(error => {
  apiField.value = API_SETTINGS.defaultUrl;
  apiStatus.textContent = error.message;
}).finally(() => { apiReady = true; updateSettingsControls(); });

async function backupRequest(type, data = {}) {
  const result = await composerApi.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.body?.error || 'Úložiště není dostupné.');
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
  historyCount.textContent = `Uloženo: ${entries.length} / ${limit}`;
  entriesElement.replaceChildren();
  clearButton.disabled = entries.length === 0;
  if (!historyVisible) return;
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Zatím tu není žádný uložený text.';
    entriesElement.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const article = document.createElement('article');
    const heading = document.createElement('p');
    heading.textContent = `${new Date(entry.createdAt).toLocaleString('cs-CZ')} · ${entry.site || 'Webová stránka'}`;
    const field = document.createElement('textarea');
    field.readOnly = true;
    field.value = entry.text;
    field.setAttribute('aria-label', `Původní text z ${entry.site || 'webové stránky'}`);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Kopírovat';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.text);
        status('Text je ve schránce.');
      } catch {
        field.focus();
        field.select();
        status('Kopírování se nezdařilo; text je označený pro ruční kopírování.');
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Smazat';
    remove.addEventListener('click', async () => {
      try {
        await backupRequest('backup-delete', { id: entry.id });
        status('Záznam byl smazán.');
        await render();
      } catch (error) { status(error.message); }
    });
    actions.append(copy, remove);
    article.append(heading, field, actions);
    entriesElement.appendChild(article);
  }
}

historyToggle.addEventListener('click', async () => {
  historyVisible = !historyVisible;
  historyToggle.textContent = historyVisible ? 'Skrýt historii' : 'Zobrazit historii';
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
    status('Všechny záznamy byly smazány.');
    await render();
    closeClearConfirmation();
  } catch (error) {
    status(error.message);
  } finally {
    clearConfirm.disabled = clearCancel.disabled = false;
  }
});

render().catch(error => status(error.message));


// Zobrazíme skutečnou zkratku, včetně změn ve správci rozšíření.
async function showShortcut() {
  const hint = document.getElementById('shortcut-help');
  if (!hint || !composerApi.commands?.getAll) return;
  try {
    const commands = await composerApi.commands.getAll();
    const command = commands.find(item => item.name === 'translate-selection');
    hint.textContent = command?.shortcut
      ? `TranslatePlace (${command.shortcut})`
      : 'TranslatePlace (zkratka není nastavená)';
  } catch { /* Prohlížeč bez podpory použije výchozí nápovědu. */ }
}
void showShortcut();
