import azure from '@/assets/logos/azure.svg';
import chatgpt from '@/assets/logos/chatgpt.svg';
import deepl from '@/assets/logos/deepl.svg';
import deepseek from '@/assets/logos/deepseek.svg';
import gemini from '@/assets/logos/gemini.svg';
import google from '@/assets/logos/google.svg';

/**
 * Map a provider id, endpoint name, or model id to a brand logo URL. Returns
 * null when we don't have a logo (caller falls back to a colored monogram).
 */
export function providerLogo(...hints: Array<string | undefined>): string | null {
  const h = hints.filter(Boolean).join(' ').toLowerCase();
  if (/deepseek/.test(h)) return deepseek;
  if (/gemini/.test(h)) return gemini; // before google — gemini is a google model
  if (/deepl/.test(h)) return deepl;
  if (/chatgpt|openai|\bgpt\b|gpt-|\bo[13]\b/.test(h)) return chatgpt;
  if (/azure/.test(h)) return azure;
  if (/google|谷歌/.test(h)) return google;
  return null;
}
