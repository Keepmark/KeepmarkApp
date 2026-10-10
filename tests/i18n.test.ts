import { describe, expect, it } from 'vitest';
import { en } from '../src/shared/i18n/en';
import { it as itCat } from '../src/shared/i18n/it';
import { fr } from '../src/shared/i18n/fr';
import { es } from '../src/shared/i18n/es';
import { de } from '../src/shared/i18n/de';
import { ja } from '../src/shared/i18n/ja';
import { pt } from '../src/shared/i18n/pt';
import { ru } from '../src/shared/i18n/ru';
import { zh } from '../src/shared/i18n/zh';
import { displayPath, getLang, resolveLang, setLang, t, tn } from '../src/shared/i18n';

const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('catalogs', () => {
  for (const [name, cat] of Object.entries({ it: itCat, fr, es, de, ja, pt, ru, zh })) {
    it(`${name}: same keys and placeholders as en, no empty values`, () => {
      expect(Object.keys(cat).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        expect(cat[k].trim(), k).not.toBe('');
        expect(ph(cat[k]), k).toEqual(ph(en[k]));
      }
    });
  }
  it('every _one key has an _other twin', () => {
    for (const k of Object.keys(en)) {
      if (k.endsWith('_one')) expect(en).toHaveProperty(k.replace(/_one$/, '_other'));
    }
  });
});

describe('resolveLang', () => {
  it.each([
    ['system', 'it-CH', 'it'],
    ['system', 'de_DE', 'de'],
    ['system', 'pt-BR', 'pt'],
    ['system', 'ja-JP', 'ja'],
    ['system', 'ru', 'ru'],
    ['system', 'zh-CN', 'zh'],
    ['system', 'zh-TW', 'zh'],
    ['system', 'ko-KR', 'en'],
    ['system', undefined, 'en'],
    ['fr', 'it-IT', 'fr'],
    ['xx', 'es-MX', 'es'],
  ])('%s + %s -> %s', (s, sys, exp) => expect(resolveLang(s, sys)).toBe(exp));
});

describe('t / tn', () => {
  it('translates, then restores en', () => {
    setLang('it');
    expect(getLang()).toBe('it');
    expect(t('settings.language')).toBe('Lingua');
    setLang('en');
    expect(t('settings.language')).toBe('Language');
  });
  it('tn is exported and falls back to the key when missing', () => {
    expect(tn('no.such', 1)).toBe('no.such_one');
  });
});

describe('displayPath', () => {
  it('shows browser names for the sync root titles, only at path boundaries', () => {
    setLang('en');
    expect(displayPath('[xbs] Other / Work / Regex101')).toBe('Other / Work / Regex101');
    expect(displayPath('GitHub: [xbs] Other / Dev → [xbs] Toolbar')).toBe('GitHub: Other / Dev → Toolbar');
    expect(displayPath('[xbs] Menu')).toBe('Menu');
    expect(displayPath('[xbs] Menus / x')).toBe('[xbs] Menus / x');
    setLang('it');
    expect(displayPath('[xbs] Toolbar / MDN')).toBe('Toolbar / MDN');
    setLang('en');
  });
});
