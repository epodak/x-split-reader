'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TweetCache,
  clamp,
  chooseActiveCandidate,
  extractTweetIdFromHref,
  formatMetric,
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
});

