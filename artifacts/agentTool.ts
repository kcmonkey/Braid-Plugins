import type { AgentToolContext, AgentToolPlugin, PluginManifest } from '../../../src/plugin-api/types';
import type { AgentToolResult } from '../../../src/engine/types';
import manifestJson from './plugin.json';

export interface ArtifactDeclareToolRequest {
  dataType?: string;
  label?: string;
  text?: string;
  path?: string;
  storageMode?: string;
  mime?: string;
  attachToTurn?: boolean;
}

export interface ArtifactTypesToolRequest {
  dataType?: string;
}

export interface ArtifactExpectToolRequest {
  dataType?: string;
  nothing?: boolean;
  invalidNothingFalse?: boolean;
  reason?: string;
}

export interface ArtifactToolHandlers {
  declare(ctx: AgentToolContext, req: ArtifactDeclareToolRequest): Promise<AgentToolResult>;
  expect(ctx: AgentToolContext, req: ArtifactExpectToolRequest): Promise<AgentToolResult>;
  types(ctx: AgentToolContext, req: ArtifactTypesToolRequest): Promise<AgentToolResult>;
}

export const manifest = manifestJson as PluginManifest;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function normalizeArtifactDeclareArgs(input: Record<string, unknown>): ArtifactDeclareToolRequest {
  return {
    dataType: stringValue(input.dataType),
    label: stringValue(input.label),
    text: stringValue(input.text),
    path: stringValue(input.path),
    storageMode: stringValue(input.storageMode),
    mime: stringValue(input.mime),
    attachToTurn: input.attachToTurn === true,
  };
}

export function normalizeArtifactTypesArgs(input: Record<string, unknown>): ArtifactTypesToolRequest {
  return {
    dataType: stringValue(input.dataType),
  };
}

export function normalizeArtifactExpectArgs(input: Record<string, unknown>): ArtifactExpectToolRequest {
  return {
    dataType: stringValue(input.dataType),
    nothing: input.nothing === true,
    invalidNothingFalse: input.nothing === false,
    reason: stringValue(input.reason),
  };
}

export function createArtifactAgentTools(handlers: ArtifactToolHandlers, options?: {
  typeSummary?: string;
}): AgentToolPlugin<Record<string, unknown>>[] {
  const typeSummary = options?.typeSummary?.trim();
  return [
    {
      id: 'artifacts.declare',
      label: 'Declare Artifact',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'artifact_declare',
        description: [
          'Declare a reusable project-local Braid artifact.',
          'Use text for a declared text artifact, or path with storageMode "external-ref" for a live workspace reference / "born" for an immutable snapshot.',
          'dataType is optional; omit it when no specific artifact type fits, and Braid will use the Meta root type.',
          ...(typeSummary ? [typeSummary] : []),
          'When the user asks for a durable, bounded, presentable deliverable such as a spec, report, protocol, handoff, mockup, review, dataset, generated media, or a standalone runnable demo or entrypoint, declare it as an artifact so other boards can display and pass it by ref.',
          'Do not declare source files edited as implementation work, scratch files, build outputs, test logs, transient control messages, or ordinary conversation context just because they exist. A user-requested standalone runnable demo or entrypoint is not excluded merely because it is code.',
          'Optional: mime. Artifacts go through the Braid registry and can attach to the current turn.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['label'],
          properties: {
            dataType: { type: 'string', description: 'Open payload type used by artifact pins, such as spec, plan, report, or note. Optional; omission defaults to the Meta root type.' },
            label: { type: 'string', description: 'Human-readable artifact label.' },
            text: { type: 'string', description: 'Text payload for a declared artifact. Do not combine with path.' },
            path: { type: 'string', description: 'Workspace-relative or workspace-contained path to declare as an artifact. Requires storageMode.' },
            storageMode: { type: 'string', description: 'For path declarations: external-ref keeps a live workspace reference; born snapshots the current file bytes into the artifact registry.' },
            mime: { type: 'string', description: 'Payload MIME type. Text defaults to text/markdown; live references default to text/plain; snapshots default to application/octet-stream.' },
            attachToTurn: { type: 'boolean', description: 'When true, also attach the artifact to the current turn as a board output.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.declare(ctx, normalizeArtifactDeclareArgs(input));
      },
    },
    {
      id: 'artifacts.expect',
      label: 'Expect Artifact',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'artifact_expect',
        description: [
          'Declare the latest expectation for whether the current turn should produce a user-facing artifact; this is not an artifact declaration.',
          'Pass dataType (for example "report", "mockup", or "meta") to expect a user-facing artifact from this turn, or nothing:true after deciding this turn should produce no user-facing artifact.',
          'A redundant nothing:false alongside dataType is accepted and ignored; nothing:true together with dataType is contradictory and rejected.',
          'Use dataType when your current agent judgment is that this turn should produce an artifact, then use braid.artifact_declare with attachToTurn:true to actually declare and attach the artifact output.',
          'Use expect nothing (nothing:true) only after deciding this turn should produce no user-facing artifact. Observed output candidates are context for your agent judgment, not automatic proof that an artifact is required.',
          'You may call this multiple times as your judgment changes; Braid audits the latest expectation.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dataType: { type: 'string', description: 'Artifact dataType expected from this turn, such as report, mockup, spec, dataset, or meta.' },
            nothing: { type: 'boolean', description: 'true when this turn should produce no user-facing artifact. false is redundant when dataType is present and is ignored.' },
            reason: { type: 'string', description: 'Optional short reason for the expectation decision.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.expect(ctx, normalizeArtifactExpectArgs(input));
      },
    },
    {
      id: 'artifacts.types',
      label: 'List Artifact Types',
      manifest,
      tool: {
        namespace: 'braid',
        name: 'artifact_types',
        description: [
          'List defined Braid artifact dataTypes, or fetch detailed guidance/schema for one dataType.',
          'Use this before artifact_declare when a durable output may need to match a registered artifact type.',
          'Omit dataType to get a lightweight list; pass dataType to fetch its detail. Unknown dataTypes resolve through the Meta root type.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dataType: { type: 'string', description: 'Optional artifact dataType to fetch detailed guidance/schema for.' },
          },
        },
      },
      call(ctx, input) {
        return handlers.types(ctx, normalizeArtifactTypesArgs(input));
      },
    },
  ];
}
