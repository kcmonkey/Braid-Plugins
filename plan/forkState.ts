import type { BoardForkStatePlugin, PluginManifest } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

interface PlanForkState {
  readonly planId: string;
}

/** Plan owns the exact fork rule: retain only the binding, never run/open state. */
export function inheritPlanStateOnFork(parentState: unknown): PlanForkState | undefined {
  if (!parentState || typeof parentState !== 'object' || Array.isArray(parentState)) return undefined;
  const planId = (parentState as { readonly planId?: unknown }).planId;
  return typeof planId === 'string' && planId.length > 0 ? { planId } : undefined;
}

export const planForkStatePlugin: BoardForkStatePlugin = {
  id: 'plan',
  label: 'Plan',
  manifest: manifestJson as PluginManifest,
  inheritOnFork: inheritPlanStateOnFork,
};
