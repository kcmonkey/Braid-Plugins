# Optional local semantic recall

Memory defaults to its existing lexical search. An explicit `semantic: "configured"`
recall can use the installed local E5-small q8 model below. No recall installs a
package, downloads a model, contacts a hosted embedding API, or enables billing.
The paths refer to the machine running the Braid daemon, for both standalone and
VS Code clients.

This is an optional evidence-discovery route. It preserves the first genuine
lexical hit within the eligible corpus, then combines focused lexical search and
dense candidates with RRF (k=10, depth=50, weights 1:2). It does not certify that a
memory is true or that its conditions apply. Use `memory_get` and recheck sources.

## Install the local components explicitly

Choose a directory outside the project and install the inference runtime there:

```powershell
npm install --prefix C:/BraidModels/e5-runtime @huggingface/transformers@4.3.0
```

4.3.0 was the npm latest stable release checked on 2026-09-29, and is the tested
runtime version. It brings `onnxruntime-node@1.30.0`. The runtime is optional and
is not added to Braid's package dependencies. Install a trusted, complete package;
`runtimePath` is a code-loading location, not a model name or remote URL.

Place the following five files from
[Xenova/multilingual-e5-small, revision 761b726](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78)
in `C:/BraidModels/multilingual-e5-small` (preserving the `onnx` subdirectory):

| File | SHA-256 |
| --- | --- |
| `config.json` | `cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1` |
| `tokenizer_config.json` | `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b` |
| `special_tokens_map.json` | `d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7` |
| `tokenizer.json` | `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` |
| `onnx/model_quantized.onnx` | `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193` |

The model files total 135,392,183 bytes, excluding the runtime. Braid verifies
these hashes before loading. Replacing files in place while the model is loaded
invalidates the source; subsequent configured calls report a reason and keep
lexical retrieval available. Use a separate directory for another installation.
This first adapter supports this exact evaluated model/runtime; it does not yet
offer arbitrary models or a third-party embedding endpoint.

## Configure through existing plugin state

Merge this Memory entry into the project's existing `.braid/plugins.json` without
replacing other plugin entries. Paths must be absolute:

```json
{
  "version": 1,
  "plugins": {
    "memory": {
      "__braidPluginState": 1,
      "enabled": true,
      "config": {
        "mode": "local-e5",
        "cache": "session",
        "runtimePath": "C:/BraidModels/e5-runtime/node_modules/@huggingface/transformers",
        "modelPath": "C:/BraidModels/multilingual-e5-small"
      }
    }
  }
}
```

The same entry can be provided through the existing user plugin configuration;
project config overrides the user config object. `modelFingerprint` from the old
experimental seam is not a model identity override: the real source reports the
verified model revision, quantization, runtime and text representation.

Call `memory_recall` with `{"query":"...", "semantic":"configured"}` to use
it. Omitting `semantic`, passing `"off"`, or configuring `mode: "off"` preserves
the existing lexical behavior. Only `status: current` records in the requested
exact scope are eligible for hybrid recall; an unknown scope returns zero hybrid
candidates. The lexical path retains its existing recency fallback semantics.
Missing/corrupt components, the retired `local-experimental` mode and
`cache: "project"` produce a visible unavailable reason with lexical candidates.

## Cache, latency and lifecycle

The source stores only disposable vectors in the Memory service session. Artifact
Memory remains the record authority. There is **no persistent project vector
index**: restarting the daemon/service requires rebuilding on the next configured
query. No automatic background preparation runs.

Documents use title, `Scope: ...`, `Tags: ...`, recall cue and full content joined
by newlines; evidence/locators are excluded from encoding. The tokenizer creates
non-overlapping 448-token chunks, decoded with a `passage: ` prefix. Queries use
`query: `. Every encoded string must fit 512 tokens; oversized input reports a
fallback reason instead of silently truncating tokens. Mean pooling, L2
normalization and max chunk cosine match the evaluated route. CPU inference uses
two intra-op threads and one inter-op thread.

The existing MemoryIndexCache also reuses lexical/current/scope search buckets
bound to the canonical corpus revision; capturing the cache token before reading
the snapshot prevents an older snapshot from being mislabeled with a concurrent
writer's newer token.
Content hashes avoid re-encoding unchanged documents. Usage telemetry does not
invalidate vectors. Scope changes search/encode only eligible records while
retaining vectors for other still-current records; removed or non-current IDs
are pruned on the next configured query. A scope/text change is re-encoded when
that record next participates. Configuration is reread at admission and after
inference. Configuration changes take effect at the next recall (there is no
configuration watcher); `mode: off` then retires the model asynchronously without
blocking the lexical call. Service shutdown also releases it.

Configured queries serialize through the existing Memory source queue. Off and
default queries bypass that queue. Cancellation is checked between native calls
and chunks; an already executing ONNX call must finish before its resources can
be released. Changed corpus/configuration discards the late semantic result and
returns fresh lexical candidates with a notice. Drain closes admission and waits
for work. Failed native cleanup remains observable and prevents a new allocation;
drain/dispose cannot claim successful release while that failure remains.

On the final Windows i9-13900KS/Node 22.17 integration run with 1,114 frozen
records, the first configured production recall took 101.80 seconds to load and
index the model corpus. Fifteen subsequent queries had a median of 146.95 ms and
p95/max of 184.60 ms. Before lexical-index reuse the corresponding warm median
was 1,010.42 ms. The final test process peaked at 939.93 MiB RSS, including its
canonical store, lexical index, model and test harness; this is not a model-only
resident-memory budget. These are local observations, not latency guarantees.
Session restart still incurs the cold indexing cost. Native allocator RSS need
not immediately shrink on disposal. See the
[final verification report](../../../docs/verification/memory-local-e5-root-validation-20260929.md)
for raw evidence, the cold-start measurement boundary and untested surfaces.

Hybrid output preserves every selected candidate's complete ID, order and source
within 4,000 characters (up to 10 candidates), sharing the remaining budget among
short title/body excerpts. Full evidence is available with `memory_get`. The
default/off output format is unchanged.

## Reproduce focused verification

```powershell
npx vitest run plugins/builtin/memory
$env:BRAID_MEMORY_E5_RUNTIME = 'C:/BraidModels/e5-runtime/node_modules/@huggingface/transformers'
$env:BRAID_MEMORY_E5_MODEL = 'C:/BraidModels/multilingual-e5-small'
npx vitest run plugins/builtin/memory/localE5.integration.test.ts
```

The real-model test skips unless both paths are set. It never downloads anything
and denies `fetch`. It uses six temporary canonical records by default;
`BRAID_MEMORY_E5_CORPUS` may name a JSON object containing a `records` array for a
larger local run. `BRAID_MEMORY_E5_EVIDENCE` may name an output JSON file in an
existing temporary directory. Instrumentation forwards real prepare, inference
and disposal calls unchanged; it is separate from the controlled failure fixtures
in `localE5.test.ts` and `service.test.ts`.
