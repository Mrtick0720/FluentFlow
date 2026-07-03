import type { TranslationProviderId } from '@/types/models';
import { AzureProvider } from './azure';
import { DeepLProvider } from './deepl';
import { GoogleProvider } from './google';
import { CustomProvider, OpenAIProvider } from './openai';
import { TranslationError, type TranslationProvider } from './provider';

/** Add a provider: implement TranslationProvider and register it here. */
export class ProviderRegistry {
  private providers = new Map<TranslationProviderId, TranslationProvider>();

  register(provider: TranslationProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: TranslationProviderId): TranslationProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new TranslationError('not_configured', `Unknown translation provider: ${id}`);
    }
    return provider;
  }

  list(): TranslationProvider[] {
    return [...this.providers.values()];
  }
}

export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(new GoogleProvider())
    .register(new DeepLProvider())
    .register(new OpenAIProvider())
    .register(new AzureProvider())
    .register(new CustomProvider());
}
