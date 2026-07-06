export const EXT_NAME = 'FluentFlow';

/** Prefix for all classes/attributes injected into host pages. */
export const DOM_PREFIX = 'lf';

export const ATTR_TRANSLATED = 'data-lf-translated';
export const ATTR_SOURCE = 'data-lf-source';

export const MAX_BATCH_CHARS = 4500;
export const MAX_BATCH_SEGMENTS = 40;

export const COMMON_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ms', label: 'Bahasa Melayu' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
];
