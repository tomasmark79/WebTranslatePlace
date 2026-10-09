// Copyright (C) 2026 Tomáš Mark
// SPDX-License-Identifier: GPL-3.0-or-later

// Register at every persistent background startup, including application restart.
const mailApi = globalThis.browser ?? globalThis.messenger;
Promise.all([
  mailApi.composeScripts.register({
    js: [{ file: 'thunderbird-compose.js' }, { file: 'selection.js' }]
  }),
  mailApi.messageDisplayScripts.register({
    js: [{ file: 'thunderbird-message.js' }, { file: 'selection.js' }]
  })
]).catch(error => console.error('[WebTranslatePlace] Failed to register email scripts:', error));
