'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TweetCache,
  clamp,
  chooseActiveCandidate,
  extractTweetIdFromHref,
  formatMetric,
  formatTweetDate,
  compactTweetTextNode,
  splitParagraphs,
  renderStructuredText,
  normalizeFxConversation
} = require('../x-split-reader.user.js');

test('extractTweetIdFromHref accepts canonical and web status URLs', () => {
  assert.equal(extractTweetIdFromHref('/openai/status/123456'), '123456');
  assert.equal(extractTweetIdFromHref('/i/web/status/789'), '789');
  assert.equal(extractTweetIdFromHref('/home'), null);
});

test('chooseActiveCandidate prefers the tweet crossing the reading line', () => {
  const items = [
    { id: 'a', rect: { top: -100, bottom: 100 }, viewportHeight: 1000 },
    { id: 'b', rect: { top: 250, bottom: 520 }, viewportHeight: 1000 },
    { id: 'c', rect: { top: 540, bottom: 900 }, viewportHeight: 1000 }
  ];
  assert.equal(chooseActiveCandidate(items, 350).id, 'b');
  assert.equal(chooseActiveCandidate(items, 530).id, 'b');
});

test('TweetCache deduplicates concurrent loads', async () => {
  const cache = new TweetCache({ maxEntries: 2, ttlMs: 60_000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { id: '1' };
  };
  const [first, second] = await Promise.all([cache.get('1', loader), cache.get('1', loader)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('TweetCache evicts the least recently used entry', () => {
  const cache = new TweetCache({ maxEntries: 2, ttlMs: 60_000 });
  cache.set('1', { id: '1' });
  cache.set('2', { id: '2' });
  cache.peek('1');
  cache.set('3', { id: '3' });
  assert.equal(cache.peek('2'), null);
  assert.equal(cache.peek('1').id, '1');
});

test('normalizeFxConversation returns the canonical model', () => {
  const status = {
    type: 'status', id: '20', url: 'https://x.com/jack/status/20', text: 'hello', created_at: '2006-03-21T20:50:14Z',
    replies: 3, reposts: 4, likes: 5, views: 6, media: {},
    author: { name: 'jack', screen_name: 'jack', avatar_url: 'https://example.com/a.jpg' }
  };
  const result = normalizeFxConversation({ code: 200, status, thread: [status], replies: [{ ...status, id: '21' }], cursor: { bottom: 'next' } }, '20');
  assert.equal(result.id, '20');
  assert.equal(result.status.author.handle, '@jack');
  assert.equal(result.replies[0].id, '21');
  assert.equal(result.nextCursor, 'next');
});

test('small helpers clamp and format values', () => {
  assert.equal(clamp(80, 30, 55), 55);
  assert.equal(formatMetric(1234), '1.2K');
  assert.equal(formatMetric(2_400_000), '2.4M');
  const nowIso = new Date().toISOString();
  assert.equal(formatTweetDate(nowIso), 'just now');
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.equal(formatTweetDate(tenMinAgo), '10m');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  assert.equal(formatTweetDate(twoHoursAgo), '2h');
  const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
  assert.equal(formatTweetDate(threeDaysAgo), '3d');
  assert.equal(formatTweetDate(''), '');
  assert.equal(formatTweetDate('invalid-date'), '');
});

test('splitParagraphs recognizes multi-newline breaks and trims blank blocks', () => {
  const raw = 'Paragraph 1\n\nParagraph 2\n \n\nParagraph 3\n\u200b\nParagraph 4';
  const result = splitParagraphs(raw);
  assert.deepEqual(result, ['Paragraph 1', 'Paragraph 2', 'Paragraph 3', 'Paragraph 4']);
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs('Single line'), ['Single line']);
});

test('compactTweetTextNode injects 8px paragraph gap between semantic paragraphs', () => {
  const textNode1 = {
    nodeValue: 'First paragraph.\n\n\nSecond paragraph.',
    parentNode: null
  };
  const parent1 = {
    children: [textNode1],
    replaceChild(frag, oldNode) {
      const idx = this.children.indexOf(oldNode);
      if (idx !== -1) {
        this.children.splice(idx, 1, ...frag.children);
      }
    }
  };
  textNode1.parentNode = parent1;

  const textNode2 = {
    nodeValue: 'Single line text without empty lines.',
    parentNode: {
      replaceChild() {
        assert.fail('Should not replace single line node');
      }
    }
  };

  const fakeNodes = [textNode1, textNode2];
  let index = 0;
  const fakeWalker = {
    nextNode() {
      if (index < fakeNodes.length) {
        this.currentNode = fakeNodes[index++];
        return true;
      }
      return false;
    },
    currentNode: null
  };

  const origDocument = global.document;
  const origNodeFilter = global.NodeFilter;

  global.document = {
    createTreeWalker: () => fakeWalker,
    createDocumentFragment: () => ({
      children: [],
      appendChild(child) {
        this.children.push(child);
      }
    }),
    createElement: (tag) => ({
      tag,
      className: '',
      style: {}
    }),
    createTextNode: (text) => ({
      nodeValue: text
    })
  };
  global.NodeFilter = { SHOW_TEXT: 4 };

  try {
    const root = { dataset: {} };
    compactTweetTextNode(root);
    assert.equal(parent1.children.length, 3);
    assert.equal(parent1.children[0].nodeValue, 'First paragraph.');
    assert.equal(parent1.children[1].className, 'xsr-para-gap');
    assert.equal(parent1.children[2].nodeValue, 'Second paragraph.');
    assert.equal(root.dataset.xsrParagraphs, 'true');
  } finally {
    global.document = origDocument;
    global.NodeFilter = origNodeFilter;
  }
});

test('renderStructuredText renders semantic paragraph elements when multiple paragraphs exist', () => {
  const createdElements = [];
  const fakeElement = (tag) => {
    const el = {
      tag,
      className: '',
      children: [],
      textContent: '',
      appendChild(child) {
        this.children.push(child);
      }
    };
    createdElements.push(el);
    return el;
  };

  const origDocument = global.document;
  global.document = {
    createElement: fakeElement
  };

  try {
    const rawMulti = 'Intro\n\nBody block\n\nOutro';
    const container = renderStructuredText(rawMulti);
    assert.equal(container.tag, 'div');
    assert.equal(container.className, 'xsr-text');
    assert.equal(container.children.length, 3);
    assert.equal(container.children[0].className, 'xsr-para');
    assert.equal(container.children[0].textContent, 'Intro');
    assert.equal(container.children[1].textContent, 'Body block');
    assert.equal(container.children[2].textContent, 'Outro');

    const single = renderStructuredText('Just one line');
    assert.equal(single.children.length, 0);
    assert.equal(single.textContent, 'Just one line');
  } finally {
    global.document = origDocument;
  }
});

