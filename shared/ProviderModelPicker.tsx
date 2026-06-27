import React from 'react';
import {
  PROVIDER_CATALOG,
  type EngineId,
  type ModelOption,
  type ProviderCapabilitiesView,
} from '../../../src/protocol';

export interface ProviderModelPickerProps {
  engine?: EngineId | '';
  model?: string;
  activeProvider: string;
  autoProvider?: EngineId;
  providerCaps: Partial<Record<string, ProviderCapabilitiesView>>;
  providerPlaceholder?: string;
  modelPlaceholder?: string;
  providerFilter?: (provider: EngineId, caps: ProviderCapabilitiesView | undefined) => boolean;
  modelFilter?: (model: ModelOption, provider: EngineId, caps: ProviderCapabilitiesView | undefined) => boolean;
  onChange(next: { engine?: EngineId; model?: string }): void;
}

export function ProviderModelPicker({
  engine,
  model,
  activeProvider,
  autoProvider,
  providerCaps,
  providerPlaceholder = 'Current provider',
  modelPlaceholder = 'Default one-shot model',
  providerFilter,
  modelFilter,
  onChange,
}: ProviderModelPickerProps) {
  const provider = (engine || autoProvider || activeProvider) as EngineId;
  const providerOptions = PROVIDER_CATALOG
    .filter((p) => p.implemented)
    .filter((p) => providerFilter ? providerFilter(p.id, providerCaps[p.id]) : true);
  const rawModels = providerCaps[provider]?.models ?? PROVIDER_CATALOG.find((p) => p.id === provider)?.models ?? [];
  const models = modelFilter ? rawModels.filter((m) => modelFilter(m, provider, providerCaps[provider])) : rawModels;
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
      <select
        value={model ?? ''}
        title="Model used by this plugin"
        onChange={(e) => onChange({ engine: engine || undefined, model: e.target.value || undefined })}
      >
        <option value="">{modelPlaceholder}</option>
        {models.map((m) => <option key={m.value} value={m.value}>{m.label ?? m.value}</option>)}
      </select>
    </div>
  );
}
