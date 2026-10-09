// Copyright (C) 2026 Tomáš Mark
// SPDX-License-Identifier: GPL-3.0-or-later

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
