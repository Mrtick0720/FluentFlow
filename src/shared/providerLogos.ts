import azure from '@/assets/logos/azure.svg';
import chatgpt from '@/assets/logos/chatgpt.svg';
import deepl from '@/assets/logos/deepl.svg';
import deepseek from '@/assets/logos/deepseek.svg';
import gemini from '@/assets/logos/gemini.svg';
import google from '@/assets/logos/google.svg';

/**
 * A brand logo plus an optical scale factor. The SVGs have different internal
 * padding (some fill the viewBox edge-to-edge, some sit inside a tile), so each
 * gets a scale so they read at the same visual size inside a fixed box.
 */
export interface LogoInfo {
  src: string;
  scale: number;
}

const LOGOS = {
  deepseek: { src: deepseek, scale: 1.22 },
  gemini: { src: gemini, scale: 1.0 },
  deepl: { src: deepl, scale: 0.94 },
  chatgpt: { src: chatgpt, scale: 1.06 },
  azure: { src: azure, scale: 0.9 },
  google: { src: google, scale: 0.82 },
} satisfies Record<string, LogoInfo>;

/**
 * Map a provider id, endpoint name, or model id to a brand logo. Returns null
 * when we don't have a logo (caller falls back to a colored monogram).
 */
export function providerLogo(...hints: Array<string | undefined>): LogoInfo | null {
  const h = hints.filter(Boolean).join(' ').toLowerCase();
  if (/deepseek/.test(h)) return LOGOS.deepseek;
  if (/gemini/.test(h)) return LOGOS.gemini; // before google — gemini is a google model
  if (/deepl/.test(h)) return LOGOS.deepl;
  if (/chatgpt|openai|\bgpt\b|gpt-|\bo[13]\b/.test(h)) return LOGOS.chatgpt;
  if (/azure/.test(h)) return LOGOS.azure;
  if (/google|谷歌/.test(h)) return LOGOS.google;
  return null;
}
