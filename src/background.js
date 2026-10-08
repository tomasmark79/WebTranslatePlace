// Selection translation, command dispatch and local draft backups.
(() => {
const composerApi = globalThis.browser ?? globalThis.chrome;
const API_SETTINGS = {
  key: 'translationApiUrl',
  defaultUrl: 'http://127.0.0.1:5001',
  normalize(value) {
    let url;
    try { url = new URL(value.trim()); } catch {
      throw new Error('Zadej platnou adresu API včetně http:// nebo https://.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash) {
      throw new Error('Adresa API musí být HTTP/HTTPS bez přihlašovacích údajů, parametrů a fragmentu.');
    }
    return url.href.replace(/\/+$/, '');
  },
  async load() {
    const stored = await composerApi.storage.local.get(this.key);
    return this.normalize(stored[this.key] ?? this.defaultUrl);
  }
};
const BACKUPS_KEY = 'originalTexts';
const MAX_BACKUPS = 50;
let backupQueue = Promise.resolve();

function queueBackupChange(change) {
  const task = backupQueue.then(change);
  backupQueue = task.catch(() => {});
  return task;
}

async function backupMessage(message, sender) {
  if (message.type === 'backup-list') {
    await backupQueue;
    return { ok: true, entries: (await composerApi.storage.local.get(BACKUPS_KEY))[BACKUPS_KEY] || [] };
  }
  return queueBackupChange(async () => {
    const entries = (await composerApi.storage.local.get(BACKUPS_KEY))[BACKUPS_KEY] || [];
    if (message.type === 'backup-save') {
      if (typeof message.text !== 'string' || !message.text.trim() ||
          message.text.length > 10000) throw new Error('Neplatný text pro zálohu.');
      let site = '';
      try { site = new URL(sender.url).hostname; } catch { /* Rámec bez běžné URL. */ }
      const entry = {
        id: crypto.randomUUID(), text: message.text, site,
        createdAt: Date.now()
      };
      await composerApi.storage.local.set({ [BACKUPS_KEY]: [entry, ...entries].slice(0, MAX_BACKUPS) });
      return { ok: true, id: entry.id };
    }
    if (message.type === 'backup-delete') {
      if (typeof message.id !== 'string') throw new Error('Neplatné ID zálohy.');
      await composerApi.storage.local.set({
        [BACKUPS_KEY]: entries.filter(entry => entry.id !== message.id)
      });
      return { ok: true };
    }
    await composerApi.storage.local.set({ [BACKUPS_KEY]: [] });
    return { ok: true };
  });
}

composerApi.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'translate-selection') return;
  const activeTab = tab || (await composerApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (activeTab?.id == null) return;
  // Zpráva dorazí do všech rámců; překlad provede pouze rámec s aktivním editorem.
  composerApi.tabs.sendMessage(activeTab.id, { type: 'translate-selection' }).catch(error => {
    console.warn('[WebTranslatePlace] Na této stránce není editor dostupný:', error.message);
  });
});

composerApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['translation-request', 'backup-save', 'backup-list', 'backup-delete',
        'backup-clear'].includes(message?.type)) return;
  (async () => {
    try {
      if (message.type !== 'translation-request') {
        sendResponse(await backupMessage(message, _sender));
        return;
      }
      const path = message.path;
      if (path !== '/translate' && !/^\/translations\/[a-f0-9]{32}$/.test(path)) {
        throw new Error('Neplatná cesta překladového API.');
      }
      const apiUrl = API_SETTINGS.normalize(message.apiUrl ?? await API_SETTINGS.load());
      const response = await fetch(apiUrl + path, {
        method: path === '/translate' ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(path === '/translate' ? { body: JSON.stringify(message.body) } : {}),
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.json();
      sendResponse({ ok: response.ok, body });
    } catch (error) {
      const prefix = message.type === 'translation-request'
        ? 'Překladový server není dostupný' : 'Úložiště původních textů není dostupné';
      sendResponse({ ok: false, body: { error: `${prefix}: ${error.message}` } });
    }
  })();
  return true;
});

})();

const extensionApi = globalThis.browser ?? globalThis.chrome;

