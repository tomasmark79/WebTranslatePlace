// Editors can put invisible placeholders on otherwise empty lines. Keep line
// breaks and spaces, but do not send placeholder-only chunks to the model.
function normalizeTranslationBody(body) {
  if (typeof body?.q !== 'string') return body;
  const q = body.q.split(/(\r\n|\r|\n)/).map(part =>
    /^[\s\u200B\uFEFF]*$/u.test(part) ? part.replace(/[\u200B\uFEFF]/g, '') : part
  ).join('');
  return { ...body, q };
}

// Selection translation, command dispatch and local draft backups.
(() => {
const composerApi = globalThis.browser ?? globalThis.chrome;
const API_SETTINGS = {
  key: 'translationApiUrl',
  defaultUrl: 'http://127.0.0.1:5001',
  normalize(value) {
    let url;
    try { url = new URL(value.trim()); } catch {
      throw new Error('Enter a valid API URL including http:// or https://.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash) {
      throw new Error('The API URL must use HTTP/HTTPS without credentials, query parameters or fragments.');
    }
    return url.href.replace(/\/+$/, '');
  },
  async load() {
    const stored = await composerApi.storage.local.get(this.key);
    return this.normalize(stored[this.key] ?? this.defaultUrl);
  }
};
const BACKUPS_KEY = 'originalTexts';
const HISTORY_LIMIT_KEY = 'historyLimit';
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_TARGET = 'en';
const TARGET_LANGUAGES = new Set('af ar bg bn ca cs cy da de el en es et fa fi fr gu he hi hr hu id it ja kn ko lt lv mk ml mr ne nl no pa pl pt ro ru sk sl so sq sv sw ta te th tl tr uk ur vi zh-cn zh-tw'.split(' '));
function translationTarget(stored) {
  return TARGET_LANGUAGES.has(stored.translationTarget) ? stored.translationTarget : DEFAULT_TARGET;
}
function validHistoryLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1000;
}
function historyLimit(stored) {
  return validHistoryLimit(stored[HISTORY_LIMIT_KEY]) ? stored[HISTORY_LIMIT_KEY] : DEFAULT_HISTORY_LIMIT;
}
let backupQueue = Promise.resolve();

function queueBackupChange(change) {
  const task = backupQueue.then(change);
  backupQueue = task.catch(() => {});
  return task;
}

async function backupMessage(message, sender) {
  if (message.type === 'backup-list') {
    await backupQueue;
    const stored = await composerApi.storage.local.get([BACKUPS_KEY, HISTORY_LIMIT_KEY, 'translationTarget', 'secondaryTranslationTarget', 'discordTarget']);
    return { ok: true, entries: stored[BACKUPS_KEY] || [], limit: historyLimit(stored), target: translationTarget(stored), secondaryTarget: stored.secondaryTranslationTarget || 'cs', discordTarget: stored.discordTarget || stored.translationTarget || 'cs' };
  }
  return queueBackupChange(async () => {
    const stored = await composerApi.storage.local.get([BACKUPS_KEY, HISTORY_LIMIT_KEY, 'translationTarget', 'secondaryTranslationTarget', 'discordTarget']);
    const entries = stored[BACKUPS_KEY] || [];
    if (message.type === 'settings-save') {
      if (!validHistoryLimit(message.limit)) throw new Error('Enter a whole number from 1 to 1,000.');
      const apiUrl = API_SETTINGS.normalize(message.apiUrl);
      if (!TARGET_LANGUAGES.has(message.target) || !TARGET_LANGUAGES.has(message.discordTarget) || !TARGET_LANGUAGES.has(message.secondaryTarget)) throw new Error('Select a supported target language.');
      await composerApi.storage.local.set({
        [API_SETTINGS.key]: apiUrl,
        translationTarget: message.target,
        secondaryTranslationTarget: message.secondaryTarget,
        discordTarget: message.discordTarget,
        [HISTORY_LIMIT_KEY]: message.limit,
        [BACKUPS_KEY]: entries.slice(0, message.limit)
      });
      return { ok: true };
    }
    if (message.type === 'backup-save') {
      if (typeof message.text !== 'string' || !message.text.trim() ||
          message.text.length > 10000) throw new Error('Invalid text for backup.');
      const target = message.target ?? DEFAULT_TARGET;
      if (!TARGET_LANGUAGES.has(target)) throw new Error('Select a supported target language.');
      let site = '';
      try { site = new URL(sender.url).hostname; } catch { /* Frame without a regular URL. */ }
      const entry = {
        id: crypto.randomUUID(), text: message.text, site, targetLanguage: target,
        createdAt: Date.now()
      };
      await composerApi.storage.local.set({ [BACKUPS_KEY]: [entry, ...entries].slice(0, historyLimit(stored)) });
      return { ok: true, id: entry.id };
    }
    if (message.type === 'backup-delete') {
      if (typeof message.id !== 'string') throw new Error('Invalid backup ID.');
      await composerApi.storage.local.set({
        [BACKUPS_KEY]: entries.filter(entry => entry.id !== message.id)
      });
      return { ok: true };
    }
    if (message.type === 'backup-complete') {
      if (typeof message.id !== 'string' || typeof message.translatedText !== 'string' ||
          !message.translatedText.trim() || message.translatedText.length > 100000) {
        throw new Error('Invalid translated text for history.');
      }
      // Never recreate entries removed by deletion or a lower history limit.
      const index = entries.findIndex(entry => entry.id === message.id);
      if (index === -1) return { ok: true, saved: false };
      const updated = entries.map((entry, position) => position === index
        ? { ...entry, translatedText: message.translatedText, completedAt: Date.now() }
        : entry);
      await composerApi.storage.local.set({ [BACKUPS_KEY]: updated });
      return { ok: true, saved: true };
    }
    await composerApi.storage.local.set({ [BACKUPS_KEY]: [] });
    return { ok: true };
  });
}

composerApi.commands.onCommand.addListener(async (command, tab) => {
  if (!['translate-selection', 'translate-selection-secondary'].includes(command)) return;
  const activeTab = tab || (await composerApi.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (activeTab?.id == null) return;
  // The command reaches all frames; only the frame with the active editor translates.
  composerApi.tabs.sendMessage(activeTab.id, { type: command }).catch(error => {
    console.warn('[WebTranslatePlace] No editor is available on this page:', error.message);
  });
});

composerApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['translation-request', 'backup-save', 'backup-list', 'backup-delete',
        'backup-clear', 'backup-complete', 'settings-save'].includes(message?.type)) return;
  (async () => {
    try {
      if (message.type !== 'translation-request') {
        sendResponse(await backupMessage(message, _sender));
        return;
      }
      const path = message.path;
      if (path !== '/translate' && !/^\/translations\/[a-f0-9]{32}$/.test(path)) {
        throw new Error('Invalid translation API path.');
      }
      const apiUrl = API_SETTINGS.normalize(message.apiUrl ?? await API_SETTINGS.load());
      const response = await fetch(apiUrl + path, {
        method: path === '/translate' ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(path === '/translate' ? { body: JSON.stringify(normalizeTranslationBody(message.body)) } : {}),
        signal: AbortSignal.timeout(15000)
      });
      const body = await response.json();
      sendResponse({ ok: response.ok, body });
    } catch (error) {
      const prefix = message.type === 'translation-request'
        ? 'The translation server is unavailable' : 'History storage is unavailable';
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
            const requestOptions = { ...options };
            if (new URL(url).pathname.endsWith('/translate') &&
                requestOptions.method === 'POST' && typeof requestOptions.body === 'string') {
              requestOptions.body = JSON.stringify(normalizeTranslationBody(JSON.parse(requestOptions.body)));
            }
            response = await fetch(url, {
              ...requestOptions,
              signal: AbortSignal.timeout(15000)
            });
          } catch (error) {
            const endpoint = new URL(url).origin;
            throw new Error(`Connection to ${endpoint} failed (${error.message}). Check the translation server, the API URL in settings and the extension permissions.`);
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
