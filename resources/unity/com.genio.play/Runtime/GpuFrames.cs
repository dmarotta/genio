using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Rendering;

namespace Genio.Play
{
    /// A StreamSession's fast path: each captured frame is copied on the GPU into a ring of D3D11 textures shared into
    /// Genio's main process, and only small binary messages travel on the session's socket: 'GR' once per ring (size,
    /// adapter, handles) and 'GF' per finished frame. Genio frees a slot with {"type":"free","gen":g,"slot":s} once its
    /// renderer let go of it. When anything fails the session sends 'GX' and goes on with JPEG frames.
    sealed class GpuFrames : IDisposable
    {
        public const int Slots = 3;
        /// 'GX' reasons: the editor does not render with Direct3D 11, the ring could not be made, a copy failed.
        public const byte NotD3D11 = 1, RingFailed = 2, CopyFailed = 3;
        const float Fps = 60, ReclaimSeconds = 2;
        static readonly Regex FreeMessage = new Regex("^\\{\"type\":\"free\",\"gen\":(\\d{1,9}),\"slot\":(\\d)\\}$");

        readonly StreamSession session;
        readonly D3D11Ring ring;
        readonly int gen;
        readonly bool renderThread;
        readonly object gate = new object();
        readonly bool[] busy = new bool[Slots];
        readonly float[] busySince = new float[Slots];
        readonly Queue<Job> ready = new Queue<Job>();
        readonly SemaphoreSlim readyCount = new SemaphoreSlim(0);
        readonly CancellationTokenSource stop = new CancellationTokenSource();
        Task ringSent;
        int nextSlot;
        float next;
        volatile bool disposed;
        struct Job { public int Slot, Frame; public double T0; }

        GpuFrames(StreamSession session, D3D11Ring ring, int gen)
        {
            this.session = session; this.ring = ring; this.gen = gen;
            renderThread = SystemInfo.graphicsMultiThreaded;
        }

        /// The fast path for a session's stream texture, or null with a 'GX' reason when this editor cannot run it.
        public static GpuFrames Start(StreamSession session, RenderTexture target, int genioPid, out byte code, out string reason)
        {
            code = 0; reason = null;
            if (SystemInfo.graphicsDeviceType != GraphicsDeviceType.Direct3D11) { code = NotD3D11; reason = "the editor renders with " + SystemInfo.graphicsDeviceType; return null; }
            var ring = D3D11Ring.Create(target.GetNativeTexturePtr(), genioPid, Slots, out reason);
            if (ring == null) { code = RingFailed; return null; }
            var frames = new GpuFrames(session, ring, 1);
            frames.ringSent = session.Send(frames.RingMessage());
            var token = frames.stop.Token;
            Task.Run(() => frames.Sender(token));
            return frames;
        }

        /// Any thread: Genio's renderer let go of a slot.
        public bool Free(string text)
        {
            var m = FreeMessage.Match(text);
            if (!m.Success) return false;
            int g = int.Parse(m.Groups[1].Value), slot = int.Parse(m.Groups[2].Value);
            if (g == gen && slot < Slots) lock (gate) busy[slot] = false;
            return true;
        }

        /// End of frame, main thread. grab fills target with the frame; false ends the fast path, with the reason.
        public bool Capture(bool stepped, RenderTexture target, Action grab, out string reason)
        {
            reason = null;
            double t0 = D3D11Ring.NowMs();
            float interval = 1f / Fps, now = Time.realtimeSinceStartup;
            if (!stepped && now < next - interval * 0.25f) return true;
            if (!stepped) next = next + interval < now ? now + interval : next + interval;
            int slot = Take(now);
            // Every slot is still on Genio's side: skip this frame rather than wait.
            if (slot < 0) return true;
            grab();
            var job = new Job { Slot = slot, Frame = Time.frameCount, T0 = t0 };
            try { Copy(job, target.GetNativeTexturePtr()); }
            catch (Exception e) { reason = "copy: " + e.Message; return false; }
            return true;
        }

        /// A free slot, or one Genio held past ReclaimSeconds (a lost free must not stall the stream); -1 when none.
        int Take(float now)
        {
            lock (gate)
            {
                for (int k = 0; k < Slots; k++)
                {
                    int s = (nextSlot + k) % Slots;
                    if (busy[s] && now - busySince[s] < ReclaimSeconds) continue;
                    busy[s] = true; busySince[s] = now; nextSlot = (s + 1) % Slots;
                    return s;
                }
            }
            return -1;
        }

