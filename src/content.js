const extensionApi = globalThis.browser ?? globalThis.chrome;

/**
 * WebTranslatePlace - Content Script
 * Author: Tomáš Mark
 * 
 * Automatically translates Discord messages to the page language
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Debug settings
  DEBUG_ENABLED: false,              // Master switch for all debug logging
  DEBUG_VERBOSE: false,              // Extra detailed logs (element detection, viewport checks, etc.)
  DEBUG_API_REQUESTS: false,         // Log API requests and responses
  DEBUG_TRANSLATIONS: false,         // Log translation progress
  DEBUG_PERFORMANCE: false,          // Log timing and performance info

  // DEBUG_ENABLED: true,              // Master switch for all debug logging
  // DEBUG_VERBOSE: true,              // Extra detailed logs (element detection, viewport checks, etc.)
  // DEBUG_API_REQUESTS: true,         // Log API requests and responses
  // DEBUG_TRANSLATIONS: true,         // Log translation progress
  // DEBUG_PERFORMANCE: true,          // Log timing and performance info


  // Translation settings
  API_DELAY_MS: 50,                   // Delay between translation requests
  UPDATE_DEBOUNCE_MS: 150,            // Coalesce message/scroll changes
  MAX_CACHE_ENTRIES: 200,             // Bound retained translations per tab
  TRANSLATION_API_URL: 'http://127.0.0.1:5001', // Default; overridden by extension settings
  TRANSLATION_TIMEOUT_MS: 180000,      // Total timeout including queue time
  POLL_INTERVAL_MS: 500,

  // UI settings
  DEBUG_STYLING: false,               // Yellow background + red border for translations
  MANUAL_TRANSLATION: true,           // Enable manual translation with flag icon click
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Epiphany 50 provides getURL() but not runtime.id.
function getExtensionContextId() {
  try {
    const runtime = extensionApi?.runtime;
    return runtime?.id || runtime?.getURL?.('') || null;
  } catch {
    return null; // The extension context may have been unloaded.
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const logger = {
  debug: (...args) => {
    if (CONFIG.DEBUG_ENABLED && CONFIG.DEBUG_VERBOSE) {
      console.debug('[WebTranslatePlace]', ...args);
    }
  },
  log: (...args) => {
    if (CONFIG.DEBUG_ENABLED) {
      console.log('[WebTranslatePlace]', ...args);
    }
  },
  warn: (...args) => {
    if (CONFIG.DEBUG_ENABLED) {
      console.warn('[WebTranslatePlace]', ...args);
    }
  },
  error: (...args) => {
    // Always log errors
    console.error('[WebTranslatePlace]', ...args);
  },
  api: (...args) => {
    if (CONFIG.DEBUG_ENABLED && CONFIG.DEBUG_API_REQUESTS) {
      console.log('[WebTranslatePlace] 🌐', ...args);
    }
  },
  translate: (...args) => {
    if (CONFIG.DEBUG_ENABLED && CONFIG.DEBUG_TRANSLATIONS) {
      console.log('[WebTranslatePlace] 🔄', ...args);
    }
  },
  perf: (...args) => {
    if (CONFIG.DEBUG_ENABLED && CONFIG.DEBUG_PERFORMANCE) {
      console.log('[WebTranslatePlace] ⚡', ...args);
    }
  }
};

// ============================================================================
// TRANSLATION SERVICE
// ============================================================================

class TranslationService {
  /** Short requests keep the service worker responsive during slow CPU translation. */
  static async request(path, body, apiUrl = CONFIG.TRANSLATION_API_URL) {
    const responseText = await extensionApi.runtime.sendMessage(JSON.stringify({
      type: 'fetch',
      args: [apiUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }]
    }));
    if (!responseText) throw new Error('The translation server did not respond.');
    const envelope = JSON.parse(responseText);
    if (envelope.error) throw new Error(envelope.error);
    let response;
    try {
      response = JSON.parse(envelope.text);
    } catch {
      throw new Error('The translation server returned an invalid response.');
    }
    if (!envelope.ok) {
      throw new Error(response.error || `Translation server error: HTTP ${envelope.status}`);
    }
    return response;
  }

  static async translate(text, onProgress) {
    // Keep submission and polling on the same server, even if settings change.
    const stored = await extensionApi.storage.local.get(['translationApiUrl', 'discordTarget', 'translationTarget']);
    const apiUrl = stored.translationApiUrl || CONFIG.TRANSLATION_API_URL;
    const deadline = Date.now() + CONFIG.TRANSLATION_TIMEOUT_MS;
    let response = await this.request('/translate', {
      q: text, source: 'auto', target: stored.discordTarget || stored.translationTarget || 'cs'
    }, apiUrl);
    const jobId = response.jobId;
    if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)) {
      throw new Error('The server did not return a valid translation ID.');
    }
    while (response.status === 'pending') {
      if (typeof response.partialText === 'string' && response.partialText.trim()) {
        onProgress?.(response.partialText);
      }
      if (Date.now() >= deadline) throw new Error('Translation timed out. Try again.');
      await delay(CONFIG.POLL_INTERVAL_MS);
      response = await this.request(`/translations/${jobId}`, undefined, apiUrl);
    }
    if (response.status === 'failed') throw new Error(response.error || 'Translation failed.');
    if (response.status !== 'done' || typeof response.translatedText !== 'string' ||
        !response.translatedText.trim()) {
      throw new Error('The server did not return translated text.');
    }
    return response.translatedText;
  }
}

// ============================================================================
// CONTENT SCRIPT CONTEXT MANAGER
// ============================================================================

class ContentScriptContext {
  constructor(scriptName) {
    this.scriptName = scriptName;
    this.abortController = new AbortController();
    this.isTopFrame = window.self === window.top;
    this.receivedMessageIds = new Set();

    if (this.isTopFrame) {
      this.stopOldScripts();
      this.listenForNewerScripts({ ignoreFirstEvent: true });
    } else {
      this.listenForNewerScripts();
    }
  }

  get signal() {
    return this.abortController.signal;
  }

  get isValid() {
    return !this.signal.aborted && getExtensionContextId() != null;
  }

  get isInvalid() {
    return !this.isValid;
  }

  onInvalidated(callback) {
    this.signal.addEventListener('abort', callback);
    return () => this.signal.removeEventListener('abort', callback);
  }

  stopOldScripts() {
    const messageType = `${getExtensionContextId()}:content-script-started`;
    window.postMessage({
      type: messageType,
      contentScriptName: this.scriptName,
      messageId: Math.random().toString(36).slice(2)
    }, '*');
  }