/**
 * WebTranslatePlace - Background Script
 * Author: Tomáš Mark
 * 
 * Handles fetch requests from content script to bypass CORS restrictions
 * Manages translator state and communicates with content scripts
 */

const logger = {
  debug: () => {},
  log: () => {},
  warn: (...args) => console.warn('[WebTranslatePlace - Background]', ...args),
  error: (...args) => console.error('[WebTranslatePlace - Background]', ...args)
};

// Translator state
let translatorState = {
  isActive: true,  // Automatically active for Discord
  stats: {
    translated: 0,
    cached: 0
  }
};

/**
 * Get current state
 */
function getState() {
  return { ...translatorState };
}

/**
 * Initialize translator state on startup
 */
async function initializeState() {
  // Load state from storage, default to active for Discord
  const stored = await extensionApi.storage.local.get('translatorActive');
  translatorState.isActive = stored.translatorActive !== undefined ? stored.translatorActive : true;
  logger.log('🚀 Translator initialized:', translatorState.isActive ? 'ACTIVE' : 'INACTIVE');
}

/**
 * Toggle translator on/off
 */
async function toggleTranslator() {
  await initializeState();
  translatorState.isActive = !translatorState.isActive;
  
  logger.log('🔄 Translator toggled:', translatorState.isActive ? 'ON' : 'OFF');

  // Save state to storage
  await extensionApi.storage.local.set({ translatorActive: translatorState.isActive });

  // Notify all Discord tabs
  const tabs = await extensionApi.tabs.query({ url: '*://*.discord.com/*' });
  for (const tab of tabs) {
    try {
      await extensionApi.tabs.sendMessage(tab.id, JSON.stringify({
        type: 'stateChanged',
        args: [translatorState.isActive]
      }));
    } catch (error) {
      // Tab might not have content script loaded yet
      logger.debug('Could not notify tab', tab.id, error.message);
    }
  }

  return getState();
}

/**
 * Update stats from content script
 */
function updateStats(stats) {
  translatorState.stats = { ...stats };
  logger.debug('📊 Stats updated:', stats);
}

/**
 * Handle messages from content scripts
 */
extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'string') return;
  try {
    const url = new URL(sender.url);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)) return;
  } catch { return; }
  logger.log('📨 Message received, type:', typeof message);

  (async () => {
    try {
      const { type, args } = JSON.parse(message);

      logger.log('✅ Parsed message type:', type);

      switch (type) {
        case 'fetch': {
          const [url, options] = args;
          logger.log('🌐 Proxying fetch request to:', url.substring(0, 100) + '...');

          let response;
          try {
            response = await fetch(url, {
              ...options,
              signal: AbortSignal.timeout(15000)
            });
          } catch (error) {
            const endpoint = new URL(url).origin;
            throw new Error(`Spojení s ${endpoint} selhalo (${error.message}). Zkontroluj běh překladového serveru, adresu API v nastavení a oprávnění rozšíření v prohlížeči.`);
          }
          logger.log('📥 Fetch response status:', response.status, response.statusText);

          const text = await response.text();
          logger.log('📄 Fetch response text length:', text.length);

          sendResponse(JSON.stringify({
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url,
            text
          }));
          break;
        }

        case 'getState': {
          await initializeState();
          const state = getState();
          sendResponse(JSON.stringify(state));
          break;
        }

        case 'toggleTranslator': {
          const state = await toggleTranslator();
          sendResponse(JSON.stringify(state));
          break;
        }

        case 'updateStats': {
          const [stats] = args;
          updateStats(stats);
          sendResponse(JSON.stringify({ success: true }));
          break;
        }

        default:
          logger.warn('Unknown message type:', type);
          sendResponse(null);
      }

    } catch (error) {
      logger.error('❌ Error handling message:', error);
      logger.error('❌ Error stack:', error.stack);
      sendResponse(JSON.stringify({ error: error.message }));
    }
  })();

  return true; // Keep message channel open for async response
});

/**
 * Extension lifecycle events
 */
extensionApi.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    logger.log('Extension installed');
    // Set default state to ON for automatic translation
    await extensionApi.storage.local.set({ translatorActive: true });
  } else if (details.reason === 'update') {
    logger.log('Extension updated to version', extensionApi.runtime.getManifest().version);
  }
});
