// ==UserScript==
// @name         X Split Reader (Local Dev Example)
// @namespace    https://github.com/epodak/x-split-reader
// @version      0.3.4
// @description  Local development loader template for X Split Reader via Tampermonkey file:// protocol.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @connect      api.fxtwitter.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @require      file:///YOUR_LOCAL_PATH/x-split-reader/x-split-reader.user.js
// ==/UserScript==

// 使用说明：
// 1. 复制本文件为 local-dev.user.js（已被 git 忽略，不会误提交机器路径）
// 2. 将第 12 行的 @require 路径修改为本机绝对路径，例如：
//    Windows: file://D:/_AI/10_DOING/x-split-reader/x-split-reader.user.js
//    macOS/Linux: file:///Users/username/x-split-reader/x-split-reader.user.js
// 3. 在 Chrome/Edge 扩展管理中为 Tampermonkey 勾选「允许访问文件网址」
// 4. 将 local-dev.user.js 的内容新建并保存为一个油猴脚本
// 5. 修改 x-split-reader.user.js 后直接在推特页面按 F5 即可即时生效，无需重复复制粘贴
