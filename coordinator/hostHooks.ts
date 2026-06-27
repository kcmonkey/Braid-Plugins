import type {
  HostProjectStatePlugin,
  LiveMessagePlugin,
  PluginManifest,
  TurnContextContext,
  TurnContextPlugin,
} from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

export function createCoordinatorProjectState<T>(getState: () => T): HostProjectStatePlugin<T> {
  return {
    id: 'coordinator.projectState',
    label: 'Coordinator Project State',
    manifest,
    getState,
  };
}

export function createCoordinatorTurnContext(provide: (ctx: TurnContextContext) => string | null | undefined): TurnContextPlugin {
  return {
    id: 'coordinator.turnContext',
    label: 'Coordinator Turn Context',
    manifest,
    provideTurnContext: provide,
  };
}

export function createCoordinatorLiveMessages(): LiveMessagePlugin {
  return {
    id: 'coordinator.liveMessages',
    label: 'Coordinator Live Messages',
    manifest,
  };
}
