// ==UserScript==
// @name         X Split Reader
// @namespace    https://github.com/epodak/x-split-reader
// @version      0.1.0
// @description  Scroll-driven master-detail reader for X: timeline on the left, post and replies on the right.
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
    defaultDetailWidth: 36,
    minDetailWidth: 30,
    maxDetailWidth: 55,
    apiTimeoutMs: 8000,
    scanIntervalMs: 120
  });

  const STORAGE = Object.freeze({
    enabled: 'xsr.enabled',
    detailWidth: 'xsr.detailWidth',
    mode: 'xsr.mode'
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function extractTweetIdFromHref(href) {
    if (!href) return null;
    const match = String(href).match(/\/(?:i\/web\/)?status\/(\d+)/);
    return match ? match[1] : null;
  }

  function formatMetric(value) {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
    return String(number);
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
    let winner = null;
    let bestDistance = Infinity;

    for (const item of items) {
      const { top, bottom } = item.rect;
      if (bottom <= 0 || top >= item.viewportHeight) continue;

      const containsLine = top <= readingY && bottom >= readingY;
      const distance = containsLine
        ? 0
        : Math.min(Math.abs(top - readingY), Math.abs(bottom - readingY));

      if (distance < bestDistance) {
        bestDistance = distance;
        winner = { ...item, distance };
      }
    }

    return winner;
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
    if (!focal || focal.id !== String(requestedId)) {
      throw new Error('Conversation API returned a mismatched post');
    }

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
      while (this.data.size > this.maxEntries) {
        this.data.delete(this.data.keys().next().value);
      }
      return value;
    }

    async get(id, loader) {
      const key = String(id);
      const cached = this.peek(key);
      if (cached) return cached;
      if (this.inflight.has(key)) return this.inflight.get(key);

      const promise = Promise.resolve()
        .then(() => loader(key))
        .then((value) => this.set(key, value))
        .finally(() => this.inflight.delete(key));

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
        Promise.resolve()
          .then(item.task)
          .catch(() => {})
          .finally(() => {
            this.active -= 1;
            this.keys.delete(item.key);
            this.drain();
          });
      }
    }
  }

  function requestJson(url, timeoutMs = CONFIG.apiTimeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest is unavailable'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`Conversation API HTTP ${response.status}`));
            return;
          }
          try {
            resolve(JSON.parse(response.responseText));
          } catch (_error) {
            reject(new Error('Conversation API returned invalid JSON'));
          }
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
      const url = `https://api.fxtwitter.com/2/conversation/${encodeURIComponent(id)}?${query}`;
      const payload = await requestJson(url);
      return normalizeFxConversation(payload, id);
    }
  }

  function extractDomTweet(article) {
    const permalink = article.querySelector('a[href*="/status/"] time')?.closest('a')
      || [...article.querySelectorAll('a[href*="/status/"]')]
        .find((link) => extractTweetIdFromHref(link.getAttribute('href')));
    const id = extractTweetIdFromHref(permalink && permalink.getAttribute('href'));
    if (!id) return null;

    const userName = article.querySelector('[data-testid="User-Name"]');
    const userText = userName ? userName.innerText.split('\n').filter(Boolean) : [];
    const handle = userText.find((part) => part.startsWith('@')) || '';
    const name = userText.find((part) => !part.startsWith('@') && !/^·$/.test(part)) || handle || 'Unknown';
    const avatar = [...article.querySelectorAll('img')]
      .map((image) => image.currentSrc || image.src)
      .find((src) => /profile_images|pbs\.twimg\.com\/profile/.test(src || '')) || '';
    const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .slice(0, 4)
      .map((image) => ({
        type: 'photo',
        url: sanitizeUrl(image.currentSrc || image.src, ''),
        thumbnailUrl: sanitizeUrl(image.currentSrc || image.src, ''),
        alt: image.alt || ''
      }));

    if (!media.length) {
      const video = article.querySelector('video');
      if (video && video.poster) {
        media.push({ type: 'video', url: '', thumbnailUrl: sanitizeUrl(video.poster, ''), alt: '' });
      }
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
      return [...document.querySelectorAll('article[data-testid="tweet"]')]
        .map((article) => {
          const tweet = extractDomTweet(article);
          if (!tweet) return null;
          const rect = article.getBoundingClientRect();
          return {
            id: tweet.id,
            article,
            tweet,
            rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
            viewportHeight
          };
        })
        .filter(Boolean);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  class DetailRenderer {
    constructor(onModeToggle, onLoadMore) {
      this.onModeToggle = onModeToggle;
      this.onLoadMore = onLoadMore;
      this.currentId = null;
      this.root = this.createRoot();
      this.body = this.root.querySelector('.xsr-body');
      this.modeButton = this.root.querySelector('.xsr-mode');
      this.openLink = this.root.querySelector('.xsr-open');
      this.status = this.root.querySelector('.xsr-status');
    }

    createRoot() {
      const root = element('aside', 'xsr-pane');
      root.id = 'xsr-pane';
      root.setAttribute('aria-label', 'X Split Reader post detail');

      const divider = element('div', 'xsr-divider');
      divider.setAttribute('aria-label', 'Resize detail pane');
      divider.setAttribute('role', 'separator');
      root.appendChild(divider);

      const toolbar = element('header', 'xsr-toolbar');
      const title = element('strong', 'xsr-title', 'Post detail');
      const status = element('span', 'xsr-status', 'Waiting for timeline…');
      const spacer = element('span', 'xsr-spacer');
      const mode = element('button', 'xsr-mode', 'FOLLOW');
      mode.type = 'button';
      mode.addEventListener('click', () => this.onModeToggle());
      const open = element('a', 'xsr-open', 'Open in X ↗');
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.hidden = true;
      toolbar.append(title, status, spacer, mode, open);

      const body = element('div', 'xsr-body');
      const empty = element('div', 'xsr-empty');
      empty.append(
        element('div', 'xsr-empty-icon', '↕'),
        element('h2', '', 'Scroll the timeline'),
        element('p', '', 'The post crossing the reading line will appear here. Click FOLLOW to pin it.')
      );
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
        const width = clamp(((window.innerWidth - event.clientX) / window.innerWidth) * 100,
          CONFIG.minDetailWidth, CONFIG.maxDetailWidth);
        document.documentElement.style.setProperty('--xsr-detail-width', `${width.toFixed(1)}vw`);
        localStorage.setItem(STORAGE.detailWidth, width.toFixed(1));
      });
      const finish = (event) => {
        if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
        document.documentElement.classList.remove('xsr-resizing');
      };
      divider.addEventListener('pointerup', finish);
      divider.addEventListener('pointercancel', finish);
      divider.addEventListener('dblclick', () => {
        document.documentElement.style.setProperty('--xsr-detail-width', `${CONFIG.defaultDetailWidth}vw`);
        localStorage.removeItem(STORAGE.detailWidth);
      });
    }

    setMode(mode) {
      this.modeButton.textContent = mode;
      this.modeButton.classList.toggle('is-pinned', mode === 'PINNED');
      this.modeButton.title = mode === 'PINNED' ? 'Click or press Esc to resume auto-follow' : 'Click to pin current post';
    }

    setLoading(tweet) {
      this.currentId = tweet.id;
      this.status.textContent = 'Loading replies…';
      this.openLink.href = tweet.url;
      this.openLink.hidden = false;
      this.body.replaceChildren(this.renderTweet(tweet, true), this.renderSkeleton());
      this.body.scrollTop = 0;
    }

    renderConversation(conversation) {
      if (conversation.id !== this.currentId) return;
      this.status.textContent = conversation.replies.length
        ? `${conversation.replies.length} replies loaded`
        : 'No replies returned';
      const fragment = document.createDocumentFragment();
      fragment.appendChild(this.renderTweet(conversation.status, true));

      if (conversation.thread.length > 1) {
        const thread = element('section', 'xsr-section');
        thread.appendChild(element('h3', 'xsr-section-title', 'Thread'));
        conversation.thread
          .filter((tweet) => tweet.id !== conversation.id)
          .forEach((tweet) => thread.appendChild(this.renderTweet(tweet, false)));
        fragment.appendChild(thread);
      }

      const replies = element('section', 'xsr-section xsr-replies');
      replies.appendChild(element('h3', 'xsr-section-title', 'Replies'));
      if (!conversation.replies.length) {
        replies.appendChild(element('p', 'xsr-muted', 'No reply data was returned by the provider.'));
      } else {
        conversation.replies.forEach((reply) => replies.appendChild(this.renderTweet(reply, false)));
      }

      if (conversation.nextCursor) {
        const more = element('button', 'xsr-load-more', 'Load more replies');
        more.type = 'button';
        more.addEventListener('click', async () => {
          more.disabled = true;
          more.textContent = 'Loading…';
          try {
            await this.onLoadMore(conversation.id, conversation.nextCursor);
          } catch (error) {
            more.disabled = false;
            more.textContent = 'Retry loading replies';
          }
        });
        replies.appendChild(more);
      }

      fragment.appendChild(replies);
      this.body.replaceChildren(fragment);
    }

    appendReplies(conversation) {
      if (conversation.id !== this.currentId) return;
      this.renderConversation(conversation);
    }

    renderError(tweet, error) {
      if (tweet.id !== this.currentId) return;
      this.status.textContent = 'Replies unavailable';
      const notice = element('div', 'xsr-error');
      notice.append(
        element('strong', '', 'Could not load replies'),
        element('p', '', error && error.message ? error.message : 'Unknown provider error'),
        element('p', 'xsr-muted', 'The timeline post remains available. Use “Open in X” for the native conversation.')
      );
      this.body.replaceChildren(this.renderTweet(tweet, true), notice);
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
      const name = element('strong', '', tweet.author.name);
      if (tweet.author.verified) name.append(' ✓');
      identity.append(name, element('span', '', tweet.author.handle));
      const date = element('time', 'xsr-date', tweet.createdAt ? new Date(tweet.createdAt).toLocaleString() : '');
      header.append(avatar, identity, date);
      article.append(header, element('div', 'xsr-text', tweet.text || ''));

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
      metrics.append(
        element('span', '', `↩ ${formatMetric(values.replies)}`),
        element('span', '', `↻ ${formatMetric(values.reposts)}`),
        element('span', '', `♡ ${formatMetric(values.likes)}`),
        element('span', '', `◫ ${formatMetric(values.views)}`)
      );
      article.appendChild(metrics);
      article.addEventListener('click', () => window.open(tweet.url, '_blank', 'noopener'));
      return article;
    }

    renderSkeleton() {
      const skeleton = element('div', 'xsr-skeleton');
      skeleton.append(
        element('div', 'xsr-skeleton-line wide'),
        element('div', 'xsr-skeleton-line'),
        element('div', 'xsr-skeleton-line short'),
        element('div', 'xsr-skeleton-line wide')
      );
      return skeleton;
    }
  }

  class XSplitReader {
    constructor() {
      this.enabled = localStorage.getItem(STORAGE.enabled) !== 'false';
      this.mode = localStorage.getItem(STORAGE.mode) === 'PINNED' ? 'PINNED' : 'FOLLOW';
      this.activeId = null;
      this.activeDistance = Infinity;
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
    }

    start() {
      installStyles();
      this.applyStoredWidth();
      this.applyEnabled();
      window.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
      document.addEventListener('keydown', this.onKeyDown, true);
      document.addEventListener('click', this.onClick, true);
      this.onScroll();

      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Toggle X Split Reader', () => this.setEnabled(!this.enabled));
        GM_registerMenuCommand('Resume auto-follow', () => this.setMode('FOLLOW'));
        GM_registerMenuCommand('Reset pane width', () => {
          localStorage.removeItem(STORAGE.detailWidth);
          document.documentElement.style.setProperty('--xsr-detail-width', `${CONFIG.defaultDetailWidth}vw`);
        });
      }
    }

    ensureRenderer() {
      if (!this.renderer && document.documentElement) {
        this.renderer = new DetailRenderer(
          () => this.setMode(this.mode === 'FOLLOW' ? 'PINNED' : 'FOLLOW'),
          (id, cursor) => this.loadMore(id, cursor)
        );
        this.renderer.setMode(this.mode);
      }
      return this.renderer;
    }

    applyStoredWidth() {
      const stored = Number(localStorage.getItem(STORAGE.detailWidth));
      const width = Number.isFinite(stored)
        ? clamp(stored, CONFIG.minDetailWidth, CONFIG.maxDetailWidth)
        : CONFIG.defaultDetailWidth;
      document.documentElement.style.setProperty('--xsr-detail-width', `${width}vw`);
    }

    applyEnabled() {
      document.documentElement.classList.toggle('xsr-enabled', this.enabled);
      if (this.enabled) this.ensureRenderer();
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      localStorage.setItem(STORAGE.enabled, String(this.enabled));
      this.applyEnabled();
      if (this.enabled) this.onScroll();
    }

    setMode(mode) {
      this.mode = mode;
      localStorage.setItem(STORAGE.mode, mode);
      this.renderer?.setMode(mode);
      if (mode === 'FOLLOW') this.evaluate(true);
    }

    onScroll() {
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
      const readingY = window.innerHeight * CONFIG.readingLineRatio;
      const winner = chooseActiveCandidate(items, readingY);
      if (!winner) return;

      if (winner.id === this.activeId) {
        this.activeDistance = winner.distance;
        this.candidate = null;
        this.schedulePrefetch(items, winner.id);
        return;
      }

      const now = performance.now();
      if (!this.candidate || this.candidate.id !== winner.id) {
        this.candidate = winner;
        this.candidateSince = now;
        if (!this.activeId || force) this.activate(winner, items);
        return;
      }

      const heldLongEnough = now - this.candidateSince >= CONFIG.switchDebounceMs;
      const clearlyBetter = winner.distance + CONFIG.switchAdvantagePx < this.activeDistance;
      if (heldLongEnough || clearlyBetter || force) this.activate(winner, items);
    }

    activate(item, items = this.lastItems) {
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
      if (cached) {
        renderer.renderConversation(cached);
      } else {
        this.cache.get(item.id, (id) => this.provider.fetch(id))
          .then((conversation) => {
            if (version === this.requestVersion && item.id === this.activeId) {
              renderer.renderConversation(conversation);
            }
          })
          .catch((error) => {
            if (version === this.requestVersion && item.id === this.activeId) {
              renderer.renderError(item.tweet, error);
            }
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
      for (let step = 1; step <= CONFIG.forwardPrefetch; step += 1) {
        if (items[index + step]) plan.push({ item: items[index + step], priority: step });
      }
      for (let step = 1; step <= CONFIG.backwardPrefetch; step += 1) {
        if (items[index - step]) plan.push({ item: items[index - step], priority: 10 + step });
      }
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
      const merged = {
        ...current,
        replies: [...current.replies, ...page.replies.filter((reply) => !seen.has(reply.id))],
        nextCursor: page.nextCursor,
        fetchedAt: Date.now()
      };
      this.cache.set(id, merged);
      this.renderer.appendReplies(merged);
    }

    onKeyDown(event) {
      if (event.altKey && event.shiftKey && event.code === 'KeyX') {
        event.preventDefault();
        this.setEnabled(!this.enabled);
      } else if (event.key === 'Escape' && this.mode === 'PINNED') {
        this.setMode('FOLLOW');
      }
    }

    onClick(event) {
      if (!this.enabled || event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href*="/status/"]');
      if (!link || !link.querySelector('time')) return;
      const article = link.closest('article[data-testid="tweet"]');
      if (!article) return;
      const tweet = extractDomTweet(article);
      if (!tweet) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = article.getBoundingClientRect();
      this.activate({
        id: tweet.id,
        article,
        tweet,
        rect: { top: rect.top, bottom: rect.bottom, height: rect.height },
        viewportHeight: window.innerHeight,
        distance: 0
      });
    }
  }

  function installStyles() {
    const css = `
      :root {
        --xsr-detail-width: ${CONFIG.defaultDetailWidth}vw;
        --xsr-nav-width: 88px;
        --xsr-border: rgb(239, 243, 244);
        --xsr-bg: rgb(255, 255, 255);
        --xsr-text: rgb(15, 20, 25);
        --xsr-muted: rgb(83, 100, 113);
        --xsr-accent: rgb(29, 155, 240);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --xsr-border: rgb(47, 51, 54);
          --xsr-bg: rgb(0, 0, 0);
          --xsr-text: rgb(231, 233, 234);
          --xsr-muted: rgb(113, 118, 123);
        }
      }
      #xsr-pane { display: none; }
      html.xsr-enabled body { padding-right: var(--xsr-detail-width) !important; }
      html.xsr-enabled [data-testid="sidebarColumn"] { display: none !important; }
      html.xsr-enabled header[role="banner"],
      html.xsr-enabled header[role="banner"] > div { width: var(--xsr-nav-width) !important; }
      html.xsr-enabled header[role="banner"] { overflow: hidden !important; }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a { width: 52px !important; }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a > div { min-width: 52px !important; }
      html.xsr-enabled header[role="banner"] nav[role="navigation"] a > div > div:last-child:not(:first-child) { display: none !important; }
      html.xsr-enabled header[role="banner"] [data-testid="SideNav_NewTweet_Button"] { width: 52px !important; min-width: 52px !important; }
      html.xsr-enabled main[role="main"] { width: calc(100vw - var(--xsr-detail-width) - var(--xsr-nav-width)) !important; max-width: none !important; }
      html.xsr-enabled [data-testid="primaryColumn"] { width: 100% !important; max-width: none !important; }
      html.xsr-enabled article.xsr-active-tweet { box-shadow: inset 3px 0 0 var(--xsr-accent); background: color-mix(in srgb, var(--xsr-accent) 5%, transparent); }
      html.xsr-enabled #xsr-pane {
        display: flex; position: fixed; z-index: 999; inset: 0 0 0 auto;
        width: var(--xsr-detail-width); height: 100vh; flex-direction: column;
        color: var(--xsr-text); background: var(--xsr-bg); border-left: 1px solid var(--xsr-border);
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      .xsr-divider { position: absolute; z-index: 3; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; }
      .xsr-divider:hover, html.xsr-resizing .xsr-divider { background: color-mix(in srgb, var(--xsr-accent) 35%, transparent); }
      html.xsr-resizing { cursor: col-resize !important; user-select: none !important; }
      .xsr-toolbar { display: flex; align-items: center; gap: 10px; min-height: 53px; padding: 0 16px; border-bottom: 1px solid var(--xsr-border); }
      .xsr-title { font-size: 18px; white-space: nowrap; }
      .xsr-status { color: var(--xsr-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .xsr-spacer { flex: 1; }
      .xsr-mode, .xsr-load-more { border: 1px solid var(--xsr-border); border-radius: 999px; padding: 7px 12px; color: var(--xsr-accent); background: transparent; font-weight: 700; cursor: pointer; }
      .xsr-mode.is-pinned { color: white; border-color: var(--xsr-accent); background: var(--xsr-accent); }
      .xsr-open { color: var(--xsr-accent); font-size: 13px; text-decoration: none; white-space: nowrap; }
      .xsr-body { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; }
      .xsr-empty { display: grid; min-height: 70vh; place-content: center; padding: 32px; text-align: center; color: var(--xsr-muted); }
      .xsr-empty-icon { font-size: 42px; color: var(--xsr-accent); }
      .xsr-empty h2 { margin: 10px 0 4px; color: var(--xsr-text); }
      .xsr-empty p { max-width: 360px; margin: 0; line-height: 1.5; }
      .xsr-tweet { padding: 14px 16px; border-bottom: 1px solid var(--xsr-border); cursor: pointer; }
      .xsr-tweet:hover { background: color-mix(in srgb, var(--xsr-text) 3%, transparent); }
      .xsr-tweet.is-prominent { padding-top: 18px; }
      .xsr-tweet-header { display: flex; align-items: center; gap: 10px; }
      .xsr-avatar { width: 44px; height: 44px; flex: 0 0 auto; border-radius: 50%; object-fit: cover; background: var(--xsr-border); }
      .xsr-identity { min-width: 0; display: flex; flex-direction: column; }
      .xsr-identity strong, .xsr-identity span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .xsr-identity span, .xsr-date, .xsr-muted { color: var(--xsr-muted); }
      .xsr-date { margin-left: auto; font-size: 12px; white-space: nowrap; }
      .xsr-text { margin-top: 12px; font-size: 15px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
      .xsr-tweet.is-prominent .xsr-text { font-size: 19px; line-height: 1.5; }
      .xsr-media { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px; max-height: 520px; margin-top: 12px; overflow: hidden; border: 1px solid var(--xsr-border); border-radius: 16px; }
      .xsr-media.count-1 { grid-template-columns: 1fr; }
      .xsr-media img { width: 100%; height: 100%; min-height: 170px; max-height: 520px; object-fit: cover; }
      .xsr-metrics { display: flex; justify-content: space-around; gap: 12px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--xsr-border); color: var(--xsr-muted); font-size: 13px; }
      .xsr-section-title { position: sticky; z-index: 1; top: 0; margin: 0; padding: 10px 16px; border-bottom: 1px solid var(--xsr-border); background: color-mix(in srgb, var(--xsr-bg) 92%, transparent); backdrop-filter: blur(8px); font-size: 14px; }
      .xsr-section > .xsr-muted { padding: 8px 16px 18px; }
      .xsr-load-more { display: block; margin: 16px auto 28px; }
      .xsr-load-more:disabled { opacity: .6; cursor: wait; }
      .xsr-error { margin: 18px; padding: 16px; border: 1px solid color-mix(in srgb, #f4212e 55%, var(--xsr-border)); border-radius: 14px; }
      .xsr-error p { margin: 8px 0 0; }
      .xsr-skeleton { padding: 18px 16px; }
      .xsr-skeleton-line { height: 12px; width: 72%; margin: 12px 0; border-radius: 999px; background: var(--xsr-border); animation: xsr-pulse 1.2s ease-in-out infinite alternate; }
      .xsr-skeleton-line.wide { width: 94%; } .xsr-skeleton-line.short { width: 48%; }
      @keyframes xsr-pulse { to { opacity: .45; } }
      @media (max-width: 1099px) {
        html.xsr-enabled body { padding-right: 0 !important; }
        html.xsr-enabled #xsr-pane { display: none; }
        html.xsr-enabled main[role="main"] { width: auto !important; }
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
    normalizeFxStatus,
    normalizeFxConversation
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = coreExports;

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const bootstrap = () => {
      if (window.top !== window.self) return;
      const app = new XSplitReader();
      app.start();
      window.__XSplitReader = app;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    else bootstrap();
  }
})();

