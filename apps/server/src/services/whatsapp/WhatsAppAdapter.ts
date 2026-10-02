/**
 * Phase 5.1 — WhatsApp Adapter Interface
 *
 * Provider-independent interface for WhatsApp sending capabilities.
 * This abstraction sits between CampaignExecution and a future provider.
 *
 * CampaignExecution → Execution service/worker → WhatsAppAdapter → Concrete provider
 *
 * This file re-exports the interface from types.ts and provides the
 * provider registry implementation.
 */

export { WhatsAppAdapter, WhatsAppAdapterFactory, WhatsAppProviderRegistry } from './types';

import type { WhatsAppAdapter as AdapterInterface, WhatsAppProviderRegistry as RegistryInterface } from './types';
import { getWhatsAppAdapter } from './whatsappProvider';

/**
 * Provider registry implementation.
 *
 * The application obtains the active adapter through this registry
 * rather than importing a concrete provider directly.
 */
export const whatsappProviderRegistry: RegistryInterface = {
  getAdapter: getWhatsAppAdapter,
};

