import React, { useEffect, useState } from 'react';
import type { ArtifactRendererPlugin, BoardPluginApi, PluginManifest } from '../../../src/plugin-api/types';
import type { ArtifactPayloadResourceResult, ArtifactRef } from '../../../src/protocol';
import manifestJson from './plugin.json';
import { VIDEO_DATA_TYPE } from './artifactType';

const manifest = manifestJson as PluginManifest;

type ResourceState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; resource: ArtifactPayloadResourceResult }
  | { status: 'error'; message: string };

function VideoArtifactPreview({
  artifact,
  api,
  compact,
}: {
  artifact: ArtifactRef;
  api: BoardPluginApi;
  compact: boolean;
}) {
  const [state, setState] = useState<ResourceState>({ status: compact ? 'idle' : 'loading' });

  useEffect(() => {
    let alive = true;
    if (compact) {
      setState({ status: 'idle' });
      return () => { alive = false; };
    }
    setState({ status: 'loading' });
    void api.getArtifactPayloadResource(artifact).then((resource) => {
      if (!alive) return;
      if (resource.error) setState({ status: 'error', message: resource.error });
      else setState({ status: 'ready', resource: { ...resource, requestId: '' } });
    }, (error: any) => {
      if (!alive) return;
      setState({ status: 'error', message: error?.message || 'Video resource unavailable' });
    });
    return () => { alive = false; };
  }, [api, artifact.id, artifact.version, artifact.mime, compact]);

  const open = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    api.openArtifactPayloadLocation(artifact);
  };
  const title = artifact.label || `${artifact.dataType}@v${artifact.version}`;

  if (compact) {
    return (
      <div className="video-artifact-preview video-artifact-preview--compact" aria-label={`Video artifact ${title}`}>
        <div className="video-artifact-preview__glyph">VIDEO</div>
        <div className="video-artifact-preview__meta" title={title}>{title}</div>
      </div>
    );
  }

  const resource = state.status === 'ready' ? state.resource : undefined;
  const canPlay = !!resource?.url;

  return (
    <div className={`video-artifact-preview video-artifact-preview--turn is-${state.status}`} aria-label={`Video artifact ${title}`}>
      <div className="video-artifact-preview__stage">
        {canPlay ? (
          <video
            className="video-artifact-preview__player"
            controls
            preload="metadata"
            src={resource.url}
            title={title}
          />
        ) : (
          <div className="video-artifact-preview__fallback">
            {state.status === 'loading' ? 'Loading video' : state.status === 'error' ? state.message : 'Video preview unavailable'}
          </div>
        )}
      </div>
      <div className="video-artifact-preview__bar">
        <div className="video-artifact-preview__label" title={title}>{title}</div>
        <button type="button" className="video-artifact-preview__open" onClick={open}>Open externally</button>
      </div>
    </div>
  );
}

export const videoArtifactRenderer: ArtifactRendererPlugin<Record<string, never>> = {
  id: 'video-artifacts.video-renderer',
  label: 'Video Renderer',
  manifest,
  defaultConfig: {},
  dataType: VIDEO_DATA_TYPE,
  matches: (artifact) => artifact.dataType === VIDEO_DATA_TYPE,
  render: ({ artifact, api, compact }) => <VideoArtifactPreview artifact={artifact} api={api} compact={compact} />,
};
