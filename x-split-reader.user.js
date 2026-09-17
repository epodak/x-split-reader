// ==UserScript==
// @name         X Split Reader
// @namespace    https://github.com/epodak/x-split-reader
// @version      0.3.3
// @description  Compact split reader for X: fixed-width timeline plus adaptive post/replies pane.
// @author       Feng Lu
// @license      MIT
// @match        https://x.com/*
// @match        https://twitter.com/*
// @connect      api.fxtwitter.com
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @homepageURL  https://github.com/epodak/x-split-reader
// @supportURL   https://github.com/epodak/x-split-reader/issues
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = Object.freeze({
    readingLineRatio: 0.35,
    switchDebounceMs: 150,
    switchAdvantagePx: 48,
    forwardPrefetch: 2,
    backwardPrefetch: 1,
    fetchConcurrency: 2,
    cacheMaxEntries: 25,
    cacheTtlMs: 10 * 60 * 1000,
    navWidthPx: 68,
    timelineWidthPx: 680,
    minTimelineWidthPx: 480,
    maxTimelineWidthPx: 1400,
    wideDetailThresholdPx: 780,
    apiTimeoutMs: 8000,
    scanIntervalMs: 120,
    hoverLookahead: true,
    hoverDebounceMs: 110
  });

  const STORAGE = Object.freeze({
    enabled: 'xsr.enabled',
    timelineWidth: 'xsr.timelineWidth',
    mode: 'xsr.mode',
    showPost: 'xsr.showPost',
    hoverLookahead: 'xsr.hoverLookahead'
  });

  const getRealWindowWidth = (() => {
    if (typeof window === 'undefined') return () => 1920;
    try {
      const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth')
        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerWidth');
      if (desc && desc.get) {
        const getter = desc.get;
        return () => {
          try { return getter.call(window); } catch (_) { return window.outerWidth || 1920; }
        };
      }
    } catch (_) {}
    return () => window.outerWidth || window.innerWidth || 1920;
  })();

  function installCompactViewportSpoof() {
    if (typeof window === 'undefined') return;
    const SPOOFED_COMPACT_WIDTH = 1180;
    let spoofActive = true;

    function applySpoof() {
      const real = getRealWindowWidth();
      const target = (spoofActive && real >= 1280) ? SPOOFED_COMPACT_WIDTH : real;
      if (window.innerWidth === target && document.documentElement?.clientWidth === target) return;

      try {
        window.__defineGetter__('innerWidth', () => target);
        if (document.documentElement) {
          document.documentElement.__defineGetter__('clientWidth', () => target);
        }
        if (window.visualViewport) {
          window.visualViewport.__defineGetter__('width', () => target);
        }
        window.dispatchEvent(new Event('resize'));
        if (window.visualViewport) {
          window.visualViewport.dispatchEvent(new Event('resize'));
        }
      } catch (_) {}
    }

    function checkMediaModal() {
      const isModal = /\/status\/\d+\/(photo|video)\/\d+/.test(location.pathname);
      spoofActive = !isModal;
      applySpoof();
    }

    try {
      applySpoof();
      window.addEventListener('load', applySpoof, { passive: true });
      window.addEventListener('resize', applySpoof, { passive: true });
      document.addEventListener('visibilitychange', applySpoof, { passive: true });
      window.addEventListener('popstate', checkMediaModal, { passive: true });

      const origPushState = history.pushState;
      if (typeof origPushState === 'function') {
        history.pushState = function (...args) {
          origPushState.apply(this, args);
          checkMediaModal();
        };
      }
      const origReplaceState = history.replaceState;
      if (typeof origReplaceState === 'function') {
        history.replaceState = function (...args) {
          origReplaceState.apply(this, args);
          checkMediaModal();
        };
      }
    } catch (_) {}
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function extractTweetIdFromHref(href) {
    if (!href) return null;
    const match = String(href).match(/\/(?:i\/web\/)?status\/(\d+)/);
    return match ? match[1] : null;
  }

  function formatMetric(value) {
    const num = Number(value) || 0;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return num ? String(num) : '0';
  }

  function formatTweetDate(dateStr) {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) return '';
      const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
      if (diffSec < 60) return 'just now';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `${diffMin}m`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return `${diffHour}h`;
      const diffDay = Math.floor(diffHour / 24);
      if (diffDay < 30) return `${diffDay}d`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function sanitizeUrl(value, fallback = '#') {
    try {
      const url = new URL(value, 'https://x.com');
      return ['https:', 'http:'].includes(url.protocol) ? url.href : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function chooseActiveCandidate(items, readingY) {
    if (!items || !items.length) return null;
    let winner = null;
    let bestDistance = Infinity;
    for (const item of items) {
      const { top, bottom } = item.rect;
      if (bottom <= 0 || top >= item.viewportHeight) continue;
      const containsLine = top <= readingY && bottom >= readingY;
      const distance = containsLine ? 0 : Math.min(Math.abs(top - readingY), Math.abs(bottom - readingY));
      if (distance < bestDistance) {
        bestDistance = distance;
        winner = { ...item, distance };
      }
    }
    return winner || items.find((item) => item.rect.bottom > 0 && item.rect.top < item.viewportHeight) || items[0] || null;
  }

  function mediaFromFx(status) {
    if (!status || !status.media) return [];
    const all = Array.isArray(status.media.all)
      ? status.media.all
      : [
          ...(Array.isArray(status.media.photos) ? status.media.photos : []),
          ...(Array.isArray(status.media.videos) ? status.media.videos : [])
        ];
    return all.slice(0, 4).map((item) => ({
      type: item.type || 'photo',
      url: sanitizeUrl(item.url || item.thumbnail_url, ''),
      thumbnailUrl: sanitizeUrl(item.thumbnail_url || item.url, ''),
      alt: item.altText || '',
      width: Number(item.width || 0),
      height: Number(item.height || 0)
    })).filter((item) => item.url || item.thumbnailUrl);
  }

  function normalizeFxStatus(status) {
    if (!status || status.type === 'tombstone') return null;
    const author = status.author || {};
    return {
      id: String(status.id || ''),
      url: sanitizeUrl(status.url || `https://x.com/${author.screen_name || 'i'}/status/${status.id}`),
      author: {
        name: author.name || author.screen_name || 'Unknown',
        handle: author.screen_name ? `@${author.screen_name}` : '',
        avatar: sanitizeUrl(author.avatar_url, ''),
        verified: Boolean(author.verification && author.verification.verified)
      },
      text: status.text || (status.raw_text && status.raw_text.text) || '',
      createdAt: status.created_at || '',
      media: mediaFromFx(status),
      metrics: {
        replies: Number(status.replies || 0),
        reposts: Number(status.reposts || 0),
        likes: Number(status.likes || 0),
        views: Number(status.views || 0),
        bookmarks: Number(status.bookmarks || 0)
      },
      replyingTo: status.replying_to || null,
      source: 'fxtwitter'
    };
  }

  function normalizeFxConversation(payload, requestedId) {
    if (!payload || Number(payload.code) !== 200) {
      throw new Error(payload && payload.message ? payload.message : 'Conversation API returned no data');
    }
    const focal = normalizeFxStatus(payload.status);
    if (!focal || focal.id !== String(requestedId)) throw new Error('Conversation API returned a mismatched post');
    return {
      id: focal.id,
      status: focal,
      thread: (payload.thread || []).map(normalizeFxStatus).filter(Boolean),
      replies: (payload.replies || []).map(normalizeFxStatus).filter(Boolean),
      nextCursor: payload.cursor && payload.cursor.bottom ? payload.cursor.bottom : null,
      fetchedAt: Date.now(),
      source: 'fxtwitter'
    };
  }

  class TweetCache {
    constructor({ maxEntries = 25, ttlMs = 600_000 } = {}) {
      this.maxEntries = maxEntries;
      this.ttlMs = ttlMs;
      this.data = new Map();
      this.inflight = new Map();
    }
    peek(id) {
      const key = String(id);
      const entry = this.data.get(key);
      if (!entry) return null;
      if (Date.now() - entry.savedAt > this.ttlMs) {
        this.data.delete(key);
        return null;
      }
      this.data.delete(key);
      this.data.set(key, entry);
      return entry.value;
    }
    set(id, value) {
      const key = String(id);
      this.data.delete(key);
      this.data.set(key, { value, savedAt: Date.now() });
      while (this.data.size > this.maxEntries) this.data.delete(this.data.keys().next().value);
      return value;
    }
    async get(id, loader) {
      const key = String(id);
      const cached = this.peek(key);
      if (cached) return cached;
      if (this.inflight.has(key)) return this.inflight.get(key);
      const promise = Promise.resolve().then(() => loader(key)).then((value) => this.set(key, value)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise);
      return promise;
    }
  }

  class RequestQueue {
    constructor(limit = 2) {
      this.limit = limit;
      this.active = 0;
      this.pending = [];
      this.keys = new Set();
    }
    add(key, priority, task) {
      const uniqueKey = String(key);
      if (this.keys.has(uniqueKey)) return;
      this.keys.add(uniqueKey);
      this.pending.push({ key: uniqueKey, priority, task });
      this.pending.sort((a, b) => a.priority - b.priority);
      this.drain();
    }
    drain() {
      while (this.active < this.limit && this.pending.length) {
        const item = this.pending.shift();
        this.active += 1;
        Promise.resolve().then(item.task).catch(() => {}).finally(() => {
          this.active -= 1;
          this.keys.delete(item.key);
          this.drain();
        });
      }
    }
  }

  function requestJson(url, timeoutMs = CONFIG.apiTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest is unavailable'));
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: timeoutMs, headers: { Accept: 'application/json' },
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) return reject(new Error(`Conversation API HTTP ${response.status}`));
          try { resolve(JSON.parse(response.responseText)); } catch (_error) { reject(new Error('Conversation API returned invalid JSON')); }
        },
        onerror: () => reject(new Error('Conversation API network error')),
        ontimeout: () => reject(new Error('Conversation API timed out'))
      });
    });
  }

  class FxTwitterProvider {
    async fetch(id, cursor = null) {
      const query = new URLSearchParams({ ranking_mode: 'likes' });
      if (cursor) query.set('cursor', cursor);
      const payload = await requestJson(`https://api.fxtwitter.com/2/conversation/${encodeURIComponent(id)}?${query}`);
      return normalizeFxConversation(payload, id);
    }
  }

  function extractDomTweet(article) {
    const permalink = article.querySelector('a[href*="/status/"] time')?.closest('a')
      || [...article.querySelectorAll('a[href*="/status/"]')].find((link) => extractTweetIdFromHref(link.getAttribute('href')));
    const id = extractTweetIdFromHref(permalink && permalink.getAttribute('href'));
    if (!id) return null;
    const userName = article.querySelector('[data-testid="User-Name"]');
    const userText = userName ? userName.innerText.split('\n').filter(Boolean) : [];
    const handle = userText.find((part) => part.startsWith('@')) || '';
    const name = userText.find((part) => !part.startsWith('@') && !/^·$/.test(part)) || handle || 'Unknown';
    const avatar = [...article.querySelectorAll('img')].map((image) => image.currentSrc || image.src).find((src) => /profile_images|pbs\.twimg\.com\/profile/.test(src || '')) || '';
    const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].slice(0, 4).map((image) => ({
      type: 'photo', url: sanitizeUrl(image.currentSrc || image.src, ''), thumbnailUrl: sanitizeUrl(image.currentSrc || image.src, ''), alt: image.alt || ''
    }));
    if (!media.length) {
      const video = article.querySelector('video');
      if (video && video.poster) media.push({ type: 'video', url: '', thumbnailUrl: sanitizeUrl(video.poster, ''), alt: '' });
    }
    return {
      id,
      url: sanitizeUrl(permalink.href),
      author: { name, handle, avatar, verified: Boolean(userName?.querySelector('svg[data-testid="icon-verified"]')) },
      text: article.querySelector('[data-testid="tweetText"]')?.innerText || '',
      createdAt: article.querySelector('time')?.getAttribute('datetime') || '',
      media,
      metrics: { replies: 0, reposts: 0, likes: 0, views: 0, bookmarks: 0 },
      source: 'dom'
    };
  }

  class TimelineScanner {
    scan() {
      const viewportHeight = window.innerHeight;
      return [...document.querySelectorAll('article[data-testid="tweet"]')].map((article) => {
        const tweet = extractDomTweet(article);
        if (!tweet) return null;
        const rect = article.getBoundingClientRect();
        return { id: tweet.id, article, tweet, rect: { top: rect.top, bottom: rect.bottom, height: rect.height }, viewportHeight };
      }).filter(Boolean);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function compactTweetTextNode(root) {
    if (!root) return;
    if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return;
    if (root.dataset && root.dataset.xsrParagraphs === 'true') return;

    const filter = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
    const walker = document.createTreeWalker(root, filter);
    const nodes = [];
    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    let modified = false;
    for (const node of nodes) {
      const val = node && node.nodeValue;
      if (!val || !/\n[\s\u200b\u200c\u200d\uFEFF]*\n+/.test(val)) continue;

      const parent = node.parentNode;
      if (!parent) continue;

      const parts = val.split(/\n[\s\u200b\u200c\u200d\uFEFF]*\n+/);
      const frag = document.createDocumentFragment();
      let hasPrecedingContent = false;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (hasPrecedingContent) {
          const spacer = document.createElement('span');
          spacer.className = 'xsr-para-gap';
          frag.appendChild(spacer);
        }

        frag.appendChild(document.createTextNode(part));
        hasPrecedingContent = true;
      }

      if (hasPrecedingContent) {
        parent.replaceChild(frag, node);
        modified = true;
      }
    }

    if (modified && root.dataset) {
      root.dataset.xsrParagraphs = 'true';
    }
  }

  function splitParagraphs(rawText) {
    if (!rawText) return [];
    return rawText
      .split(/\n[\s\u200b\u200c\u200d\uFEFF]*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  function renderStructuredText(rawText) {
    const container = element('div', 'xsr-text');
    if (!rawText) return container;
    const paragraphs = splitParagraphs(rawText);
    if (paragraphs.length <= 1) {
      container.textContent = rawText;
      return container;
    }
    paragraphs.forEach((para) => {
      container.appendChild(element('p', 'xsr-para', para));
    });
    return container;
  }

  class DetailRenderer {
    constructor(onModeToggle, onLoadMore, onTimelineWidthChange, onTogglePost, showPost = false) {
      this.onModeToggle = onModeToggle;
      this.onLoadMore = onLoadMore;
      this.onTimelineWidthChange = onTimelineWidthChange;
      this.onTogglePost = onTogglePost;
      this.showPost = showPost;
      this.currentId = null;
      this.currentConversation = null;
      this.root = this.createRoot();
      this.body = this.root.querySelector('.xsr-body');
      this.modeButton = this.root.querySelector('.xsr-mode');
      this.postButton = this.root.querySelector('.xsr-post-btn');
      this.openLink = this.root.querySelector('.xsr-open');
      this.status = this.root.querySelector('.xsr-status');
    }

    createRoot() {
      const root = element('aside', 'xsr-pane');
      root.id = 'xsr-pane';
      root.setAttribute('aria-label', 'X Split Reader post detail');
      const divider = element('div', 'xsr-divider');
      divider.setAttribute('aria-label', 'Resize timeline column');
      divider.setAttribute('role', 'separator');
      root.appendChild(divider);
      const toolbar = element('header', 'xsr-toolbar');
      const title = element('strong', 'xsr-title', 'Comments');
      const status = element('span', 'xsr-status', 'Waiting for timeline…');
      const spacer = element('span', 'xsr-spacer');
      const postBtn = element('button', `xsr-post-btn${this.showPost ? ' is-active' : ''}`, this.showPost ? 'Hide post' : 'Show post');
      postBtn.type = 'button';
      postBtn.addEventListener('click', () => this.onTogglePost());
      const mode = element('button', 'xsr-mode', 'FOLLOW');
      mode.type = 'button';
      mode.addEventListener('click', () => this.onModeToggle());
      const open = element('a', 'xsr-open', 'Open in X ↗');
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.hidden = true;
      toolbar.append(title, status, spacer, postBtn, mode, open);
      const body = element('div', 'xsr-body');
      const empty = element('div', 'xsr-empty');
      empty.append(element('div', 'xsr-empty-icon', '💬'), element('h2', '', 'Scroll the timeline'), element('p', '', 'The comments crossing the reading line will appear here.'));
      body.appendChild(empty);
      root.append(toolbar, body);
      document.documentElement.appendChild(root);
      this.bindResize(divider);
      return root;
    }

    bindResize(divider) {
      divider.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        document.documentElement.classList.add('xsr-resizing');
      });
      divider.addEventListener('pointermove', (event) => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const maxAvailable = Math.max(CONFIG.minTimelineWidthPx + 100, getRealWindowWidth() - CONFIG.navWidthPx - 340);
        const maxLimit = Math.min(CONFIG.maxTimelineWidthPx, maxAvailable);
        const width = clamp(event.clientX - CONFIG.navWidthPx, CONFIG.minTimelineWidthPx, maxLimit);
        this.onTimelineWidthChange(width, true);
      });
      const finish = (event) => {
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        document.documentElement.classList.remove('xsr-resizing');
      };
      divider.addEventListener('pointerup', finish);
      divider.addEventListener('pointercancel', finish);
      divider.addEventListener('dblclick', () => this.onTimelineWidthChange(CONFIG.timelineWidthPx, false));
    }

    setMode(mode) {
      this.modeButton.textContent = mode;
      this.modeButton.classList.toggle('is-pinned', mode === 'PINNED');
      this.modeButton.title = mode === 'PINNED' ? 'Click or press Esc to resume auto-follow' : 'Click to pin current post';
    }

    setShowPost(showPost) {
      this.showPost = Boolean(showPost);
      if (this.postButton) {
        this.postButton.textContent = this.showPost ? 'Hide post' : 'Show post';
        this.postButton.classList.toggle('is-active', this.showPost);
      }
      if (this.currentConversation) {
        this.renderConversation(this.currentConversation);
      }
    }

    renderMiniAnchor(tweet, threadCount = 0) {
      const anchor = element('div', 'xsr-mini-anchor');
      const avatar = element('img', 'xsr-mini-avatar');
      avatar.src = tweet.author?.avatar || tweet.authorAvatar || '';
      avatar.alt = '';
      const info = element('div', 'xsr-mini-info');
      const name = tweet.author?.name || tweet.authorName || 'Post';
      const handle = tweet.author?.handle || tweet.authorHandle || '';
      info.textContent = `${name} (${handle})`;
      const action = element('button', 'xsr-mini-action', threadCount > 1 ? `View thread (${threadCount})` : 'Show post');
      action.type = 'button';
      action.addEventListener('click', () => this.onTogglePost());
      anchor.append(avatar, info, action);
      return anchor;
    }

    setLoading(tweet) {
      this.currentId = tweet.id;
      this.currentConversation = null;
      this.status.textContent = 'Loading replies…';
      this.openLink.href = tweet.url;
      this.openLink.hidden = false;
      const shell = this.makeGrid(this.showPost);
      if (this.showPost) {
        shell.focus?.appendChild(this.renderTweet(tweet, true));
      } else {
        shell.replies.appendChild(this.renderMiniAnchor(tweet));
      }
      shell.replies.appendChild(this.renderSkeleton());
      this.body.replaceChildren(shell.grid);
      this.body.scrollTop = 0;
    }

    makeGrid(hasThread = false) {
      const grid = element('div', `xsr-detail-grid${hasThread ? ' is-thread-layout' : ' is-comment-layout'}`);
      const focus = hasThread ? element('div', 'xsr-focus-column') : null;
      const replies = element('div', 'xsr-reply-column');
      if (focus) grid.appendChild(focus);
      grid.appendChild(replies);
      return { grid, focus, replies };
    }

    renderConversation(conversation) {
      if (conversation.id !== this.currentId) return;
      this.currentConversation = conversation;
      const hasThread = Boolean(conversation.thread && conversation.thread.length > 1);
      if (this.postButton) {
        if (hasThread && !this.showPost) {
          this.postButton.textContent = `Show thread (${conversation.thread.length})`;
          this.postButton.classList.add('has-thread-hint');
        } else {
          this.postButton.textContent = this.showPost ? 'Hide post' : 'Show post';
          this.postButton.classList.remove('has-thread-hint');
        }
      }
      this.status.textContent = conversation.replies.length ? `${conversation.replies.length} replies` : 'No replies';

      const showFocus = this.showPost;
      const shell = this.makeGrid(showFocus);

      if (showFocus) {
        shell.focus.appendChild(this.renderTweet(conversation.status, true));
        if (hasThread) {
          const thread = element('section', 'xsr-section');
          thread.appendChild(element('h3', 'xsr-section-title', 'Thread'));
          conversation.thread.filter((tweet) => tweet.id !== conversation.id).forEach((tweet) => thread.appendChild(this.renderTweet(tweet, false)));
          shell.focus.appendChild(thread);
        }
      } else {
        shell.replies.appendChild(this.renderMiniAnchor(conversation.status, hasThread ? conversation.thread.length : 0));
      }

      const replies = element('section', 'xsr-section xsr-replies');
      if (!conversation.replies.length) {
        replies.appendChild(element('p', 'xsr-muted xsr-no-replies', 'No replies to this post.'));
      } else {
        conversation.replies.forEach((reply) => replies.appendChild(this.renderTweet(reply, false)));
      }
      if (conversation.nextCursor) {
        const more = element('button', 'xsr-load-more', 'Load more replies');
        more.type = 'button';
        more.addEventListener('click', async () => {
          more.disabled = true;
          more.textContent = 'Loading…';
          try { await this.onLoadMore(conversation.id, conversation.nextCursor); }
          catch (_error) { more.disabled = false; more.textContent = 'Retry loading replies'; }
        });
        replies.appendChild(more);
      }
      shell.replies.appendChild(replies);
      this.body.replaceChildren(shell.grid);
    }

    appendReplies(conversation) {
      if (conversation.id === this.currentId) this.renderConversation(conversation);
    }

    renderError(tweet, error) {
      if (tweet.id !== this.currentId) return;
      this.status.textContent = 'Replies unavailable';
      const shell = this.makeGrid(this.showPost);
      if (this.showPost) {
        shell.focus?.appendChild(this.renderTweet(tweet, true));
      }
      const notice = element('div', 'xsr-error');
      notice.append(element('strong', '', 'Could not load replies'), element('p', '', error && error.message ? error.message : 'Unknown provider error'), element('p', 'xsr-muted', 'The timeline post remains available. Use “Open in X” for the native conversation.'));
      shell.replies.appendChild(notice);
      this.body.replaceChildren(shell.grid);
    }

    renderTweet(tweet, prominent) {
      const article = element('article', `xsr-tweet${prominent ? ' is-prominent' : ''}`);
      article.dataset.tweetId = tweet.id;
      const header = element('div', 'xsr-tweet-header');
      const avatar = element('img', 'xsr-avatar');
      avatar.src = tweet.author.avatar || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="%23cfd9de"/></svg>';
      avatar.alt = '';
      avatar.loading = 'lazy';
      const identity = element('div', 'xsr-identity');
      const name = element('strong', 'xsr-name', tweet.author.name);
      if (tweet.author.verified) name.append(' ✓');
      const handle = element('span', 'xsr-handle', tweet.author.handle);
      const dot = element('span', 'xsr-sep', '·');
      const date = element('time', 'xsr-date', formatTweetDate(tweet.createdAt));
      if (tweet.createdAt) date.title = new Date(tweet.createdAt).toLocaleString();
      identity.append(name, handle, dot, date);
      header.append(avatar, identity);
      article.append(header, renderStructuredText(tweet.text || ''));
      if (tweet.media && tweet.media.length) {
        const media = element('div', `xsr-media count-${tweet.media.length}`);
        tweet.media.forEach((item) => {
          const image = element('img', '');
          image.src = item.thumbnailUrl || item.url;
          image.alt = item.alt || '';
          image.loading = prominent ? 'eager' : 'lazy';
          media.appendChild(image);
        });
        article.appendChild(media);
      }
      const metrics = element('div', 'xsr-metrics');
      const values = tweet.metrics || {};
      metrics.append(element('span', '', `↩ ${formatMetric(values.replies)}`), element('span', '', `↻ ${formatMetric(values.reposts)}`), element('span', '', `♡ ${formatMetric(values.likes)}`), element('span', '', `◫ ${formatMetric(values.views)}`));
      article.appendChild(metrics);
      article.addEventListener('click', () => window.open(tweet.url, '_blank', 'noopener'));
      return article;
    }

    renderSkeleton() {
      const skeleton = element('div', 'xsr-skeleton');
      skeleton.append(element('div', 'xsr-skeleton-line wide'), element('div', 'xsr-skeleton-line'), element('div', 'xsr-skeleton-line short'), element('div', 'xsr-skeleton-line wide'));
      return skeleton;
    }
  }

  class XSplitReader {
    constructor() {
      this.enabled = localStorage.getItem(STORAGE.enabled) !== 'false';
      this.mode = localStorage.getItem(STORAGE.mode) === 'PINNED' ? 'PINNED' : 'FOLLOW';
      this.showPost = localStorage.getItem(STORAGE.showPost) === 'true';
      this.hoverLookahead = localStorage.getItem(STORAGE.hoverLookahead) !== 'false';
      this.activeId = null;
      this.activeDistance = Infinity;
      this.scrollTriggeredArticle = null;
      this.scrollTriggeredId = null;
      this.hoverTimer = null;
      this.hoverTimerArticle = null;
      this.candidate = null;
      this.candidateSince = 0;
      this.lastScanAt = 0;
      this.raf = null;
      this.scanner = new TimelineScanner();
      this.provider = new FxTwitterProvider();
      this.cache = new TweetCache({ maxEntries: CONFIG.cacheMaxEntries, ttlMs: CONFIG.cacheTtlMs });
      this.queue = new RequestQueue(CONFIG.fetchConcurrency);
      this.renderer = null;
      this.requestVersion = 0;
      this.lastItems = [];
      this.onScroll = this.onScroll.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
    }

    start() {
      installStyles();
      this.applyStoredTimelineWidth();
      this.applyEnabled();
      window.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
      document.addEventListener('keydown', this.onKeyDown, true);
      document.addEventListener('click', this.onClick, true);
      document.addEventListener('pointermove', this.onPointerMove, { passive: true });
      this.initObserver();
      this.onScroll();
      [100, 300, 700, 1500, 3000].forEach((delay) => {
        setTimeout(() => {
          this.compactNativeTweets();
          if (this.enabled && !this.activeId) this.evaluate(true);
        }, delay);
      });
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Toggle X Split Reader', () => this.setEnabled(!this.enabled));
        GM_registerMenuCommand('Resume auto-follow', () => this.setMode('FOLLOW'));
        GM_registerMenuCommand('Reset timeline width', () => this.setTimelineWidth(CONFIG.timelineWidthPx, false));
        GM_registerMenuCommand('Toggle show original post', () => this.toggleShowPost());
        GM_registerMenuCommand('Toggle downward hover lookahead', () => {
          this.hoverLookahead = !this.hoverLookahead;
          localStorage.setItem(STORAGE.hoverLookahead, String(this.hoverLookahead));
        });
      }
    }

    initObserver() {
      if (this.observer) return;
      let timer = null;
      this.observer = new MutationObserver(() => {
        if (!this.enabled || timer) return;
        timer = setTimeout(() => {
          timer = null;
          this.compactNativeTweets();
          if (!this.activeId || this.mode === 'FOLLOW') this.evaluate(false);
        }, 150);
      });
      const target = document.body || document.documentElement;
      if (target) this.observer.observe(target, { childList: true, subtree: true });
    }

    compactNativeTweets() {
      if (!this.enabled) return;
      const elements = document.querySelectorAll('[data-testid="tweetText"]');
      elements.forEach((el) => {
        if (el.closest('#xsr-pane')) return;
        compactTweetTextNode(el);
      });
    }

    toggleShowPost() {
      this.showPost = !this.showPost;
      localStorage.setItem(STORAGE.showPost, String(this.showPost));
      this.renderer?.setShowPost(this.showPost);
    }

    ensureRenderer() {
      if (!this.renderer && document.documentElement) {
        this.renderer = new DetailRenderer(
          () => this.setMode(this.mode === 'FOLLOW' ? 'PINNED' : 'FOLLOW'),
          (id, cursor) => this.loadMore(id, cursor),
          (width, persist) => this.setTimelineWidth(width, persist),
          () => this.toggleShowPost(),
          this.showPost
        );
        this.renderer.setMode(this.mode);
        this.renderer.setShowPost(this.showPost);
      }
      return this.renderer;
    }

    setTimelineWidth(width, persist = true) {
      const maxAvailable = Math.max(CONFIG.minTimelineWidthPx + 100, getRealWindowWidth() - CONFIG.navWidthPx - 340);
      const maxLimit = Math.min(CONFIG.maxTimelineWidthPx, maxAvailable);
      const value = clamp(Number(width) || CONFIG.timelineWidthPx, CONFIG.minTimelineWidthPx, maxLimit);
      document.documentElement.style.setProperty('--xsr-timeline-width', `${Math.round(value)}px`);
      if (persist) localStorage.setItem(STORAGE.timelineWidth, String(Math.round(value)));
      else localStorage.removeItem(STORAGE.timelineWidth);
    }

    applyStoredTimelineWidth() {
      const stored = Number(localStorage.getItem(STORAGE.timelineWidth));
      this.setTimelineWidth(Number.isFinite(stored) && stored > 0 ? stored : CONFIG.timelineWidthPx, Boolean(stored));
    }

    applyEnabled() {
      document.documentElement.classList.toggle('xsr-enabled', this.enabled);
      if (this.enabled) this.ensureRenderer();
    }

    setEnabled(enabled) {
      this.clearHoverTimer();
      this.enabled = Boolean(enabled);
      localStorage.setItem(STORAGE.enabled, String(this.enabled));
      this.applyEnabled();
      if (this.enabled) this.onScroll();
    }

    setMode(mode) {
      this.clearHoverTimer();
      this.mode = mode;
      localStorage.setItem(STORAGE.mode, mode);
      this.renderer?.setMode(mode);
      if (mode === 'FOLLOW') this.evaluate(true);
    }

    onScroll() {
      this.clearHoverTimer();
      this.compactNativeTweets();
      if (!this.enabled || this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        const now = performance.now();
        if (now - this.lastScanAt < CONFIG.scanIntervalMs) return;
        this.lastScanAt = now;
        this.evaluate(false);
      });
    }

    evaluate(force) {
      if (!this.enabled || this.mode === 'PINNED') return;
      const items = this.scanner.scan();
      this.lastItems = items;
      const winner = chooseActiveCandidate(items, window.innerHeight * CONFIG.readingLineRatio);
      if (!winner) return;
      if (winner.id === this.activeId) {
        this.scrollTriggeredArticle = winner.article;
        this.scrollTriggeredId = winner.id;
        this.activeDistance = winner.distance;
        this.candidate = null;
        this.schedulePrefetch(items, winner.id);
        return;
      }
      const now = performance.now();
      if (!this.candidate || this.candidate.id !== winner.id) {
        this.candidate = winner;
        this.candidateSince = now;
        if (!this.activeId || force) {
          this.scrollTriggeredArticle = winner.article;
          this.scrollTriggeredId = winner.id;
          this.activate(winner, items);
        }
        return;
      }
      const heldLongEnough = now - this.candidateSince >= CONFIG.switchDebounceMs;
      const clearlyBetter = winner.distance + CONFIG.switchAdvantagePx < this.activeDistance;
      if (heldLongEnough || clearlyBetter || force) {
        this.scrollTriggeredArticle = winner.article;
        this.scrollTriggeredId = winner.id;
        this.activate(winner, items);
      }
    }

    clearHoverTimer() {
      if (this.hoverTimer) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
      }
      this.hoverTimerArticle = null;
    }

    onPointerMove(event) {
      if (!this.enabled || !this.hoverLookahead || this.mode === 'PINNED') return;
      if (event.target.closest('#xsr-pane, header[role="banner"]')) {
        this.clearHoverTimer();
        return;
      }

      const article = event.target.closest('article[data-testid="tweet"]');
      if (!article) {
        this.clearHoverTimer();
        return;
      }

      // 如果当前文章已经被激活，则无需重复响应
      if (article.classList.contains('xsr-active-tweet')) {
        this.clearHoverTimer();
        return;
      }

      // 核心基准：以最近一次滚动触发的推文为基准（或当前高亮推文）
      const baselineArticle = this.scrollTriggeredArticle || document.querySelector('article.xsr-active-tweet');
      if (!baselineArticle) return;

      // 虚拟列表边界：推特虚拟滚动可能卸载 DOM 节点，Disconnected 节点严禁参与文档位置判定
      if (!baselineArticle.isConnected || !article.isConnected) {
        if (!baselineArticle.isConnected) this.scrollTriggeredArticle = null;
        this.clearHoverTimer();
        return;
      }

      // 核心边界：必须在当前基准推文的【下方】
      // 移动到原本触发 timeline 以上严格无效
      if (article !== baselineArticle) {
        const position = baselineArticle.compareDocumentPosition(article);
        const isFollowing = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
        const baselineRect = baselineArticle.getBoundingClientRect();
        const targetRect = article.getBoundingClientRect();
        const isVisuallyBelow = targetRect.top > baselineRect.top - 10;

        if (!isFollowing || !isVisuallyBelow) {
          this.clearHoverTimer();
          return;
        }
      }

      // 验证是下方的有效推文，防抖悬停后优先切换
      if (this.hoverTimerArticle === article) return;
      this.clearHoverTimer();
      this.hoverTimerArticle = article;
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        this.hoverTimerArticle = null;
        if (!this.enabled || !this.hoverLookahead || this.mode === 'PINNED') return;
        const tweet = extractDomTweet(article);
        if (!tweet || tweet.id === this.activeId) return;

        const rect = article.getBoundingClientRect();
        this.activate({
          id: tweet.id,
          article,
          tweet,
          rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
          viewportHeight: window.innerHeight,
          distance: 0
        });
      }, CONFIG.hoverDebounceMs);
    }

    activate(item, items = this.lastItems) {
      this.clearHoverTimer();
      if (!item || item.id === this.activeId) return;
      this.activeId = item.id;
      this.activeDistance = item.distance;
      this.candidate = null;
      this.requestVersion += 1;
      const version = this.requestVersion;
      const renderer = this.ensureRenderer();
      renderer.setLoading(item.tweet);
      this.highlight(item.article);
      const cached = this.cache.peek(item.id);
      if (cached) renderer.renderConversation(cached);
      else {
        this.cache.get(item.id, (id) => this.provider.fetch(id)).then((conversation) => {
          if (version === this.requestVersion && item.id === this.activeId) renderer.renderConversation(conversation);
        }).catch((error) => {
          if (version === this.requestVersion && item.id === this.activeId) renderer.renderError(item.tweet, error);
        });
      }
      this.schedulePrefetch(items, item.id);
    }

    highlight(article) {
      document.querySelectorAll('article.xsr-active-tweet').forEach((node) => node.classList.remove('xsr-active-tweet'));
      article?.classList.add('xsr-active-tweet');
    }

    schedulePrefetch(items, activeId) {
      const index = items.findIndex((item) => item.id === activeId);
      if (index < 0) return;
      const plan = [];
      for (let step = 1; step <= CONFIG.forwardPrefetch; step += 1) if (items[index + step]) plan.push({ item: items[index + step], priority: step });
      for (let step = 1; step <= CONFIG.backwardPrefetch; step += 1) if (items[index - step]) plan.push({ item: items[index - step], priority: 10 + step });
      plan.forEach(({ item, priority }) => {
        if (this.cache.peek(item.id) || this.cache.inflight.has(item.id)) return;
        this.queue.add(item.id, priority, () => this.cache.get(item.id, (id) => this.provider.fetch(id)));
      });
    }

    async loadMore(id, cursor) {
      const page = await this.provider.fetch(id, cursor);
      const current = this.cache.peek(id);
      if (!current || id !== this.activeId) return;
      const seen = new Set(current.replies.map((reply) => reply.id));
      const merged = { ...current, replies: [...current.replies, ...page.replies.filter((reply) => !seen.has(reply.id))], nextCursor: page.nextCursor, fetchedAt: Date.now() };
      this.cache.set(id, merged);
      this.renderer.appendReplies(merged);
    }

    onKeyDown(event) {
      if (event.altKey && event.shiftKey && event.code === 'KeyX') {
        event.preventDefault();
        this.setEnabled(!this.enabled);
      } else if (event.key === 'Escape' && this.mode === 'PINNED') this.setMode('FOLLOW');
    }

    onClick(event) {
      this.clearHoverTimer();
      if (!this.enabled || event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (event.target.closest('#xsr-pane')) return;

      const article = event.target.closest('article[data-testid="tweet"]');
      if (!article) return;

      // 允许作者头像、点赞、转推、媒体查看等原生交互
      const interactive = event.target.closest(
        'button, [role="button"], input, textarea, a[href*="/status/photo/"], a[href*="/status/video/"]'
      );
      if (interactive && !interactive.querySelector('time') && !interactive.closest('[data-testid="tweetText"]')) {
        return;
      }

      const tweet = extractDomTweet(article);
      if (!tweet) return;

      const rect = article.getBoundingClientRect();
      this.activate({ id: tweet.id, article, tweet, rect: { top: rect.top, bottom: rect.bottom, height: rect.height }, viewportHeight: window.innerHeight, distance: 0 });
    }
  }

  function installStyles() {
    const css = `
      :root {
        --xsr-nav-width: ${CONFIG.navWidthPx}px;
        --xsr-timeline-width: ${CONFIG.timelineWidthPx}px;
        --xsr-timeline-gap: 14px;
        --xsr-detail-wide-threshold: ${CONFIG.wideDetailThresholdPx}px;
        --xsr-border: rgb(239, 243, 244);
        --xsr-bg: rgb(255, 255, 255);
        --xsr-text: rgb(15, 20, 25);
        --xsr-muted: rgb(83, 100, 113);
        --xsr-accent: rgb(29, 155, 240);
        --xsr-btn-hover: rgba(15, 20, 25, 0.08);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --xsr-border: rgb(47, 51, 54);
          --xsr-bg: rgb(0, 0, 0);
          --xsr-text: rgb(231, 233, 234);
          --xsr-muted: rgb(113, 118, 123);
          --xsr-btn-hover: rgba(231, 233, 234, 0.12);
        }
      }
      #xsr-pane { display: none; }

      /* === 彻底治愈推特原生无限滚动 (严禁污染 html/body 的 overflow-x 与 padding-right) === */

      /* 隐藏原生右侧边栏（趋势、搜索） */
      html.xsr-enabled [data-testid="sidebarColumn"] { display: none !important; }

      /* === 1. 左侧紧凑导航栏整治 (标准 68px 原生紧凑模式，消除错位与截断) === */
      html.xsr-enabled header[role="banner"] {
        position: fixed !important;
        left: 0 !important;
        top: 0 !important;
        bottom: 0 !important;
        width: var(--xsr-nav-width) !important;
        min-width: var(--xsr-nav-width) !important;
        max-width: var(--xsr-nav-width) !important;
        flex-grow: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        border-right: 1px solid var(--xsr-border) !important;
        z-index: 100 !important;
        background: var(--xsr-bg) !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        scrollbar-width: none !important;
      }
      html.xsr-enabled header[role="banner"]::-webkit-scrollbar { display: none !important; }

      html.xsr-enabled header[role="banner"] > div,
      html.xsr-enabled header[role="banner"] > div > div {
        width: 100% !important;
        max-width: var(--xsr-nav-width) !important;
        align-items: center !important;
      }

      /* 导航图标：居中 44px 圆形，隐藏文本 */
      html.xsr-enabled header[role="banner"] nav[role="navigation"] {
        align-items: center !important;
        width: 100% !important;
      }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a {
        width: 44px !important;
        height: 44px !important;
        margin: 2px auto !important;
        padding: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 9999px !important;
      }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a > div {
        min-width: 0 !important;
        width: 44px !important;
        height: 44px !important;
        padding: 0 !important;
        margin: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      /* 导航图标与菜单项（含 a 链接和 More 等 div[role="button"]）：居中 44px 圆形，彻底隐藏文本 */
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a,
      html.xsr-enabled header[role="banner"] nav[role="navigation"] [role="button"],
      html.xsr-enabled header[role="banner"] [data-testid="AppTabBar_More_Menu"] {
        width: 44px !important;
        height: 44px !important;
        margin: 2px auto !important;
        padding: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 9999px !important;
      }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a > div,
      html.xsr-enabled header[role="banner"] nav[role="navigation"] [role="button"] > div {
        min-width: 0 !important;
        width: 44px !important;
        height: 44px !important;
        padding: 0 !important;
        margin: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] span,
      html.xsr-enabled header[role="banner"] nav[role="navigation"] div[dir="ltr"],
      html.xsr-enabled header[role="banner"] [data-testid="AppTabBar_More_Menu"] span,
      html.xsr-enabled header[role="banner"] [data-testid="AppTabBar_More_Menu"] div[dir="ltr"] {
        display: none !important;
      }

      /* 发推按钮：44px 紧凑圆形，隐藏 Post 单词，展示推特官方羽毛笔 SVG 图标 */
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_NewTweet_Button"] {
        width: 44px !important;
        height: 44px !important;
        min-width: 44px !important;
        max-width: 44px !important;
        min-height: 44px !important;
        max-height: 44px !important;
        margin: 8px auto !important;
        padding: 0 !important;
        border-radius: 9999px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_NewTweet_Button"] span,
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_NewTweet_Button"] div[dir="ltr"] {
        display: none !important;
      }
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_NewTweet_Button"] svg {
        display: block !important;
        width: 24px !important;
        height: 24px !important;
      }

      /* 最底部账号卡片：纯净圆形头像，消除文字截断、多余边框与错位 */
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] {
        width: 44px !important;
        height: 44px !important;
        min-width: 44px !important;
        max-width: 44px !important;
        margin: 12px auto !important;
        padding: 0 !important;
        border-radius: 9999px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border: none !important;
        background: transparent !important;
      }
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] span,
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] div[dir="ltr"],
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] svg {
        display: none !important;
      }
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_AccountSwitcher_Button"] img {
        width: 40px !important;
        height: 40px !important;
        border-radius: 9999px !important;
      }

      /* === 2. 主时间线 Timeline 容器设置 === */
      html.xsr-enabled #react-root > div > div > div {
        justify-content: flex-start !important;
      }
      html.xsr-enabled main[role="main"] {
        position: relative !important;
        width: var(--xsr-timeline-width) !important;
        min-width: var(--xsr-timeline-width) !important;
        max-width: var(--xsr-timeline-width) !important;
        flex-grow: 0 !important;
        flex-shrink: 0 !important;
        margin-left: calc(var(--xsr-nav-width) + var(--xsr-timeline-gap)) !important;
        margin-right: 0 !important;
      }
      html.xsr-enabled [data-testid="primaryColumn"] {
        width: 100% !important;
        min-width: 0 !important;
        max-width: var(--xsr-timeline-width) !important;
        border-right: 1px solid var(--xsr-border) !important;
      }
      html.xsr-enabled article.xsr-active-tweet {
        box-shadow: inset 3px 0 0 var(--xsr-accent);
        background: color-mix(in srgb, var(--xsr-accent) 5%, transparent);
      }

      /* === 2.1 X 原生推文文本 Typography & 语义段落间距 === */
      html.xsr-enabled article[data-testid="tweet"] [data-testid="tweetText"],
      html.xsr-enabled [data-testid="tweetText"]:not(#xsr-pane *) {
        font-size: 15px !important;
        line-height: 1.58 !important;
        letter-spacing: -0.01em !important;
      }
      .xsr-para-gap {
        display: block !important;
        height: 8px !important;
        min-height: 8px !important;
        line-height: 0 !important;
        font-size: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        user-select: none !important;
        pointer-events: none !important;
      }

      /* === 3. 右侧 Detail 分栏 (#xsr-pane) === */
      html.xsr-enabled #xsr-pane {
        display: flex;
        position: fixed;
        z-index: 999;
        top: 0;
        right: 0;
        bottom: 0;
        width: calc(100vw - var(--xsr-nav-width) - var(--xsr-timeline-width) - var(--xsr-timeline-gap)) !important;
        min-width: 0;
        height: 100vh;
        flex-direction: column;
        color: var(--xsr-text);
        background: var(--xsr-bg);
        border-left: 1px solid var(--xsr-border);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
      .xsr-divider {
        position: absolute;
        z-index: 10;
        left: -5px;
        top: 0;
        bottom: 0;
        width: 10px;
        cursor: col-resize;
      }
      .xsr-divider:hover, html.xsr-resizing .xsr-divider {
        background: color-mix(in srgb, var(--xsr-accent) 30%, transparent);
      }
      html.xsr-resizing {
        cursor: col-resize !important;
        user-select: none !important;
      }

      /* 工具栏 */
      .xsr-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 48px;
        padding: 0 12px;
        border-bottom: 1px solid var(--xsr-border);
      }
      .xsr-title { font-size: 15px; font-weight: 700; white-space: nowrap; }
      .xsr-status { color: var(--xsr-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .xsr-spacer { flex: 1; }

      /* 按钮组 */
      .xsr-post-btn, .xsr-mode, .xsr-load-more {
        border: 1px solid var(--xsr-border);
        border-radius: 9999px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 700;
        color: var(--xsr-text);
        background: transparent;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .xsr-post-btn:hover, .xsr-mode:hover, .xsr-load-more:hover {
        background: var(--xsr-btn-hover);
      }
      .xsr-post-btn.is-active {
        color: white;
        background: var(--xsr-text);
        border-color: var(--xsr-text);
      }
      .xsr-post-btn.has-thread-hint {
        color: var(--xsr-accent);
        border-color: var(--xsr-accent);
        background: color-mix(in srgb, var(--xsr-accent) 10%, transparent);
      }
      .xsr-post-btn.has-thread-hint:hover {
        background: color-mix(in srgb, var(--xsr-accent) 20%, transparent);
      }
      .xsr-mode.is-pinned {
        color: white;
        border-color: var(--xsr-accent);
        background: var(--xsr-accent);
      }
      .xsr-open {
        color: var(--xsr-accent);
        font-size: 12px;
        text-decoration: none;
        white-space: nowrap;
      }

      /* 滚动主体与网格 */
      .xsr-body { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
      .xsr-detail-grid { min-height: 100%; display: grid; grid-template-columns: 1fr; align-items: start; }
      .xsr-focus-column, .xsr-reply-column { min-width: 0; }
      .xsr-detail-grid.is-comment-layout .xsr-reply-column {
        width: 100%;
        max-width: 660px;
        margin: 0 auto;
        padding: 0 16px;
      }

      /* Mini Anchor：纯评论视图顶部的超轻量单行作者锚点 */
      .xsr-mini-anchor {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        background: color-mix(in srgb, var(--xsr-text) 2.5%, var(--xsr-bg));
        border-bottom: 1px solid color-mix(in srgb, var(--xsr-border) 60%, transparent);
        font-size: 12px;
      }
      .xsr-mini-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        object-fit: cover;
        flex-shrink: 0;
      }
      .xsr-mini-info {
        color: var(--xsr-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }
      .xsr-mini-action {
        border: none;
        background: transparent;
        color: var(--xsr-accent);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        white-space: nowrap;
      }
      .xsr-mini-action:hover {
        text-decoration: underline;
        background: color-mix(in srgb, var(--xsr-accent) 10%, transparent);
      }

      /* 空状态与推文卡片 */
      .xsr-empty { display: grid; min-height: 60vh; place-content: center; padding: 24px; text-align: center; color: var(--xsr-muted); }
      .xsr-empty-icon { font-size: 32px; color: var(--xsr-accent); }
      .xsr-empty h2 { margin: 8px 0 4px; font-size: 16px; color: var(--xsr-text); }
      .xsr-empty p { max-width: 320px; margin: 0; font-size: 13px; line-height: 1.4; }
      .xsr-tweet {
        padding: 12px 14px;
        border-bottom: 1px solid color-mix(in srgb, var(--xsr-border) 65%, transparent);
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .xsr-tweet:hover {
        background: color-mix(in srgb, var(--xsr-text) 3%, transparent);
      }
      .xsr-tweet.is-prominent {
        padding: 16px 14px 14px;
        border-bottom: 1px solid var(--xsr-border);
      }
      .xsr-tweet-header {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .xsr-avatar {
        width: 36px;
        height: 36px;
        flex: 0 0 auto;
        border-radius: 50%;
        object-fit: cover;
        background: var(--xsr-border);
      }
      .xsr-identity {
        min-width: 0;
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        column-gap: 6px;
        row-gap: 2px;
        line-height: 1.3;
      }
      .xsr-name {
        font-size: 14px;
        font-weight: 650;
        color: var(--xsr-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .xsr-handle {
        font-size: 12.5px;
        color: var(--xsr-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .xsr-sep {
        font-size: 12px;
        color: var(--xsr-muted);
        user-select: none;
      }
      .xsr-date {
        font-size: 11.5px;
        color: var(--xsr-muted);
        white-space: nowrap;
      }
      .xsr-text {
        margin-top: 8px;
        font-size: 15px;
        line-height: 1.58;
        letter-spacing: -0.01em;
        overflow-wrap: anywhere;
      }
      .xsr-tweet.is-prominent .xsr-text {
        font-size: 16px;
        line-height: 1.6;
      }
      .xsr-para {
        margin: 0 0 8px 0;
        white-space: pre-wrap;
      }
      .xsr-para:last-child {
        margin-bottom: 0;
      }
      .xsr-media {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 2px;
        max-height: 320px;
        margin-top: 10px;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--xsr-border) 75%, transparent);
        border-radius: 12px;
      }
      .xsr-media.count-1 { grid-template-columns: 1fr; }
      .xsr-media img { width: 100%; height: 100%; min-height: 120px; max-height: 320px; object-fit: cover; }
      .xsr-metrics {
        display: flex;
        gap: 24px;
        margin-top: 10px;
        border-top: none;
        color: var(--xsr-muted);
        font-size: 12px;
        letter-spacing: 0.02em;
      }
      .xsr-section-title { position: sticky; z-index: 1; top: 0; margin: 0; padding: 6px 12px; border-bottom: 1px solid var(--xsr-border); background: color-mix(in srgb, var(--xsr-bg) 94%, transparent); backdrop-filter: blur(8px); font-size: 12px; font-weight: 700; }
      .xsr-section > .xsr-muted { padding: 12px; }
      .xsr-no-replies { text-align: center; padding: 24px !important; color: var(--xsr-muted); }
      .xsr-load-more { display: block; margin: 12px auto 20px; }
      .xsr-load-more:disabled { opacity: .6; cursor: wait; }
      .xsr-error { margin: 14px; padding: 14px; border: 1px solid color-mix(in srgb, #f4212e 55%, var(--xsr-border)); border-radius: 12px; }
      .xsr-error p { margin: 8px 0 0; }
      .xsr-skeleton { padding: 12px; }
      .xsr-skeleton-line { height: 10px; width: 72%; margin: 8px 0; border-radius: 9999px; background: var(--xsr-border); animation: xsr-pulse 1.2s ease-in-out infinite alternate; }
      .xsr-skeleton-line.wide { width: 94%; } .xsr-skeleton-line.short { width: 48%; }
      @keyframes xsr-pulse { to { opacity: .45; } }

      /* 展开主帖 / Thread 时双列对照布局 */
      @media (min-width: 1400px) {
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-thread-layout { grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr); }
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-thread-layout .xsr-focus-column { position: sticky; top: 0; max-height: calc(100vh - 48px); overflow-y: auto; border-right: 1px solid var(--xsr-border); }
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-thread-layout .xsr-reply-column { min-height: 100%; }
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-thread-layout .xsr-focus-column .xsr-media { max-height: 300px; }
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-thread-layout .xsr-focus-column .xsr-media img { max-height: 300px; }
        html.xsr-enabled #xsr-pane .xsr-detail-grid.is-comment-layout { grid-template-columns: 1fr; }
      }

      /* 窄屏降级 */
      @media (max-width: 1200px) {
        :root { --xsr-nav-width: 64px; --xsr-timeline-gap: 0px; }
        html.xsr-enabled main[role="main"] { margin-left: 0 !important; width: min(600px, calc(100vw - var(--xsr-nav-width))) !important; min-width: min(600px, calc(100vw - var(--xsr-nav-width))) !important; max-width: min(600px, calc(100vw - var(--xsr-nav-width))) !important; }
        html.xsr-enabled [data-testid="primaryColumn"] { width: 100% !important; border-right: none !important; }
        html.xsr-enabled #xsr-pane { display: none; }
      }
    `;
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }
  }

  const coreExports = {
    CONFIG,
    TweetCache,
    RequestQueue,
    clamp,
    chooseActiveCandidate,
    extractTweetIdFromHref,
    formatMetric,
    formatTweetDate,
    compactTweetTextNode,
    splitParagraphs,
    renderStructuredText,
    normalizeFxStatus,
    normalizeFxConversation
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = coreExports;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    installCompactViewportSpoof();
    const bootstrap = () => {
      if (window.top !== window.self) return;
      console.log('%c[X Split Reader] v0.3.3 Active%c (Paragraph Normalizer & Compact Text Ready)', 'color: #1d9bf0; font-weight: bold;', 'color: gray;');
      const app = new XSplitReader();
      app.start();
      window.__XSplitReader = app;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    else bootstrap();
  }
})();
