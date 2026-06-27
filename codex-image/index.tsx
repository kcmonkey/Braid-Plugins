import React, { useEffect, useState } from 'react';
import type { BoardFormPlugin, BoardPinPlugin, BoardPluginApi, PluginManifest } from '../../../src/plugin-api/types';
import type { EngineId, GeneratedImageArtifact, ImageInput } from '../../../src/protocol';
import { ProviderModelPicker } from '../shared/ProviderModelPicker';
import manifestJson from './plugin.json';

interface CodexImageConfig {
  engine?: EngineId;
  model?: string;
}

interface CodexImageState extends Record<string, unknown> {
  prompt?: string;
  engine?: EngineId;
  model?: string;
  generating?: boolean;
  error?: string;
  artifacts?: GeneratedImageArtifact[];
  text?: string;
  referenceCount?: number;
}

const defaultConfig: CodexImageConfig = {};
const IMAGE_PIN_OFFSET_PCT = 60;

export const manifest = manifestJson as PluginManifest;

export const codexImageBoardPlugin: BoardFormPlugin<CodexImageConfig> = {
  id: 'codex-image',
  label: 'Image board',
  manifest,
  defaultConfig,
  chatView: false,
  create({ activeProvider, providerCaps, config }) {
    const engine = imageGenerationEngine(config.engine ?? activeProvider, providerCaps);
    return {
      ...(engine ? { engine } : {}),
      formState: {
        ...(engine ? { engine } : {}),
        ...(config.model ? { model: config.model } : {}),
      },
    };
  },
  render({ boardId, board, isDetail, activeProvider, providerCaps, config, api }) {
    const engine = imageGenerationEngine((config.engine ?? board.formState?.engine ?? activeProvider) as string, providerCaps);
    const state = imageStateForBoard(board);
    return <ImageBoard boardId={boardId} state={state} engine={engine} model={config.model ?? state.model} api={api} isDetail={isDetail} />;
  },
  renderConfig({ config, onChange, activeProvider, providerCaps }) {
    return (
      <div className="plugin-config plugin-config--image">
        <div className="settings__hint">Creates dedicated image boards. Generation uses the provider's native image-generation capability when available.</div>
        <ProviderModelPicker
          engine={config.engine ?? ''}
          model={config.model}
          autoProvider={imageGenerationEngine(config.engine ?? activeProvider, providerCaps)}
          activeProvider={activeProvider}
          providerCaps={providerCaps}
          providerPlaceholder="Auto image provider"
          modelPlaceholder="Default image model"
          providerFilter={supportsImageGeneration}
          modelFilter={supportsImageGenerationModel}
          onChange={(next) => onChange({ ...config, ...next })}
        />
      </div>
    );
  },
};

export const codexImagePinPlugin: BoardPinPlugin<CodexImageConfig> = {
  id: 'codex-image',
  label: 'Image pins',
  manifest,
  defaultConfig,
  pins({ board }) {
    const state = imageState(board.formState);
    if (board.boardForm === 'codex-image' && !board.archived && !board.compact && !board.collapsedGraph) {
      return [
        ...(state.artifacts?.length ? [{
          id: 'generated-image',
          kind: 'source' as const,
          dataType: 'image',
          position: 'right' as const,
          offsetPct: IMAGE_PIN_OFFSET_PCT,
          title: 'Generated image',
          className: 'board-pin-handle--image board-pin-handle--image-output',
        }] : []),
        {
          id: 'image-input',
          kind: 'target' as const,
          accepts: ['image'],
          multiple: true,
          position: 'left' as const,
          offsetPct: IMAGE_PIN_OFFSET_PCT,
          title: 'Reference image inputs',
          className: 'board-pin-handle--image board-pin-handle--image-input',
        },
      ];
    }
    if (!board.boardForm && !board.compact && !board.collapsedGraph && !board.archived) {
      return [{
        id: 'image-input',
        kind: 'target' as const,
        accepts: ['image'],
        multiple: true,
        position: 'left' as const,
        offsetPct: IMAGE_PIN_OFFSET_PCT,
        title: 'Image inputs',
        className: 'board-pin-handle--image board-pin-handle--image-input',
      }];
    }
    return [];
  },
  async collectInput({ sourceBoard, api }) {
    const artifact = latestArtifact(imageStateForBoard(sourceBoard).artifacts);
    if (!artifact?.path) return undefined;
    const read = await api.readArtifact(artifact.path);
    if (read.error || !read.base64 || !read.mime) return undefined;
    return { images: [{ mediaType: read.mime, data: read.base64 }] };
  },
  renderConfig: codexImageBoardPlugin.renderConfig,
};

