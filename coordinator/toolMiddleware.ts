import type { PluginManifest, ToolMiddlewareContext, ToolMiddlewarePlugin, ToolMiddlewareResult } from '../../../src/plugin-api/types';
import manifestJson from './plugin.json';

export type CoordinatorToolMiddlewareHandlers = {
  gate(ctx: ToolMiddlewareContext): ToolMiddlewareResult | Promise<ToolMiddlewareResult>;
  observe(ctx: ToolMiddlewareContext): void | Promise<void>;
};

export const manifest = manifestJson as PluginManifest;

export function createCoordinatorToolMiddleware(handlers: CoordinatorToolMiddlewareHandlers): ToolMiddlewarePlugin {
  return {
    id: 'coordinator.toolMiddleware',
    label: 'Coordinator Tool Middleware',
    manifest,
    gateToolUse(ctx) {
      return handlers.gate(ctx);
    },
    observeToolUse(ctx) {
      return handlers.observe(ctx);
    },
  };
}
