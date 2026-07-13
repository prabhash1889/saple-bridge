import React, { useEffect, useId, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { AgentProvider } from '../../types/provider';
import { useModelCatalogStore, assembleModelCatalog } from '../../stores/modelCatalogStore';

interface ModelComboboxProps {
  provider: AgentProvider;
  value: string;
  onChange: (model: string) => void;
  // Optional style/className passthrough so each host keeps its own input look.
  style?: React.CSSProperties;
  className?: string;
  placeholder?: string;
}

// Model picker shared by the swarm wizard, task dialog, and template editor (P8). A native
// <input list> + <datalist> is the combobox: real dropdown suggestions plus free text, keyboard and
// a11y for free. Suggestions come from aliases + recents + live API discovery; a warning chip flags
// a value that isn't in the assembled catalog (e.g. a rotted `gpt-4o` in a saved template) so it's
// visible before launch. `is_safe_model` in pty.rs is still the actual gate.
export const ModelCombobox: React.FC<ModelComboboxProps> = ({
  provider,
  value,
  onChange,
  style,
  className,
  placeholder = "Model id, or 'default' to let the CLI choose",
}) => {
  const listId = useId();
  const recents = useModelCatalogStore((s) => s.recents[provider]);
  const apiModels = useModelCatalogStore((s) => s.apiModels[provider]);
  const ensureApiModels = useModelCatalogStore((s) => s.ensureApiModels);

  // Kick off best-effort live discovery once per provider per session.
  useEffect(() => {
    ensureApiModels(provider);
  }, [provider, ensureApiModels]);

  const options = useMemo(
    () => assembleModelCatalog(provider, recents, apiModels),
    [provider, recents, apiModels]
  );

  const trimmed = value.trim();
  // Warn only when live discovery actually returned this provider's catalog (apiModels is set only
  // on a non-empty response, so this also covers "still fetching"). Without discovery — no API key,
  // offline — the assembled list is just aliases + recents, and flagging every legitimate full id a
  // subscription-login user types would be a false alarm. 'default' is always fine.
  const unrecognized =
    !!apiModels?.length && !!trimmed && trimmed !== 'default' && !options.includes(trimmed);

  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        list={listId}
        style={style}
        className={className}
      />
      <datalist id={listId}>
        {options.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {unrecognized && (
        <div style={warningStyle}>
          <AlertTriangle size={12} />
          <span>Not in {provider}'s known models - verify the id before launch.</span>
        </div>
      )}
    </>
  );
};

const warningStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  marginTop: '4px',
  fontSize: '10.5px',
  lineHeight: 1.3,
  color: 'var(--color-warning)',
};
