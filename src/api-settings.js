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
