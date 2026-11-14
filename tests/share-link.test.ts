import { describe, expect, it } from 'vitest';
import { buildShareLink, looksLikeShareLink, parseShareLink, ShareLinkPrefix } from '../src/shared/share-link';

// Shared vector: Keepmark for Android (SyncShareLinkTests.cs) pins the same string.
const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const id = '0123456789abcdef0123456789abcdef';
const vector = 'keepmark://sync?v=1&s=https%3A%2F%2Fapi.example.test%2Fsync&id=0123456789abcdef0123456789abcdef&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const k = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('shared sync link (format 1)', () => {
  it('builds the shared vector', () => {
    expect(buildShareLink({ serviceUrl: 'https://api.example.test/sync', id, key })).toBe(vector);
  });

  it('parses the shared vector into a key candidate', () => {
    expect(parseShareLink(vector)).toEqual({ serviceUrl: 'https://api.example.test/sync', id, key });
  });

  it('round-trips the URL-safe alphabet and a service path with a trailing slash', () => {
    const allOnes = '//////////////////////////////////////////8=';
    const link = buildShareLink({ serviceUrl: 'https://sync.example.test:8443/prefix/', id: 'abc_DEF-1', key: allOnes });
    expect(link.split('&k=')[1]).toBe('__________________________________________8');
    expect(parseShareLink(link)).toEqual({ serviceUrl: 'https://sync.example.test:8443/prefix/', id: 'abc_DEF-1', key: allOnes });
  });

  it('escapes like .NET EscapeDataString (unreserved set only)', () => {
    const link = buildShareLink({ serviceUrl: "https://a.test/x!'()*", id, key });
    expect(link).toContain('&s=https%3A%2F%2Fa.test%2Fx%21%27%28%29%2A&');
    expect(parseShareLink(link)?.serviceUrl).toBe("https://a.test/x!'()*");
  });

  it('finds the link inside a message', () => {
    expect(parseShareLink(`Join my bookmarks:\n${vector}\nthanks`)?.id).toBe(id);
    expect(looksLikeShareLink(`see ${vector.toUpperCase()}`)).toBe(true);
    expect(looksLikeShareLink('https://example.test/')).toBe(false);
    expect(ShareLinkPrefix).toBe('keepmark://sync?');
  });

  it.each([
    `keepmark://sync?v=2&s=https%3A%2F%2Fa.test&id=abc&k=${k}`,
    'keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=abc',
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k}&x=1`,
    `keepmark://sync?v=1&v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k}`,
    `keepmark://sync?v=1&s=ftp%3A%2F%2Fa.test&id=abc&k=${k}`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fu%3Ap%40a.test&id=abc&k=${k}`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test%3Fq%3D1&id=abc&k=${k}`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=a.b&k=${k}`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k.slice(0, -1)}`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k.slice(0, -1)}9`,
    `keepmark://sync?v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k}%3D`,
    `keepmark://sync?v=1&s=%E0%A4%A&id=abc&k=${k}`,
    `keepmark://other?v=1&s=https%3A%2F%2Fa.test&id=abc&k=${k}`,
    '',
    undefined,
  ])('rejects anything else %j', (text) => {
    expect(parseShareLink(text)).toBeUndefined();
  });

  it('refuses to build from invalid input', () => {
    expect(() => buildShareLink({ serviceUrl: 'https://a.test', id, key: 'not-a-key' })).toThrow();
    expect(() => buildShareLink({ serviceUrl: 'ftp://a.test', id, key })).toThrow();
    expect(() => buildShareLink({ serviceUrl: 'https://a.test', id: 'a b', key })).toThrow();
  });
});
