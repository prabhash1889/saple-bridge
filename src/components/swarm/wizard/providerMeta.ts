import type { AgentProvider } from '../../../types/provider';

// UI-facing view over the provider facts. The facts themselves live in
// `src/lib/agents/providerFacts.ts` (single renderer-side owner); this re-export shim exists for the
// swarm components and `swarmStore` (off-limits to edits) that still import from here. New
// consumers should import from `lib/agents/providerFacts` directly.

export {
  PROVIDER_LABELS,
  PROVIDER_ORDER,
  EXPERIMENTAL_PROVIDERS,
  TURN_INJECTION_PROVIDERS,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_MODEL_ALIASES,
} from '../../../lib/agents/providerFacts';
import { TURN_INJECTION_PROVIDERS } from '../../../lib/agents/providerFacts';

export const providerSupportsTurnInjection = (provider?: AgentProvider): boolean =>
  !!provider && TURN_INJECTION_PROVIDERS.has(provider);
