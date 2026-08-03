(function(root) {
  const AUTH_CACHE_CRYPTO_VERSION = 1;
  const AUTH_CACHE_CRYPTO_ALGORITHM = 'AES-GCM';
  const AUTH_CACHE_KEY_STORAGE_NAME = 'authHeadersCacheCryptoKey';
  let authCacheCryptoKeyPromise = null;

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function getStoredRawAuthCacheKey() {
    if (!chrome.storage?.session) return null;
    const data = await chrome.storage.session.get(AUTH_CACHE_KEY_STORAGE_NAME);
    const rawKey = data?.[AUTH_CACHE_KEY_STORAGE_NAME];
    return typeof rawKey === 'string' && rawKey ? rawKey : null;
  }

  async function storeRawAuthCacheKey(rawKey) {
    if (!chrome.storage?.session) return;
    await chrome.storage.session.set({ [AUTH_CACHE_KEY_STORAGE_NAME]: rawKey });
  }

  async function getAuthCacheCryptoKey() {
    if (!root.crypto?.subtle) return null;
    if (!authCacheCryptoKeyPromise) {
      authCacheCryptoKeyPromise = (async () => {
        const storedRawKey = await getStoredRawAuthCacheKey();
        if (storedRawKey) {
          return root.crypto.subtle.importKey(
            'raw',
            base64ToBytes(storedRawKey),
            { name: AUTH_CACHE_CRYPTO_ALGORITHM },
            false,
            ['encrypt', 'decrypt']
          );
        }

        const key = await root.crypto.subtle.generateKey(
          { name: AUTH_CACHE_CRYPTO_ALGORITHM, length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        const rawKey = new Uint8Array(await root.crypto.subtle.exportKey('raw', key));
        await storeRawAuthCacheKey(bytesToBase64(rawKey));
        return key;
      })();
    }
    return authCacheCryptoKeyPromise;
  }

  async function encryptAuthHeadersForCache(headers) {
    const key = await getAuthCacheCryptoKey();
    if (!key) {
      return null;
    }

    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(headers || {}));
    const ciphertext = new Uint8Array(await root.crypto.subtle.encrypt(
      { name: AUTH_CACHE_CRYPTO_ALGORITHM, iv },
      key,
      plaintext
    ));

    return {
      encrypted: true,
      version: AUTH_CACHE_CRYPTO_VERSION,
      algorithm: AUTH_CACHE_CRYPTO_ALGORITHM,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  async function decryptAuthHeadersFromCache(entry) {
    if (!entry) return null;
    if (entry.encrypted !== true) {
      // 兼容旧版本明文缓存；调用方读取后会重新写成密文。
      return entry.headers || null;
    }

    const key = await getAuthCacheCryptoKey();
    if (!key || entry.algorithm !== AUTH_CACHE_CRYPTO_ALGORITHM || !entry.iv || !entry.ciphertext) {
      return null;
    }

    try {
      const plaintext = await root.crypto.subtle.decrypt(
        { name: AUTH_CACHE_CRYPTO_ALGORITHM, iv: base64ToBytes(entry.iv) },
        key,
        base64ToBytes(entry.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (e) {
      console.warn('认证缓存解密失败，忽略旧缓存:', e);
      return null;
    }
  }

  root.encryptAuthHeadersForCache = encryptAuthHeadersForCache;
  root.decryptAuthHeadersFromCache = decryptAuthHeadersFromCache;
})(typeof self !== 'undefined' ? self : globalThis);
