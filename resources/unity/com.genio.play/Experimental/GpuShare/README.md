# Experimental: GPU-shared Play stream (spike)

StreamSession's frames as D3D11 shared textures instead of JPEGs, from C# only (no native plugin). Proven in a real Unity 6000.5.1f1 editor with `-force-d3d11` against the Recon's Electron consumer; results, the fallback rule and what step 2 still has to do are in [docs/play-gpu-stream.md](../../../../../docs/play-gpu-stream.md).

Inert: the `Genio.Play.GpuShare` assembly compiles only with the `GENIO_PLAY_GPU_SHARE` scripting define, which Genio never sets, so player copies are unchanged. Nothing in Genio calls it yet.

- `D3D11Ring.cs`: a ring of shared textures on the device behind `RenderTexture.GetNativeTexturePtr()`; `CopyResource`, then an `ID3D11Fence` signal (or an event query without `ID3D11Device5`); NT handles duplicated into Genio's main process and closed there on `Dispose`.
- `GpuStreamSession.cs`: the session on StreamSession's loopback socket and token. Binary `'G' 'R'` (ring: size, LUID, flags, handles) once per ring, `'G' 'F'` (gen, slot, frame, end-of-frame and GPU-done times) per frame; Genio answers `{"type":"free","gen":g,"slot":s}`. Copies on the main thread, or through `GL.IssuePluginEvent` when Unity has a render thread.
