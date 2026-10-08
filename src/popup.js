const entriesElement = document.getElementById('entries');
const statusElement = document.getElementById('status');
const clearButton = document.getElementById('clear');
const apiForm = document.getElementById('api-settings');
const apiField = document.getElementById('api-url');
const apiSave = document.getElementById('api-save');
const apiReset = document.getElementById('api-reset');
const apiStatus = document.getElementById('api-status');
const discordToggle = document.getElementById('discord-enabled');
const discordStatus = document.getElementById('discord-status');

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

async function saveApi(value) {
  try {
    const url = API_SETTINGS.normalize(value);
    // Přístup k HTTP/HTTPS hostům už pokrývá povinné <all_urls>.
    await composerApi.storage.local.set({ [API_SETTINGS.key]: url });
    apiField.value = url;
    apiStatus.textContent = 'Adresa API byla uložena.';
  } catch (error) { apiStatus.textContent = error.message; }
}

apiForm.addEventListener('submit', async event => {
  event.preventDefault();
  apiSave.disabled = apiReset.disabled = true;
  await saveApi(apiField.value);
  apiSave.disabled = apiReset.disabled = false;
});
apiReset.addEventListener('click', async () => {
  apiSave.disabled = apiReset.disabled = true;
  await saveApi(API_SETTINGS.defaultUrl);
  apiSave.disabled = apiReset.disabled = false;
});

API_SETTINGS.load().then(url => {
  apiField.value = url;
}).catch(error => {
  apiField.value = API_SETTINGS.defaultUrl;
  apiStatus.textContent = error.message;
}).finally(() => { apiSave.disabled = apiReset.disabled = false; });

async function backupRequest(type, id) {
  const result = await composerApi.runtime.sendMessage({ type, id });
  if (!result?.ok) throw new Error(result?.body?.error || 'Úložiště není dostupné.');
  return result;
}

function status(message) {
  statusElement.textContent = message;
}

async function render() {
  const { entries } = await backupRequest('backup-list');
  entriesElement.replaceChildren();
  clearButton.disabled = entries.length === 0;
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
        await backupRequest('backup-delete', entry.id);
        status('Záznam byl smazán.');
        await render();
      } catch (error) { status(error.message); }
    });
    actions.append(copy, remove);
    article.append(heading, field, actions);
    entriesElement.appendChild(article);
  }
}

clearButton.addEventListener('click', async () => {
  if (!confirm('Opravdu smazat všechny uložené původní texty?')) return;
  try {
    await backupRequest('backup-clear');
    status('Všechny záznamy byly smazány.');
    await render();
  } catch (error) { status(error.message); }
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