  listenForNewerScripts(options = {}) {
    let isFirst = true;
    const messageType = `${getExtensionContextId()}:content-script-started`;

    const handler = (event) => {
      if (event.data?.type === messageType &&
        event.data?.contentScriptName === this.scriptName &&
        !this.receivedMessageIds.has(event.data?.messageId)) {

        this.receivedMessageIds.add(event.data.messageId);

        const shouldIgnore = isFirst && options.ignoreFirstEvent;
        isFirst = false;

        if (!shouldIgnore) {
          this.abortController.abort('Newer script detected');
          logger.debug(`Content script "${this.scriptName}" invalidated by newer instance`);
        }
      }
    };

    window.addEventListener('message', handler);
    this.onInvalidated(() => window.removeEventListener('message', handler));
  }
}

// ============================================================================
// DISCORD MESSAGE TRANSLATOR
// ============================================================================

class DiscordTranslator {
  constructor(context) {
    this.context = context;
    this.translationCache = new Map(); // text -> translation (persistent across channels)
    this.processedMessages = new Set(); // Set of message IDs that have been processed (cleared on channel change)
    this.messageTranslations = new Map(); // messageId -> { element, translatedElement, originalDisplay, icon, ... }
    this.PROCESSED_ATTRIBUTE = 'discord-translator-processed';
    this.TRANSLATION_CLASS = 'discord-translator-translation';
    this.FLAG_ICON_CLASS = 'discord-translator-flag-icon';
    this.FLAG_CONTAINER_CLASS = 'discord-translator-flag-container';
    this.currentChannelId = null; // Track current channel
    this.isTranslating = false; // Flag to prevent multiple concurrent translations
    this.isActive = true; // Translator automatically active for Discord
    this.stateRevision = 0;
    this.processingStarted = false;
    this.processingTimer = null;
    this.processingDirty = false;
    this.messageObserver = null;
    this.onPageChange = () => this.scheduleProcessing();
    this.onVisibilityChange = () => this.updateVisibility();

    // Inject CSS for flag icons
    this.injectFlagIconStyles();
    this.context.onInvalidated(() => {
      this.stopProcessing();
      this.cleanupTranslations();
    });
  }

  /**
   * Inject CSS styles for flag icons
   */
  injectFlagIconStyles() {
    if (document.getElementById('discord-translator-flag-styles')) {
      return; // Already injected
    }

    const styleElement = document.createElement('style');
    styleElement.id = 'discord-translator-flag-styles';
    styleElement.textContent = `
      .${this.FLAG_CONTAINER_CLASS} {
        display: inline-flex;
        align-items: center;
        opacity: 0.5;
        transition: opacity 0.3s ease;
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10;
        pointer-events: auto;
      }
      
      /* Make parent message have relative positioning for absolute child */
      [class*="markup"] {
        position: relative;
      }
      
      .${this.FLAG_CONTAINER_CLASS}:hover {
        opacity: 1;
      }
      
      .${this.FLAG_ICON_CLASS} {
        cursor: pointer;
        font-size: 20.72px;
        padding: 0;
        border-radius: 4px;
        transition: all 0.3s ease;
        user-select: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        width: 22.68px;
        height: 22.68px;
        color: var(--text-muted, #747f8d);
        position: relative;
      }
      
      .${this.FLAG_ICON_CLASS}:hover {
        background: rgba(35, 151, 255, 0.15);
        color: #2397ff;
        transform: scale(1.0);
        box-shadow: none;
      }
      
      /* Better visibility in different Discord themes */
      [data-theme="light"] .${this.FLAG_ICON_CLASS}:hover {
        background: rgba(35, 151, 255, 0.12);
        box-shadow: 0 1px 3px rgba(35, 151, 255, 0.25);
      }
      
      [data-theme="dark"] .${this.FLAG_ICON_CLASS}:hover {
        background: rgba(35, 151, 255, 0.18);
        box-shadow: 0 2px 4px rgba(35, 151, 255, 0.15);
      }
      
      .${this.FLAG_ICON_CLASS}:active {
        transform: scale(0.95);
        background: rgba(35, 151, 255, 0.25);
      }
      
      .${this.FLAG_ICON_CLASS}:focus {
        outline: none;
        background: rgba(35, 151, 255, 0.1);
        box-shadow: 0 0 0 2px rgba(35, 151, 255, 0.3);
      }
      
      .${this.FLAG_ICON_CLASS}.translating {
        opacity: 0.5;
        cursor: wait;
        animation: pulse 1.5s infinite;
      }

      .${this.FLAG_ICON_CLASS}.translated {
        opacity: 1;
      }

      .${this.FLAG_ICON_CLASS}.translation-complete {
        color: #2397ff;
        animation: none;
      }

      .${this.FLAG_ICON_CLASS}.translation-complete::after {
        content: '✓';
        position: absolute;
        right: -3px;
        bottom: -3px;
        width: 12px;
        height: 12px;
        background: transparent;
        color: #2397ff;
        font: bold 12px/12px sans-serif;
        text-align: center;
        pointer-events: none;
      }

      @media (prefers-reduced-motion: reduce) {
        .${this.FLAG_ICON_CLASS}.translating { animation: none; }
      }
      
      @keyframes pulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 0.8; }
      }
      
      .${this.FLAG_ICON_CLASS} svg {
        width: 100%;
        height: 100%;
        border-radius: 2px;
      }

    `;
    
    document.head.appendChild(styleElement);
    logger.debug('Flag icon styles injected');
  }

