// ==UserScript==
// @name         X Split Reader (Dev Loader)
// @namespace    https://github.com/epodak/x-split-reader
// @version      0.0.1-dev
// @description  Local development loader for X Split Reader. Fetches the latest code from local dev-server on each reload.
// @author       Feng Lu
// @match        https://x.com/*
// @match        https://twitter.com/*
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.fxtwitter.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const DEV_SERVER_URL = 'http://127.0.0.1:8765/x-split-reader.user.js';

  console.log('[X Split Reader Dev] Loading live script from local server…');

  GM_xmlhttpRequest({
    method: 'GET',
    url: `${DEV_SERVER_URL}?_t=${Date.now()}`,
    onload: function (response) {
      if (response.status === 200) {
        try {
          // 执行本地最新的完整脚本代码
          new Function('GM_xmlhttpRequest', 'GM_addStyle', 'GM_registerMenuCommand', response.responseText)(
            GM_xmlhttpRequest,
            GM_addStyle,
            GM_registerMenuCommand
          );
          console.log('[X Split Reader Dev] ✅ Live script loaded successfully!');
        } catch (err) {
          console.error('[X Split Reader Dev] ❌ Error executing script:', err);
        }
      } else {
        console.warn(`[X Split Reader Dev] Failed to fetch script (status ${response.status}). Is \`pnpm dev\` running?`);
      }
    },
    onerror: function (err) {
      console.warn('[X Split Reader Dev] Could not connect to dev server at http://127.0.0.1:8765. Run `pnpm dev` in terminal.', err);
    }
  });
})();