        // ---- the copy, on the thread that owns Unity's immediate context
        delegate void RenderEvent(int eventId);
        static readonly RenderEvent onRenderEvent = OnRenderEvent;
        static readonly IntPtr renderEventPtr = Marshal.GetFunctionPointerForDelegate(onRenderEvent);
        static readonly Job[] renderJobs = new Job[64];
        static readonly IntPtr[] renderSources = new IntPtr[64];
        static readonly GpuFrames[] renderOwners = new GpuFrames[64];
        static int renderJobSeq;

        void Copy(Job job, IntPtr source)
        {
            if (!renderThread) { Submit(job, source); return; }
            // With a render thread the immediate context belongs to it: run the copy there, after Unity's queued Blit.
            int id = Interlocked.Increment(ref renderJobSeq) & 63;
            renderJobs[id] = job; renderSources[id] = source; renderOwners[id] = this;
            GL.IssuePluginEvent(renderEventPtr, id);
        }
        [AOT.MonoPInvokeCallback(typeof(RenderEvent))]
        static void OnRenderEvent(int id)
        {
            var owner = renderOwners[id];
            if (owner == null || owner.disposed) return;
            try { owner.Submit(renderJobs[id], renderSources[id]); } catch (Exception) { /* the sender frees the slot after its wait */ }
        }
        void Submit(Job job, IntPtr source)
        {
            ring.Copy(source, job.Slot);
            lock (ready) ready.Enqueue(job);
            readyCount.Release();
        }

        /// Worker thread: waits for each copy's GPU completion, then announces the frame. The game never waits.
        async Task Sender(CancellationToken token)
        {
            var message = new byte[32];
            try
            {
                await ringSent;
                while (!token.IsCancellationRequested)
                {
                    await readyCount.WaitAsync(token);
                    Job job; lock (ready) job = ready.Dequeue();
                    if (!ring.Done[job.Slot].WaitOne(1000) || disposed) { lock (gate) busy[job.Slot] = false; continue; }
                    double done = D3D11Ring.NowMs();
                    // 'G' 'F' v1: slot u8, gen u32, frame u32, reserved u32, end of frame f64 and GPU done f64 (Unix ms).
                    message[0] = (byte)'G'; message[1] = (byte)'F'; message[2] = 1; message[3] = (byte)job.Slot;
                    Put(message, 4, (uint)gen); Put(message, 8, (uint)job.Frame); Put(message, 12, 0u);
                    Put(message, 16, job.T0); Put(message, 24, done);
                    await session.Send(new ArraySegment<byte>(message));
                }
            }
            catch (Exception) { /* the session ended */ }
        }

        // 'G' 'R' v2: slot count u8, gen u32, width u32, height u32, adapter LUID (low u32, high i32), DXGI format u32,
        // flags u32 (none: after CaptureScreenshotIntoRenderTexture and Blit the first row is the top of the picture),
        // adapter PCI vendor u32 and device u32, then one u64 NT handle per slot, valid in Genio's main process.
        ArraySegment<byte> RingMessage()
        {
            var m = new byte[40 + 8 * Slots];
            m[0] = (byte)'G'; m[1] = (byte)'R'; m[2] = 2; m[3] = Slots;
            Put(m, 4, (uint)gen); Put(m, 8, (uint)ring.Width); Put(m, 12, (uint)ring.Height);
            Put(m, 16, (uint)(ring.AdapterLuid & 0xffffffff)); Put(m, 20, (uint)(ring.AdapterLuid >> 32));
            Put(m, 24, 28u); Put(m, 28, 0u); Put(m, 32, (uint)ring.VendorId); Put(m, 36, (uint)ring.DeviceId);
            for (int s = 0; s < Slots; s++) { long h = ring.Handles[s]; Put(m, 40 + 8 * s, (uint)(h & 0xffffffff)); Put(m, 44 + 8 * s, (uint)(h >> 32)); }
            return new ArraySegment<byte>(m);
        }
        /// 'G' 'X' v1: the fast path ended on Unity's side, with a reason code; JPEG frames follow.
        public static ArraySegment<byte> EndMessage(byte code) { return new ArraySegment<byte>(new byte[] { (byte)'G', (byte)'X', 1, code }); }
        static void Put(byte[] b, int at, uint v) { b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); b[at + 2] = (byte)(v >> 16); b[at + 3] = (byte)(v >> 24); }
        static void Put(byte[] b, int at, double v) { var bits = BitConverter.DoubleToInt64Bits(v); Put(b, at, (uint)(bits & 0xffffffff)); Put(b, at + 4, (uint)(bits >> 32)); }

        /// Main thread. Closes the ring's handles in Genio; what Genio already imported stays valid there until released.
        public void Dispose()
        {
            if (disposed) return;
            disposed = true; stop.Cancel();
            ring.Dispose();
        }
    }
}
