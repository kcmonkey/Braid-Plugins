import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ArtifactRendererPlugin, BoardPluginApi, PluginManifest } from '../../../src/plugin-api/types';
import type { ArtifactRef } from '../../../src/protocol';
import manifestJson from './plugin.json';
import { MODEL_3D_DATA_TYPE } from './artifactType';

const manifest = manifestJson as PluginManifest;

type PreviewStatus = 'loading' | 'ready' | 'error';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose?.();
    } else {
      material?.dispose?.();
    }
  });
}

async function readArtifactArrayBuffer(api: BoardPluginApi, artifact: ArtifactRef): Promise<ArrayBuffer> {
  const result = await api.readArtifactPayload(artifact);
  if (result.error) throw new Error(result.error);
  if (result.base64) return base64ToArrayBuffer(result.base64);
  if (result.dataUrl) {
    const comma = result.dataUrl.indexOf(',');
    if (comma >= 0) return base64ToArrayBuffer(result.dataUrl.slice(comma + 1));
  }
  throw new Error('Artifact payload did not include binary bytes.');
}

// Load the GLB for preview. Prefer the host resource URL (the browser streams the file — no base64 payload resident
// in host or webview memory); fall back to the base64 payload only when the host cannot mint a URL. (ADR-24)
async function loadModelGltf(api: BoardPluginApi, artifact: ArtifactRef): Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>> {
  const resource = await api.getArtifactPayloadResource(artifact).catch(() => null);
  if (resource?.url && !resource.error) return await new GLTFLoader().loadAsync(resource.url);
  const buffer = await readArtifactArrayBuffer(api, artifact);
  return await new Promise<Awaited<ReturnType<GLTFLoader['parseAsync']>>>((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
}

function fitCameraToObject(camera: THREE.PerspectiveCamera, object: THREE.Object3D, controls: OrbitControls, width: number, height: number): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = Math.max(maxDim / (2 * Math.tan(fov / 2)), maxDim * 1.4);
  camera.aspect = Math.max(width, 1) / Math.max(height, 1);
  camera.position.set(center.x + distance * 0.7, center.y + distance * 0.45, center.z + distance);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function Model3dArtifactPreview({
  artifact,
  api,
  compact,
}: {
  artifact: ArtifactRef;
  api: BoardPluginApi;
  compact: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<PreviewStatus>('loading');
  const [message, setMessage] = useState('Loading model');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let disposed = false;
    let frame = 0;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let sceneRoot: THREE.Object3D | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const cleanup = () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      controls?.dispose();
      if (sceneRoot) disposeObject(sceneRoot);
      renderer?.forceContextLoss?.();
      renderer?.dispose();
      mount.replaceChildren();
    };

    const run = async () => {
      try {
        setStatus('loading');
        setMessage('Loading model');
        const gltf = await loadModelGltf(api, artifact);
        if (disposed) return;
        const width = Math.max(mount.clientWidth || (compact ? 180 : 420), 80);
        const height = Math.max(mount.clientHeight || (compact ? 74 : 220), 60);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x171716);
        const camera = new THREE.PerspectiveCamera(38, width / height, 0.01, 1000);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.domElement.className = 'model3d-preview__canvas';
        mount.replaceChildren(renderer.domElement);

        const hemi = new THREE.HemisphereLight(0xf8f5e8, 0x242424, 1.6);
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 4, 5);
        scene.add(hemi, key);
        sceneRoot = gltf.scene;
        scene.add(sceneRoot);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.enablePan = false;
        controls.autoRotate = !compact;
        controls.autoRotateSpeed = 1.4;
        fitCameraToObject(camera, sceneRoot, controls, width, height);

        const resize = () => {
          if (!renderer || !controls || disposed) return;
          const nextWidth = Math.max(mount.clientWidth || width, 80);
          const nextHeight = Math.max(mount.clientHeight || height, 60);
          renderer.setSize(nextWidth, nextHeight);
          fitCameraToObject(camera, sceneRoot!, controls, nextWidth, nextHeight);
          if (compact) renderer.render(scene, camera);
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(mount);

        const animate = () => {
          if (disposed || !renderer || !controls) return;
          controls.update();
          renderer.render(scene, camera);
          frame = requestAnimationFrame(animate);
        };
        setStatus('ready');
        setMessage('3D model preview');
        if (compact) {
          controls.update();
          renderer.render(scene, camera);
        } else {
          animate();
        }
      } catch (error: any) {
        if (disposed) return;
        setStatus('error');
        setMessage(error?.message || 'Model preview unavailable');
        mount.replaceChildren();
      }
    };
    void run();
    return cleanup;
  }, [api, artifact.id, artifact.version, artifact.mime, compact]);

  return (
    <div className={`model3d-preview ${compact ? 'model3d-preview--compact' : 'model3d-preview--turn'} is-${status}`} aria-label={message}>
      <div ref={mountRef} className="model3d-preview__stage" data-status={status} />
      {!compact ? (
        <div className="model3d-preview__caption">
          <span>3D Model</span>
          <strong title={artifact.label}>{artifact.label}</strong>
        </div>
      ) : null}
      {status !== 'ready' ? <div className="model3d-preview__state">{message}</div> : null}
    </div>
  );
}

export const model3dArtifactRenderer: ArtifactRendererPlugin<Record<string, never>> = {
  id: 'model-artifacts.model-3d-renderer',
  label: '3D Model Renderer',
  manifest,
  defaultConfig: {},
  dataType: MODEL_3D_DATA_TYPE,
  matches: (artifact) => artifact.dataType === MODEL_3D_DATA_TYPE,
  render: ({ artifact, api, compact }) => <Model3dArtifactPreview artifact={artifact} api={api} compact={compact} />,
};
