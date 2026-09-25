import React from 'react';
import {
  PROVIDER_CATALOG,
  type EngineId,
} from '../../../src/protocol';
import type { PluginConfigContext } from '../../../src/plugin-api/types';

export interface ProviderModelPickerProps {
  engine?: EngineId | '';
  model?: string;
  activeProvider: string;
  ModelSelect: PluginConfigContext['ModelSelect'];
  providerPlaceholder?: string;
  modelPlaceholder?: string;
  onChange(next: { engine?: EngineId; model?: string }): void;
}

export function ProviderModelPicker({
  engine,
  model,
  activeProvider,
  ModelSelect,
  providerPlaceholder = 'Current provider',
  modelPlaceholder = 'Default one-shot model',
  onChange,
}: ProviderModelPickerProps) {
  const provider = (engine || activeProvider) as EngineId;
  const providerOptions = PROVIDER_CATALOG.filter((p) => p.implemented);
  return (
    <div className="plugin-model-picker">
      <select
        value={engine ?? ''}
        title="Provider used by this plugin"
        onChange={(e) => onChange({ engine: (e.target.value || undefined) as EngineId | undefined, model: undefined })}
      >
        <option value="">{providerPlaceholder}</option>
        {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <ModelSelect
        provider={provider}
        value={model ?? ''}
        label="Model used by this plugin"
        className=""
        defaultLabel={modelPlaceholder}
        onChange={(value) => onChange({ engine: engine || undefined, model: value || undefined })}
      />
    </div>
  );
}
