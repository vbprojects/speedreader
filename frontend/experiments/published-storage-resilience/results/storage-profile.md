# SugarCube storage transport profile

Generated 2026-11-27T16:09:26.077Z on v24.22.3 (linux/x64); 25 measured iterations after 3 warmups. These are container measurements, not mobile device results.

Synthetic JSON-only save objects; fixture lz-string 1.5.0 for two cases; deterministic xorshift32 Base64 payloads. Logical bytes use 64-byte entry + UTF-16 accounting, not physical disk/clone measurements. Gzip of exact UTF-16LE bytes is an experiment only. Node single-process timing is not an iOS/mobile benchmark.

| Synthetic workload | Full logical bytes | Selected wire bytes | Wire reduction | Patch encode median ms | Gzip median ms | Gzip / full UTF-16 bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-json-small-early-edit | 2,137,138 | 126 | 99.99% | 2.647 | 32.277 | 37.08% |
| raw-json-history-insertion | 2,137,382 | 368 | 99.98% | 2.277 | 30.840 | 37.08% |
| fixture-lz-utf16-early-edit | 823,788 | 823,788 | 0.00% | 0.003 | 19.651 | 96.97% |
| fixture-lz-utf16-history-append | 823,436 | 148 | 99.98% | 1.416 | 19.050 | 95.35% |
| base64-complete-replacement | 2,000,092 | 2,000,092 | 0.00% | 0.002 | 37.915 | 47.04% |
| base64-small-middle-edit | 1,653,428 | 140 | 99.99% | 2.318 | 28.675 | 47.05% |

## Decision

Ship bounded prefix/suffix patches only when saving at least 25% and 1 KiB on a value of at least 16,384 code units. Preserve full-value fallback for unrelated or insufficiently correlated saves. Do not ship gzip or a general binary-diff engine: they add CPU, working memory and decoder attack surface; collect representative device traces first. Database rows remain full opaque values; patches only reduce transport cloning.

The compressed early-edit case deliberately changes a field before the large stable payload; prefix/suffix correlation may disappear even though the uncompressed state changed only slightly. The compressed append case probes the opposite extreme. Their contrast is why selection is per changed value, never a claim that all SugarCube saves benefit. Unchanged keys are omitted entirely in both designs.

Exact UTF-16 round trips (including separate regression coverage for lone surrogates) and area caps apply before reconstruction. There is no unbounded patch chain: the parent decodes against the one matching sequence/revision snapshot and persists the complete value atomically. No gzip decoder or binary compression dependency enters the runtime.

## Reproduce

From the patched repository frontend directory:

```sh
node --import tsx experiments/sugarcube-runtime-spike/storage-profile.mts experiments/sugarcube-runtime-spike/fixture-current.html ../benchmarks/storage-profile.json
```

The JSON contains SHA-256 digests, p50/p95 encode, decode, clone, gzip and gunzip timings, and exact input sizes. The fixture is pinned by commit and hash; the script evaluates only its isolated vendor LZString routine. Memory/disk reductions beyond the bounded wire payload are not measured. Real iOS profiling should record main-thread stalls, energy use, peak memory and process kills with representative user-consented saves before enabling additional codecs.

Sources inspected: the repository fixture at frontend/experiments/sugarcube-runtime-spike/fixture-current.html, at the commit and SHA-256 listed in JSON; [WHATWG Storage interface](https://html.spec.whatwg.org/multipage/webstorage.html#storage).
