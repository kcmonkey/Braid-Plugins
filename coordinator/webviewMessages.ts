import type { PluginManifest, WebviewMessageContext, WebviewMessagePlugin, WebviewMessageResult } from '../../../src/plugin-api/types';
import type { WebviewMessage } from '../../../src/protocol';
import manifestJson from './plugin.json';

export const manifest = manifestJson as PluginManifest;

export type CoordinatorWebviewMessage =
  | Extract<WebviewMessage, { type: 'coordinationIntent' }>
  | Extract<WebviewMessage, { type: 'coordinationMessage' }>
  | Extract<WebviewMessage, { type: 'coordinationResourceClaim' }>
  | Extract<WebviewMessage, { type: 'coordinationNegotiate' }>
  | Extract<WebviewMessage, { type: 'coordinationRelease' }>
  | Extract<WebviewMessage, { type: 'coordinationWait' }>
  | Extract<WebviewMessage, { type: 'coordinationOverride' }>;

const COORDINATOR_MESSAGE_TYPES = new Set<string>([
  'coordinationIntent',
  'coordinationMessage',
  'coordinationResourceClaim',
  'coordinationNegotiate',
  'coordinationRelease',
  'coordinationWait',
  'coordinationOverride',
]);

export type CoordinatorWebviewMessageHandler = (
  ctx: WebviewMessageContext<CoordinatorWebviewMessage>,
) => WebviewMessageResult | Promise<WebviewMessageResult>;

export function createCoordinatorWebviewMessages(handle: CoordinatorWebviewMessageHandler): WebviewMessagePlugin<WebviewMessage> {
  return {
    id: 'coordinator.webviewMessages',
    label: 'Coordinator Webview Messages',
    manifest,
    handleMessage(ctx) {
      if (!COORDINATOR_MESSAGE_TYPES.has(ctx.message.type)) return null;
      return handle(ctx as WebviewMessageContext<CoordinatorWebviewMessage>);
    },
  };
}