  async start() {
    logger.log('='.repeat(60));
    logger.log('Discord Translator initialized by Tomáš Mark');
    logger.log('='.repeat(60));
    logger.log('Configuration:');
    logger.log(`  Debug Enabled: ${CONFIG.DEBUG_ENABLED}`);
    logger.log(`  Debug Verbose: ${CONFIG.DEBUG_VERBOSE}`);
    logger.log(`  Debug API: ${CONFIG.DEBUG_API_REQUESTS}`);
    logger.log('  Target Language: configured in extension settings');
    logger.log(`  API Delay: ${CONFIG.API_DELAY_MS}ms`);
    logger.log(`  Update debounce: ${CONFIG.UPDATE_DEBOUNCE_MS}ms`);
    logger.log(`  Debug Styling: ${CONFIG.DEBUG_STYLING ? 'ON (yellow+red)' : 'OFF (subtle gray)'}`);
    logger.log(`  Manual Translation: ${CONFIG.MANUAL_TRANSLATION ? 'ON (flag icons)' : 'OFF (auto-translate)'}`);
    logger.log('='.repeat(60));

    // Apply setting changes to all open Discord tabs.
    const onSettingsChanged = (changes, area) => {
      if (area === 'local' && changes.discordTarget &&
          changes.discordTarget.newValue !== changes.discordTarget.oldValue && !this.context?.isInvalid) {
        this.translationCache.clear();
        const active = this.isActive;
        this.setActive(false);
        if (active) this.setActive(true);
      }
      if (area === 'local' && changes.translatorActive && !this.context?.isInvalid) {
        this.setActive(changes.translatorActive.newValue !== false);
      }
    };
    extensionApi.storage?.onChanged?.addListener(onSettingsChanged);
    this.context?.onInvalidated?.(() => {
      extensionApi.storage?.onChanged?.removeListener(onSettingsChanged);
    });

    // Get initial state from background (but default to ON)
    await this.checkState();

    // Listen for state changes (for manual toggle if needed)
    extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (typeof message !== 'string') return;
      try {
        const { type, args } = JSON.parse(message);
        if (type !== 'stateChanged') return;
        if (type === 'stateChanged') {
          const [isActive] = args;
          this.setActive(isActive);
          sendResponse(JSON.stringify({ success: true }));
        }
      } catch (error) {
        logger.error('Error handling message:', error);
      }
      return true;
    });

    // Always start processing automatically on Discord
    logger.log('🚀 Starting automatic message translation...');
    await this.startProcessing();
  }

  /**
   * Check current state from background
   */
  async checkState() {
    const revision = this.stateRevision;
    // Check if extension runtime is still valid
    if (!getExtensionContextId()) {
      logger.error('WebExtension runtime not available');
      this.isActive = true; // Default to ON for automatic translation
      return;
    }

    try {
      const response = await extensionApi.runtime.sendMessage(JSON.stringify({
        type: 'getState',
        args: []
      }));
      const state = JSON.parse(response);
      if (revision !== this.stateRevision) return;
      this.isActive = state.isActive ?? true; // Default to ON if undefined
      logger.log(`📊 Current state: ${this.isActive ? 'ON (automatic)' : 'OFF'}`);
    } catch (error) {
      logger.error('Error checking state:', error);
      if (revision !== this.stateRevision) return;
      this.isActive = true; // Default to ON on error for automatic translation
    }
  }

  /**
   * Set translator active state
   */
  setActive(isActive) {
    if (this.isActive === isActive) return;
    this.stateRevision = (this.stateRevision || 0) + 1;
    this.isActive = isActive;
    logger.log(`🔄 Translator ${isActive ? 'activated' : 'deactivated'}`);

    if (isActive) {
      this.startProcessing();
    } else {
      this.stopProcessing();
      this.cleanupTranslations();
      this.processedMessages.clear();
      document.querySelectorAll(`[${this.PROCESSED_ATTRIBUTE}]`).forEach(element => {
        element.removeAttribute(this.PROCESSED_ATTRIBUTE);
      });
    }
  }

  /**
   * Start processing messages
   */
  async startProcessing() {
    if (this.processingStarted || !this.isActive || this.context.isInvalid) return;
    this.processingStarted = true;
    this.messageObserver = new MutationObserver(records => {
      if (document.hidden) return;
      if (records.some(record => this.mutationTouchesMessages(record))) {
        this.scheduleProcessing();
      }
    });
    document.addEventListener('scroll', this.onPageChange, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('resize', this.onPageChange, { passive: true });
    this.updateVisibility();
  }

  updateVisibility() {
    if (!this.processingStarted) return;
    if (document.hidden) {
      this.messageObserver.disconnect();
    } else {
      this.messageObserver.observe(document.body, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'contenteditable']
      });
    }
    this.scheduleProcessing();
  }

  mutationTouchesMessages(record) {
    const selector = '[class*="markup"], [id^="chat-messages-"], [id^="message-content-"]';
    const ownSelector = `.${this.FLAG_CONTAINER_CLASS}, .${this.TRANSLATION_CLASS}`;
    const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (element?.closest(ownSelector)) return false;
    if (record.type !== 'childList') return !!element?.closest(selector);
    // Ignore our inserted icons and progressive translated text. A removed
    // translation still matters: Discord may have rebuilt its message DOM.
    const changed = [...record.addedNodes, ...record.removedNodes];
    const relevantNodes = changed.filter(node => !(node.nodeType === 1 &&
      node.matches(ownSelector) && ![...record.removedNodes].includes(node)));
    if (!relevantNodes.length) return false;
    if (element?.closest(selector)) return true;
    return relevantNodes.some(node => {
      return (node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))) ||
        (node.nodeType === 3 && !!element?.closest(selector));
    });
  }

  scheduleProcessing() {
    if (!this.processingStarted || !this.isActive || this.context.isInvalid) return;
    if (document.hidden) {
      if (this.processingTimer !== null) clearTimeout(this.processingTimer);
      this.processingTimer = null;
      return;
    }
    this.processingDirty = true;
    if (this.processingTimer !== null || this.isTranslating) return;
    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      if (document.hidden || !this.processingStarted) return;
      this.processingDirty = false;
      void this.processMessages().catch(error => logger.error('Message update failed:', error));
    }, CONFIG.UPDATE_DEBOUNCE_MS);
  }

  stopProcessing() {
    this.processingStarted = false;
    this.processingDirty = false;
    if (this.processingTimer !== null) clearTimeout(this.processingTimer);
    this.processingTimer = null;
    this.messageObserver?.disconnect();
    this.messageObserver = null;
    document.removeEventListener('scroll', this.onPageChange, true);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.onPageChange);
  }

  cacheTranslation(text, translation) {
    this.translationCache.delete(text);
    this.translationCache.set(text, translation);
    while (this.translationCache.size > CONFIG.MAX_CACHE_ENTRIES) {
      this.translationCache.delete(this.translationCache.keys().next().value);
    }
  }

  /**
   * Send stats to background
   */
  async sendStats() {
    // Check if extension runtime is still valid
    if (!getExtensionContextId()) {
      logger.debug('WebExtension runtime not available, skipping stats update');
      return;
    }

    try {
      await extensionApi.runtime.sendMessage(JSON.stringify({
        type: 'updateStats',
        args: [{
          translated: this.messageTranslations.size,
          cached: this.translationCache.size
        }]
      }));
    } catch (error) {
      // Background might not be ready or extension was reloaded, ignore
      logger.debug('Failed to send stats:', error.message);
    }
  }

  /**
   * Get unique ID for a message element
   * Uses Discord's message ID from parent container
   */
  getMessageId(markupElement) {
    // Try to find parent message container with ID
    let current = markupElement;
    while (current && current !== document.body) {
      // Discord message IDs are in format: chat-messages-{channelId}-{messageId}
      if (current.id && current.id.includes('chat-messages-')) {
        return current.id;
      }
      // Also check for message content ID
      if (current.id && current.id.startsWith('message-content-')) {
        return current.id;
      }
      current = current.parentElement;
    }

    // Fallback: use text content hash + position
    const text = markupElement.textContent.trim();
    const position = Array.from(document.querySelectorAll(
      `[class*="markup"]:not(.${this.TRANSLATION_CLASS})`
    )).indexOf(markupElement);
    return `msg-${this.simpleHash(text)}-${position}`;
  }

  /**
   * Simple hash function for text
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Check if element is visible in viewport
   */
  isElementVisible(element) {
    const rect = element.getBoundingClientRect();
    const windowHeight = window.innerHeight || document.documentElement.clientHeight;
    const windowWidth = window.innerWidth || document.documentElement.clientWidth;

    // Element is visible if any part is in viewport
    const vertInView = (rect.top <= windowHeight) && ((rect.top + rect.height) >= 0);
    const horInView = (rect.left <= windowWidth) && ((rect.left + rect.width) >= 0);

    return vertInView && horInView;
  }

  /**
   * Get current Discord channel ID from URL or DOM
   */
  getCurrentChannelId() {
    // Method 1: From URL (most reliable)
    const urlMatch = window.location.pathname.match(/\/channels\/(\d+)\/(\d+)/);
    if (urlMatch) {
      return urlMatch[2]; // Return channel ID (second number)
    }

    // Method 2: From DOM - look for channel name element
    const channelName = document.querySelector('[class*="title"]');
    if (channelName) {
      return `channel-${this.simpleHash(channelName.textContent)}`;
    }

    return 'unknown-channel';
  }

  /**
   * Check if channel changed and reset processed messages if needed
   */
  checkChannelChange() {
    const newChannelId = this.getCurrentChannelId();

    if (this.currentChannelId !== newChannelId) {
      logger.log(`📺 Channel changed: ${this.currentChannelId || 'none'} → ${newChannelId}`);

      // Discord may reuse the original nodes when returning to a channel.
      this.cleanupTranslations();
      // Clear processed messages (but keep translation cache for speed)
      this.processedMessages.clear();

      logger.log(`🗑️ Cleared processed messages (${this.translationCache.size} translations in cache)`);

      this.currentChannelId = newChannelId;
      return true; // Channel changed
    }

    return false; // Same channel
  }

  /**
   * Add clickable translation icons to messages for manual translation
   */
  async addFlagIcons(allMessages = document.querySelectorAll(
    `[class*="markup"]:not(.${this.TRANSLATION_CLASS})`
  )) {
    
    logger.debug(`Found ${allMessages.length} total messages to check for translation icons`);

    let flagsAdded = 0;
    let flagsSkipped = 0;

    for (const messageElement of allMessages) {
      try {
        const messageId = this.getMessageId(messageElement);

        const previous = this.messageTranslations.get(messageId);
        let translationToRestore = null;
        if (previous && (previous.element !== messageElement ||
            !previous.translatedElement.isConnected)) {
          // Several elements within one message can share an ID. While the existing
          // translation is in the DOM, another element must not restore the original.
          if (previous.element !== messageElement && previous.element.isConnected &&
              previous.translatedElement.isConnected) {
            flagsSkipped++;
            continue;
          }
          if (previous.complete && previous.text === messageElement.textContent.trim()) {
            translationToRestore = previous.translation;
          }
          this.restoreTranslation(previous);
          this.messageTranslations.delete(messageId);
          this.processedMessages.delete(messageId);
        } else if (previous?.showingTranslation &&
                   messageElement.style.getPropertyValue('display') !== 'none') {
          // Discord may overwrite the original node's inline style when rendering.
          this.setTranslationVisible(previous, true);
        }
        
        // Skip messages being edited
        if (this.isMessageBeingEdited(messageElement)) {
          flagsSkipped++;
          continue;
        }
        
        // Skip if already has flag icon
        if (this.processedMessages.has(messageId) && this.hasFlagNearby(messageElement)) {
          flagsSkipped++;
          continue;
        }
        
        // Check if flag already exists near this message
        if (this.hasFlagNearby(messageElement)) {
          this.processedMessages.add(messageId);
          flagsSkipped++;
          continue;
        }

        // Skip if message is already translated
        if (this.messageTranslations.has(messageId)) {
          this.processedMessages.add(messageId);
          flagsSkipped++;
          continue;
        }

        // Skip embeds and replies (same logic as in processMessages)
        if (this.shouldSkipMessage(messageElement)) {
          continue;
        }

        // Skip if no content
        const hasContent = messageElement.textContent.trim().length > 0;
        if (!hasContent) {
          continue;
        }

        // Only add flag to visible messages
        if (!this.isElementVisible(messageElement)) {
          continue;
        }

        // Debug message structure if needed
        this.analyzeMessageStructure(messageElement);

        // Find a good place to add the translation icon
        const flagContainer = this.createFlagIcon(messageElement, messageId);
        if (flagContainer) {
          flagsAdded++;
          this.processedMessages.add(messageId);
          if (translationToRestore) {
            this.displaySingleTranslation(messageElement, translationToRestore, messageId,
                                          flagContainer.firstElementChild);
          }
        }

      } catch (error) {
        logger.error('Error adding translation icon:', error);
      }
    }

    logger.log(`� Translation icons: ${flagsAdded} added, ${flagsSkipped} skipped`);
  }

  /**
   * Check if message is being edited
   */
  isMessageBeingEdited(messageElement) {
    // Text inside an editor may use the same `markup` class as a sent
    // message. Never treat it as a message to translate.
    if (messageElement.closest?.('textarea, input, [contenteditable], [role="textbox"]')) {
      return true;
    }

    // Check if the message element itself contains edit fields
    if (messageElement.querySelector('textarea, input, [contenteditable], [role="textbox"]')) {
      return true;
    }

    // Check parent message container
    let parent = messageElement.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 10) {
      // Check if this is a message container
      if (parent.role === 'article' || parent.classList?.contains('message')) {
        // Check if it contains edit fields
        if (parent.querySelector('textarea, input, [contenteditable], [role="textbox"]')) {
          return true;
        }
        break; // Found message container, stop searching
      }
      parent = parent.parentElement;
      depth++;
    }

    return false;
  }

  /**
   * Check if message should be skipped (embeds, replies, etc.)
   */
  shouldSkipMessage(messageElement) {
    const messageId = this.getMessageId(messageElement);

    // Skip messages being edited
    if (this.isMessageBeingEdited(messageElement)) {
      logger.debug(`⏭️ Skipping message being edited [${messageId}]`);
      return true;
    }

    // Skip embeds
    let current = messageElement.parentElement;
    while (current && current !== document.body) {
      const classList = current.classList ? Array.from(current.classList).join(' ') : '';
      const className = current.className || '';

      if (classList.includes('embed') ||
          classList.includes('messageAccessories') ||
          classList.includes('container') && classList.includes('embedWrapper') ||
          className.includes('embed') ||
          current.id?.includes('message-accessories')) {
        logger.debug(`⏭️ Skipping embed element [${messageId}]`);
        return true;
      }
      current = current.parentElement;
    }

    // Skip replies/quotes
    let parent = messageElement.parentElement;
    while (parent && parent !== document.body) {
      const classList = parent.classList ? Array.from(parent.classList).join(' ') : '';
      if (classList.includes('repliedMessage') ||
          classList.includes('repliedText') ||
          parent.id?.startsWith('message-reply-context')) {
        logger.debug(`⏭️ Skipping quoted/reply element [${messageId}]`);
        return true;
      }
      parent = parent.parentElement;
    }

    return false;
  }

  /**
   * Create and insert a clickable translation icon next to a message
   */
  createFlagIcon(messageElement, messageId) {
    try {
      if (this.isMessageBeingEdited(messageElement)) return null;
      logger.debug(`Creating flag icon for message [${messageId}]`);
      
      const targetParent = messageElement.parentElement;
      if (!targetParent) {
        logger.debug(`No parent found for message [${messageId}]`);
        return null;
      }
      
      const flagContainer = this.createFlagElement(messageElement, messageId);
      
      // Simply add the flag after the message element as a sibling
      // DO NOT wrap or move the original message element to avoid conflicts with Discord's edit functionality
      if (messageElement.nextSibling) {
        targetParent.insertBefore(flagContainer, messageElement.nextSibling);
      } else {
        targetParent.appendChild(flagContainer);
      }
      
      logger.debug(`Flag icon placed for [${messageId}]`);
      return flagContainer;

    } catch (error) {
      logger.error(`Error creating flag icon for message [${messageId}]:`, error);
      return null;
    }
  }
  
  /**
   * Check if flag can be placed inline with message
   */
  canPlaceInline(messageElement) {
    const style = window.getComputedStyle(messageElement);
    const parent = messageElement.parentElement;
    const parentStyle = window.getComputedStyle(parent);
    
    return (
      style.display.includes('inline') ||
      parentStyle.display === 'flex' ||
      parent.tagName.toLowerCase() === 'span'
    );
  }
  
  /**
   * Find the message wrapper/container in Discord's structure
   */
  findMessageWrapper(messageElement) {
    let current = messageElement.parentElement;
    let depth = 0;
    const maxDepth = 5; // Prevent infinite loops
    
    while (current && current !== document.body && depth < maxDepth) {
      const classList = Array.from(current.classList || []).join(' ');
      const className = current.className || '';
      
      // Look for Discord message content patterns
      if (
        classList.includes('messageContent') ||
        classList.includes('markup') && current !== messageElement ||
        className.includes('content') ||
        current.querySelector('[class*="timestamp"]') // Messages usually have timestamps nearby
      ) {
        logger.debug(`Found wrapper at depth ${depth}:`, current.className);
        return current;
      }
      
      current = current.parentElement;
      depth++;
    }
    
    return null;
  }
  
  /**
   * Check if there's already a flag icon near this message
   */
  hasFlagNearby(messageElement) {
    // Check siblings
    const parent = messageElement.parentElement;
    if (!parent) return false;
    
    // Check next/previous siblings
    const siblings = Array.from(parent.children);
    const messageIndex = siblings.indexOf(messageElement);
    
    // Check 2 siblings in each direction
    for (let i = Math.max(0, messageIndex - 2); i <= Math.min(siblings.length - 1, messageIndex + 2); i++) {
      const sibling = siblings[i];
      if (sibling.classList?.contains(this.FLAG_CONTAINER_CLASS) ||
          sibling.querySelector(`.${this.FLAG_CONTAINER_CLASS}`)) {
        return true;
      }
    }
    
    // Check if parent contains a flag
    return parent.querySelector(`.${this.FLAG_CONTAINER_CLASS}`) !== null;
  }

  /**
   * Debug helper - analyze message structure for flag placement
   */
  analyzeMessageStructure(messageElement) {
    if (!CONFIG.DEBUG_ENABLED) return;
    
    const messageId = this.getMessageId(messageElement);
    const parent = messageElement.parentElement;
    const style = window.getComputedStyle(messageElement);
    const parentStyle = window.getComputedStyle(parent);
    
    logger.debug(`Message structure analysis [${messageId}]:`, {
      element: messageElement.tagName,
      elementClass: messageElement.className,
      elementDisplay: style.display,
      parent: parent.tagName,
      parentClass: parent.className,
      parentDisplay: parentStyle.display,
      canPlaceInline: this.canPlaceInline(messageElement),
      hasWrapper: !!this.findMessageWrapper(messageElement),
      hasFlagNearby: this.hasFlagNearby(messageElement)
    });
  }

  /**
   * Create the flag icon element
   */
  createFlagElement(messageElement, messageId) {
    const flagContainer = document.createElement('span');
    flagContainer.className = this.FLAG_CONTAINER_CLASS;
    
    const flagIcon = document.createElement('button');
    flagIcon.className = this.FLAG_ICON_CLASS;
    flagIcon.title = 'Translate message';
    flagIcon.setAttribute('aria-label', flagIcon.title);
    flagIcon.setAttribute('aria-pressed', 'false');
    flagIcon.setAttribute('data-message-id', messageId);
    
    this.setFlagStatus(flagIcon, 'idle');
    
    // Add click handler
    flagIcon.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.translateSingleMessage(messageElement, messageId, flagIcon);
    });
    
    flagContainer.appendChild(flagIcon);
    return flagContainer;
  }

  /**
   * Translate a single message when flag is clicked
   */
  async translateSingleMessage(messageElement, messageId, flagIcon) {
    if (this.isActive === false || this.context?.isInvalid) return;
    const revision = this.stateRevision;
    const isCurrent = () => this.isActive !== false && revision === this.stateRevision &&
      !this.context?.isInvalid;
    if (this.messageTranslations.has(messageId)) {
      this.toggleTranslation(messageId);
      return;
    }
    if (flagIcon.classList.contains('translating')) return;
    try {
      logger.log(`🔄 Translating message on demand [${messageId}]`);
      
      // Further clicks only toggle visibility without calling the translator again.
      if (this.messageTranslations.has(messageId)) {
        this.toggleTranslation(messageId);
        return;
      }

      this.setFlagStatus(flagIcon, 'loading');
      flagIcon.title = 'Translating…';
      flagIcon.setAttribute('aria-label', flagIcon.title);
      
      // Extract text content
      const textContent = this.extractCleanText(messageElement);
      if (!textContent || textContent.trim().length === 0) {
        logger.debug(`⏭️ No text to translate [${messageId}]`);
        this.setFlagStatus(flagIcon, 'idle');
        flagIcon.title = 'No text to translate';
        flagIcon.setAttribute('aria-label', flagIcon.title);
        return;
      }

      // Check cache first
      if (this.translationCache.has(textContent)) {
        const cachedTranslation = this.translationCache.get(textContent);
        this.displaySingleTranslation(messageElement, cachedTranslation, messageId, flagIcon);
        logger.log(`✅ Message [${messageId}] translated from cache`);
        return;
      }

      // Translate using API
      const translation = await this.translateText(textContent, partial => {
        if (!isCurrent() || !partial?.trim() || !messageElement.isConnected) return;
        if (this.messageTranslations.has(messageId)) {
          this.updateTranslation(messageId, partial);
        } else {
          this.displaySingleTranslation(messageElement, partial, messageId, flagIcon, false);
        }
      });
      if (!isCurrent()) return;
      if (translation && translation.trim().length > 0) {
        // Cache translation
        this.cacheTranslation(textContent, translation);
        
        // Display translation
        if (this.messageTranslations.has(messageId)) {
          this.updateTranslation(messageId, translation, true);
        } else if (messageElement.isConnected) {
          this.displaySingleTranslation(messageElement, translation, messageId, flagIcon);
        }
        this.setFlagStatus(flagIcon, 'done');
        logger.log(`✅ Message [${messageId}] translated successfully`);
      } else {
        throw new Error('Empty translation received');
      }

    } catch (error) {
      if (!isCurrent()) return;
      const state = this.messageTranslations.get(messageId);
      if (state && !state.complete) {
        this.restoreTranslation(state, false);
        this.messageTranslations.delete(messageId);
      }
      logger.error(`❌ Error translating message [${messageId}]:`, error);
      this.setFlagStatus(flagIcon, 'error');
      flagIcon.title = `Translation error: ${error.message}. Click to retry.`;
      flagIcon.setAttribute('aria-label', flagIcon.title);

    }
  }

  /**
   * Extract clean text from message element
   */
  extractCleanText(element) {
    const clone = element.cloneNode(true);
    
    // Remove Discord-specific elements including code blocks
    const elementsToRemove = clone.querySelectorAll(
      '[class*="repliedMessage"], ' +
      '[class*="repliedText"], ' +
      '[class*="embed"], ' +
      'pre, code, ' +
      'img, video, audio'
    );
    
    elementsToRemove.forEach(el => el.remove());
    
    let text = clone.textContent || '';
    
    // Remove URLs
    text = text.replace(/https?:\/\/[^\s]+/g, '');
    
    return text.trim();
  }

  /**
   * Translate text using the API
   */
  async translateText(text, onProgress) {
    return TranslationService.translate(text, onProgress);
  }

  /**
   * Display the translation in place; keep the original node untouched for Discord.
   */
  displaySingleTranslation(messageElement, translatedText, messageId, flagIcon, complete = true) {
    if (!messageElement?.isConnected || !messageElement.parentElement) {
      throw new Error('The message is no longer on the page.');
    }
    if (this.isMessageBeingEdited(messageElement)) {
      throw new Error('Cannot toggle the translation while editing the message.');
    }
    if (this.messageTranslations.has(messageId)) return;

    const translationElement = document.createElement(messageElement.tagName.toLowerCase());
    translationElement.className = `${messageElement.className} ${this.TRANSLATION_CLASS}`.trim();
    translationElement.style.cssText = messageElement.style.cssText;
    translationElement.textContent = translatedText;
    translationElement.setAttribute('lang', 'cs');
    translationElement.setAttribute('data-message-id', messageId);
    messageElement.parentElement.insertBefore(translationElement, messageElement);

    const originalDisplay = messageElement.style.getPropertyValue('display');
    const originalPriority = messageElement.style.getPropertyPriority('display');
    const state = {
      text: messageElement.textContent.trim(),
      translation: translatedText,
      element: messageElement,
      translatedElement: translationElement,
      originalDisplay,
      originalPriority,
      icon: flagIcon,
      showingTranslation: false,
      complete,
      timestamp: Date.now()
    };
    this.messageTranslations.set(messageId, state);
    this.setTranslationVisible(state, true);
  }

  updateTranslation(messageId, text, complete = false) {
    const state = this.messageTranslations.get(messageId);
    if (!state || !state.element.isConnected || !state.translatedElement.isConnected) return;
    if (!text?.trim()) return;
    state.translation = text;
    state.complete = complete;
    state.translatedElement.textContent = text;
    this.setTranslationVisible(state, state.showingTranslation);
  }

  setFlagStatus(icon, status) {
    const loading = status === 'loading';
    icon.classList.toggle('translating', loading);
    icon.classList.toggle('translation-complete', status === 'done');
    icon.setAttribute('aria-busy', String(loading));
    // Keep the SVG static; only the loading CSS class may animate it.
    if (icon.getAttribute('data-translation-state') !== status) {
      if (status === 'error') {
        icon.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path opacity="0.6" d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/><circle fill="#f44336" cx="18" cy="6" r="4"/><path d="M16 4l4 4m0-4l-4 4" stroke="white" stroke-width="1.5"/></svg>`;
      } else {
        icon.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true"><path opacity="0.6" d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;
      }
      icon.setAttribute('data-translation-state', status);
    }
  }

  setTranslationVisible(state, showTranslation) {
    if (showTranslation) {
      state.element.style.setProperty('display', 'none', 'important');
      state.translatedElement.hidden = false;
    } else {
      if (state.originalDisplay) {
        state.element.style.setProperty('display', state.originalDisplay, state.originalPriority);
      } else {
        state.element.style.removeProperty('display');
      }
      state.translatedElement.hidden = true;
    }
    state.showingTranslation = showTranslation;
    if (state.icon) {
      this.setFlagStatus(state.icon, state.complete ? 'done' : 'loading');
      state.icon.classList.toggle('translated', showTranslation);
      state.icon.title = showTranslation ? 'Show original' :
        (state.complete ? 'Show translation' : 'Show partial translation');
      state.icon.setAttribute('aria-label', state.icon.title);
      state.icon.setAttribute('aria-pressed', String(showTranslation));
    }
  }

  toggleTranslation(messageId) {
    const state = this.messageTranslations.get(messageId);
    if (!state) return;
    if (!state.element.isConnected || !state.translatedElement.isConnected) {
      this.restoreTranslation(state);
      this.messageTranslations.delete(messageId);
      this.processedMessages.delete(messageId);
      return;
    }
    if (this.isMessageBeingEdited(state.element)) return;
    this.setTranslationVisible(state, !state.showingTranslation);
  }

  restoreTranslation(state, removeIcon = true) {
    if (state.originalDisplay) {
      state.element.style.setProperty('display', state.originalDisplay, state.originalPriority);
    } else {
      state.element.style.removeProperty('display');
    }
    state.translatedElement.remove();
    if (removeIcon) state.icon?.closest(`.${this.FLAG_CONTAINER_CLASS}`)?.remove();
  }

  cleanupTranslations() {
    for (const state of this.messageTranslations.values()) {
      this.restoreTranslation(state);
    }
    this.messageTranslations.clear();
    document.querySelectorAll(`.${this.FLAG_CONTAINER_CLASS}`).forEach(icon => icon.remove());
  }

  reconcileTranslations() {
    for (const [messageId, state] of this.messageTranslations) {
      if (!state.element.isConnected || !state.translatedElement.isConnected ||
          state.element.textContent.trim() !== state.text ||
          this.isMessageBeingEdited(state.element)) {
        this.restoreTranslation(state);
        this.messageTranslations.delete(messageId);
        this.processedMessages.delete(messageId);
      }
    }
  }

  async processMessages() {
    // A slow model must not start the same batch again on every timer tick.
    if (this.isTranslating) return;
    this.isTranslating = true;
    try {
      await this.processMessageBatch();
    } finally {
      this.isTranslating = false;
      if (this.processingDirty) this.scheduleProcessing();
    }
  }

  async processMessageBatch() {
    if (this.context.isInvalid) {
      logger.log('Context invalidated, stopping...');
      this.stopProcessing();
      return;
    }

    if (!this.isActive || document.hidden) {
      logger.debug('Translator is not active, skipping processing');
      return;
    }

    // Check if channel changed and reset if needed
    const channelChanged = this.checkChannelChange();
    if (channelChanged) {
      logger.log('🔄 Channel changed, will process all messages in new channel');
    }
    this.reconcileTranslations();

    // Use the best selector that finds message content reliably
    const allMessages = document.querySelectorAll(
      `[class*="markup"]:not(.${this.TRANSLATION_CLASS})`
    );

    const liveIds = new Set([...allMessages].map(element => this.getMessageId(element)));
    for (const id of this.processedMessages) {
      if (!liveIds.has(id)) this.processedMessages.delete(id);
    }
    logger.log('Found messages:', allMessages.length);

    if (allMessages.length === 0) {
      logger.debug('No messages found, will retry in next cycle');
      return;
    }

    // If manual translation mode is enabled, add flag icons instead of auto-translating
    if (CONFIG.MANUAL_TRANSLATION) {
      await this.addFlagIcons(allMessages);
      return;
    }

    // Filter messages that haven't been processed and have content
    let processedCount = 0;
    let noContentCount = 0;
    let hasTranslationCount = 0;
    let alreadyInSetCount = 0;
    let notVisibleCount = 0;

    const messageElements = [...allMessages].filter(el => {
      // Get unique message ID
      const messageId = this.getMessageId(el);

      // Skip messages being edited
      if (this.isMessageBeingEdited(el)) {
        logger.debug('Skipping message in edit mode');
        return false;
      }

      // Check if already processed using our Set
      const alreadyProcessed = this.processedMessages.has(messageId);
      if (alreadyProcessed) {
        alreadyInSetCount++;
        return false;
      }

      // Skip embeds (YouTube previews, images, etc.)
      // Embeds are usually in elements with parent having "message-accessories" or similar
      let current = el.parentElement;
      while (current && current !== document.body) {
        const classList = current.classList ? Array.from(current.classList).join(' ') : '';
        const className = current.className || '';

        // Check for embed-related classes
        if (classList.includes('embed') ||
          classList.includes('messageAccessories') ||
          classList.includes('container') && classList.includes('embedWrapper') ||
          className.includes('embed') ||
          current.id?.includes('message-accessories')) {
          logger.debug(`⏭️ Skipping embed element [${messageId}]`);
          return false;
        }
        current = current.parentElement;
      }

      // Skip if element is inside a reply/quote
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const classList = parent.classList ? Array.from(parent.classList).join(' ') : '';
        if (classList.includes('repliedMessage') ||
          classList.includes('repliedText') ||
          parent.id?.startsWith('message-reply-context')) {
          logger.debug(`⏭️ Skipping quoted/reply element [${messageId}]`);
          return false;
        }
        parent = parent.parentElement;
      }

      const hasContent = el.textContent.trim().length > 0;

      if (!hasContent) {
        noContentCount++;
        return false;
      }

      // IMPORTANT: Only translate visible messages for faster response
      const isVisible = this.isElementVisible(el);
      if (!isVisible) {
        notVisibleCount++;
        return false;
      }

      return true;
    }); // Process messages in order: OLDEST FIRST (top to bottom)

    logger.log(`📊 Message filtering: Total=${allMessages.length}, AlreadyProcessed=${alreadyInSetCount}, NoContent=${noContentCount}, NotVisible=${notVisibleCount}, ToProcess=${messageElements.length}`);
    logger.log(`🔄 Processing order: OLDEST FIRST (top to bottom)`);
    logger.log(`💾 Processed messages in Set: ${this.processedMessages.size}`);

    if (!messageElements.length) {
      logger.debug('No new messages found, will retry in next cycle');
      return;
    }

    logger.log(`Found ${messageElements.length} new messages to translate (all visible on screen)`);

    // Process ALL visible messages (no batch limit needed since we only process visible messages)
    const messagesToProcess = messageElements;

    const htmlPlaceholders = new Map();

    const extractTextParts = (element, elementIndex) => {
      // Clone element to safely remove quoted/reply content and embeds
      const clone = element.cloneNode(true);

      // Remove Discord reply/quote elements (citations)
      const quotesToRemove = clone.querySelectorAll(
        '[class*="repliedMessage"], ' +
        '[class*="repliedText"], ' +
        '[class*="blockquote"], ' +
        '[id^="message-reply-context"]'  // Remove reply context by ID
      );
      quotesToRemove.forEach(quote => quote.remove());

      // Remove embed elements (YouTube previews, images, etc.)
      const embedsToRemove = clone.querySelectorAll(
        '[class*="embed"], ' +
        '[class*="embedWrapper"], ' +
        '[class*="messageAccessories"], ' +
        '[id^="message-accessories"]'
      );
      embedsToRemove.forEach(embed => embed.remove());

      // Remove code blocks - we want to translate text around them, but not the code itself
      // First remove all <pre> elements (which contain the code blocks)
      const preElements = clone.querySelectorAll('pre');
      preElements.forEach(pre => {
        logger.debug('Removing <pre> element from message ' + elementIndex);
        pre.remove();
      });
      
      // Then remove any remaining <code> elements (inline code)
      const codeElements = clone.querySelectorAll('code');
      codeElements.forEach(code => {
        logger.debug('Removing <code> element from message ' + elementIndex);
        code.remove();
      });

      // Get text without quotes, embeds, and code blocks
      let text = clone.textContent.trim();

      if (text.length === 0) {
        logger.debug(`Message ${elementIndex}: Empty after removing quotes/embeds/code`);
        return [];
      }

      // Remove URLs from text (don't translate links)
      // Matches http://, https://, www. links, and discord.gg links
      const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+|discord\.gg\/[^\s]+/gi;
      const originalText = text;
      text = text.replace(urlRegex, '').trim();

      // If text was ONLY URLs, skip translation
      if (text.length === 0) {
        logger.debug(`Message ${elementIndex}: Only URLs, skipping translation`);
        return [];
      }

      // Skip if text is too short after removing URLs (probably just emoji or reaction)
      if (text.length < 3) {
        logger.debug(`Message ${elementIndex}: Text too short after URL removal (${text.length} chars): "${text}"`);
        return [];
      }

      // Log if URLs were removed
      if (originalText !== text) {
        logger.debug(`Message ${elementIndex}: Removed URLs, text: "${originalText.substring(0, 50)}..." -> "${text.substring(0, 50)}..."`);
      }

      return [text];
    };

    // Track which messageIds we've already seen in this batch
    const seenMessageIds = new Set();

    const textsToTranslate = messagesToProcess
      .map((element, index) => {
        const messageId = this.getMessageId(element);

        // Skip if we've already seen this messageId (multiple markup elements for same message)
        if (seenMessageIds.has(messageId)) {
          logger.debug(`⏭️ Skipping duplicate messageId: ${messageId}`);
          return null;
        }
        seenMessageIds.add(messageId);

        const parts = extractTextParts(element, index);
        const text = parts.join('');
        logger.debug(`Message ${index} [${messageId}]: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);

        // If text is in cache, display cached translation and mark as processed
        if (this.translationCache.has(text)) {
          const cachedTranslation = this.translationCache.get(text);
          logger.debug(`📦 Using cached translation for message ${index} [${messageId}]`);
          try {
            // Check if element still exists in DOM
            if (element && element.isConnected) {
              this.displayTranslation(element, cachedTranslation, index, messageId);
            } else {
              logger.debug(`⏭️ Cached element ${index} [${messageId}] no longer in DOM`);
              this.processedMessages.add(messageId);
            }
          } catch (displayError) {
            logger.error(`❌ Error displaying cached translation [${messageId}]:`, displayError);
            this.processedMessages.add(messageId);
          }
          return null; // Skip this item
        }

        return { element, text, index, messageId }; // Store element reference and ID
      })
      .filter(item => item !== null && item.text);

    logger.log('Texts to translate:', textsToTranslate.length, 'of', messageElements.length);

    // Show some sample texts
    if (textsToTranslate.length > 0) {
      logger.log('Sample texts to translate:', textsToTranslate.slice(0, 3).map(item => `"${item.text.substring(0, 50)}..."`));
    }

    if (textsToTranslate.length === 0) {
      logger.debug('All messages already cached, will check again in next cycle');
      return;
    }

    try {
      for (const { element, text, index, messageId } of textsToTranslate) {
        if (document.hidden || !this.isActive || this.context.isInvalid) break;
        const revision = this.stateRevision;
        const isCurrent = () => this.isActive && revision === this.stateRevision &&
          !this.context.isInvalid;
        try {
          if (!element?.isConnected) continue;
          const translatedText = await this.translateText(text, partial => {
            if (!isCurrent() || !partial?.trim() || !element.isConnected) return;
            if (this.messageTranslations.has(messageId)) {
              this.updateTranslation(messageId, partial);
            } else {
              this.displayTranslation(element, partial, index, messageId, false);
            }
          });
          if (!isCurrent()) break;
          this.cacheTranslation(text, translatedText);
          if (this.messageTranslations.has(messageId)) {
            this.updateTranslation(messageId, translatedText, true);
          } else if (element.isConnected) {
            this.displayTranslation(element, translatedText, index, messageId);
          }
        } catch (error) {
          if (!isCurrent()) break;
          const state = this.messageTranslations.get(messageId);
          if (state && !state.complete) {
            this.restoreTranslation(state);
            this.messageTranslations.delete(messageId);
            this.processedMessages.delete(messageId);
            element?.removeAttribute(this.PROCESSED_ATTRIBUTE);
          }
          // An error is not a translation; the next cycle may retry the request.
          logger.error(`Translation of message [${messageId}] failed:`, error);
          break;
        }
        await delay(CONFIG.API_DELAY_MS);
      }

      logger.log('💾 Cache now contains:', this.translationCache.size, 'translations');
      logger.log('✅ All translations displayed immediately after each API call');


    } catch (error) {
      logger.error('Translation error:', error);
      logger.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
    }

    // Send stats to background after processing
    await this.sendStats();
  }

  /**
   * Display a single translation immediately after it's translated
   */
  displayTranslation(messageElement, translatedText, index, messageId, complete = true) {
    if (!messageElement?.isConnected || !translatedText?.trim()) return;
    if (this.processedMessages.has(messageId)) return;

    try {
      let flagIcon = messageElement.parentElement.querySelector(
        `.${this.FLAG_ICON_CLASS}[data-message-id="${messageId}"]`
      );
      if (!flagIcon) {
        flagIcon = this.createFlagIcon(messageElement, messageId)?.firstElementChild;
      }
      if (!flagIcon) throw new Error('Could not create the translation toggle icon.');
      this.displaySingleTranslation(messageElement, translatedText, messageId, flagIcon, complete);
      this.processedMessages.add(messageId);
      messageElement.setAttribute(this.PROCESSED_ATTRIBUTE, '1');
    } catch (error) {
      logger.error(`Could not display the translation of message [${messageId}]:`, error);
    }
  }

}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

(async function main() {
  const hosts = new Set(['discord.com', 'canary.discord.com', 'ptb.discord.com']);
  if (!hosts.has(location.hostname) || !['http:', 'https:'].includes(location.protocol) ||
      window.self !== window.top) return;
  try {
    logger.log('Initializing Discord Translator...');

    if (!getExtensionContextId()) {
      logger.error('WebExtension runtime not available - this script requires WebExtension context');
      return;
    }

    logger.log('WebExtension runtime available, creating context...');

    const context = new ContentScriptContext('discord-translator');
    const translator = new DiscordTranslator(context);

    // Make translator globally accessible for manual testing
    window.discordTranslator = translator;
    logger.log('Translator assigned to window.discordTranslator');

    await translator.start();

  } catch (error) {
    logger.error('Content script crashed on startup:', error);
    logger.error('Startup error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    // Don't throw - we want to see the error but not crash completely
  }
})();