function ImageBoard({ boardId, state, engine, model, api, isDetail }: { boardId: string; state: CodexImageState; engine?: EngineId; model?: string; api: BoardPluginApi; isDetail: boolean }) {
  const [prompt, setPrompt] = useState(state.prompt ?? '');
  useEffect(() => { setPrompt(state.prompt ?? ''); }, [state.prompt]);
  const artifacts = state.artifacts ?? [];
  if (!isDetail) return <ImageBoardPreview state={state} api={api} />;
  const canGenerate = !!engine && !!prompt.trim() && !state.generating;
  const generate = async () => {
    const text = prompt.trim();
    if (!text || !engine) return;
    const priorImages = await artifactInputs(latestArtifact(artifacts) ? [latestArtifact(artifacts)!] : [], api);
    const next: CodexImageState = { ...state, prompt: text, engine, model, generating: true, error: undefined, text: undefined, referenceCount: priorImages.length };
    api.patchBoard(boardId, { prompt: text, answer: '', status: 'streaming', formState: next });
    const result = await api.generateImage(boardId, text, { engine, model, images: priorImages });
    const done: CodexImageState = {
      ...next,
      generating: false,
      artifacts: result.artifacts,
      text: result.text,
      error: result.error,
      referenceCount: result.inputImageCount ?? priorImages.length,
    };
    api.patchBoard(boardId, {
      answer: result.text || result.error || '',
      status: result.error ? 'error' : 'done',
      completedAt: Date.now(),
      formState: done,
    });
  };
  return (
    <div className="plugin-image-board nodrag nopan">
      <div className="plugin-image-board__compose">
        <textarea
          value={prompt}
          placeholder={engine ? 'Describe the image to generate...' : 'No provider with image generation is available'}
          disabled={!engine || state.generating}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void generate();
            }
          }}
        />
        <div className="plugin-image-board__bar">
          <span className={`plugin-image-board__engine${engine ? '' : ' muted'}`}>
            {engine ? `Generate with ${engine}${artifacts.length ? ' - current image will be used as reference' : ' - connect image pins for references'}` : 'imageGeneration unavailable'}
          </span>
          <button className="primary-btn" type="button" disabled={!canGenerate} onClick={() => void generate()}>
            {state.generating ? 'Generating...' : artifacts.length ? 'Modify image' : 'Generate'}
          </button>
        </div>
      </div>
      {state.error ? <div className="plugin-image-board__error">{state.error}</div> : null}
      {state.text && !artifacts.length ? <div className="plugin-image-board__text">{state.text}</div> : null}
      {state.referenceCount ? <div className="plugin-image-board__text">{state.referenceCount} reference image{state.referenceCount === 1 ? '' : 's'} included.</div> : null}
      {state.generating && !artifacts.length ? <div className="plugin-image-placeholder">Generating image...</div> : null}
      {artifacts.length ? (
        <div className="plugin-image-artifacts plugin-image-artifacts--board">
          {artifacts.map((a) => <ImageArtifact key={a.path} artifact={a} api={api} />)}
        </div>
      ) : null}
    </div>
  );
}

function ImageBoardPreview({ state, api }: { state: CodexImageState; api: BoardPluginApi }) {
  const artifact = latestArtifact(state.artifacts);
  const label = state.generating ? 'Generating image...' : state.prompt || artifact?.prompt || 'Image board';
  return (
    <div className="plugin-image-board plugin-image-board--compact">
      <div className="plugin-image-thumb">
        {artifact ? <ArtifactImage artifact={artifact} api={api} /> : <div className="plugin-image-placeholder">{state.generating ? 'Generating...' : 'No image yet'}</div>}
      </div>
      <div className="plugin-image-board__compactmeta" title={label}>{label}</div>
    </div>
  );
}

function ImageArtifact({ artifact, api }: { artifact: GeneratedImageArtifact; api: BoardPluginApi }) {
  return (
    <div className="plugin-image-card plugin-image-card--board">
      <ArtifactImage artifact={artifact} api={api} />
      <div className="plugin-image-meta">
        <span title={artifact.path}>{artifact.prompt || 'Generated image'}</span>
        <button
          className="ghost-btn plugin-image-open nodrag nopan"
          type="button"
          title={`Open location: ${artifact.path}`}
          onClick={(e) => {
            e.stopPropagation();
            api.openArtifactLocation(artifact.path);
          }}
        >
          Open location
        </button>
      </div>
    </div>
  );
}

function ArtifactImage({ artifact, api }: { artifact: GeneratedImageArtifact; api: BoardPluginApi }) {
  const [state, setState] = useState<{ dataUrl?: string; base64?: string; mime?: string; error?: string }>({});
  useEffect(() => {
    let alive = true;
    api.readArtifact(artifact.path).then((r) => {
      if (alive) setState(r.error ? { error: r.error } : { dataUrl: r.dataUrl, base64: r.base64, mime: r.mime });
    });
    return () => { alive = false; };
  }, [api, artifact.path]);
  return state.dataUrl ? <img src={state.dataUrl} alt={artifact.prompt || 'Generated image'} /> : <div className="plugin-image-placeholder">{state.error || 'Loading generated image...'}</div>;
}

function imageState(raw: unknown): CodexImageState {
  return raw && typeof raw === 'object' ? raw as CodexImageState : {};
}

function imageStateForBoard(board: { status?: string; answer?: string; formState?: unknown }): CodexImageState {
  const state = imageState(board.formState);
  if (!state.generating || board.status === 'streaming') return state;
  const interrupted = typeof board.answer === 'string' && board.answer.trim() ? board.answer.trim() : 'Image generation was interrupted.';
  return { ...state, generating: false, error: state.error ?? interrupted };
}

function latestArtifact(artifacts: GeneratedImageArtifact[] | undefined): GeneratedImageArtifact | undefined {
  return artifacts?.[artifacts.length - 1];
}

async function artifactInputs(artifacts: GeneratedImageArtifact[], api: BoardPluginApi): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const artifact of artifacts) {
    if (!artifact.path) continue;
    const read = await api.readArtifact(artifact.path);
    if (!read.error && read.base64 && read.mime) out.push({ mediaType: read.mime, data: read.base64 });
  }
  return out;
}

function imageGenerationEngine(preferred: string, providerCaps: Partial<Record<string, { imageGeneration?: boolean }>>): EngineId | undefined {
  if (providerCaps[preferred]?.imageGeneration) return preferred as EngineId;
  return Object.entries(providerCaps).find(([, caps]) => caps?.imageGeneration)?.[0] as EngineId | undefined;
}

function supportsImageGeneration(_provider: EngineId, caps: { imageGeneration?: boolean } | undefined): boolean {
  return caps?.imageGeneration === true;
}

function supportsImageGenerationModel(model: { imageGeneration?: boolean }): boolean {
  return model.imageGeneration === true;
}
