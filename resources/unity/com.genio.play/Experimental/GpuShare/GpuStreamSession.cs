using System;
using System.Collections;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using Unity.Pipeline.Commands;

namespace Genio.Play.GpuShare
{
    /// <summary>
    /// Experimental (spike): StreamSession's frames as D3D11 shared textures instead of JPEGs. Same loopback socket and
    /// token; each captured frame is copied on the GPU into a ring of 3 shared textures, and only small binary messages
    /// travel: 'GR' once per ring (size and handles), 'GF' per finished frame. Genio frees a slot with a text message
    /// {"type":"free","gen":g,"slot":s} once its renderer let go of it. Any failure ends the session with a reason, so
    /// the caller can fall back to StreamSession.
    /// </summary>
    public sealed class GpuStreamSession : MonoBehaviour
    {
        public const int Slots = 3;
        static GpuStreamSession current;
        public static bool Active => current != null;
        /// <summary>Why the last session ended or could not start; null while it runs or after a clean stop.</summary>
        public static string LastError { get; private set; }
        public static readonly SessionStats Stats = new SessionStats();

        ClientWebSocket socket;
        CancellationTokenSource cancel;
        readonly SemaphoreSlim sending = new SemaphoreSlim(1, 1);
        readonly object gate = new object();
        readonly Queue<Pending> ready = new Queue<Pending>();
        readonly SemaphoreSlim readyCount = new SemaphoreSlim(0);
        readonly List<Ring> retired = new List<Ring>();
        RenderTexture target, screen;
        Ring ring;
        int genioPid, width, height, gen, fps, nextSlot;
        bool oldBackground;

        sealed class Ring { public D3D11Ring Share; public int Gen; public readonly bool[] Busy = new bool[Slots]; public float RetiredAt; }
        struct Pending { public Ring Ring; public int Slot, Frame; public double T0, TSubmit; }

        public sealed class SessionStats
        {
            public int Rings, Frames, Sent, SkippedNoSlot, Freed;
            public double RingCreateMs, CaptureMs, CopyMs, GpuMs, RingMessageAt;
            public bool Fence, RenderThread, BottomUp;
            public long AdapterLuid;
            public string Device;
            public void Reset() { Rings = Frames = Sent = SkippedNoSlot = Freed = 0; RingCreateMs = CaptureMs = CopyMs = GpuMs = RingMessageAt = 0; }
        }

        [CliCommand("genio_gpu_stream_start", "Experimental: Genio's local video session through shared D3D11 textures", MainThreadRequired = true)]
        public static string StartStream(int port, string token, int genioPid, int width = 1280, int height = 720, int fps = 60)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first");
            if (port < 1 || port > 65535 || token == null || !Regex.IsMatch(token, "^[a-f0-9]{64}$") || genioPid <= 0) throw new ArgumentException("Invalid local session");
            if (width < 16 || height < 16 || width > 1920 || height > 1920) throw new ArgumentException("Stream dimensions must be 16–1920");
            if (fps < 1 || fps > 120) throw new ArgumentException("fps must be 1–120");
            // Only Unity's D3D11 device can feed the ring; anything else is the JPEG stream's job.
            if (SystemInfo.graphicsDeviceType != GraphicsDeviceType.Direct3D11) throw new InvalidOperationException("The editor renders with " + SystemInfo.graphicsDeviceType + ", not Direct3D11");
            StopStream();
            LastError = null; Stats.Reset();
            var go = new GameObject("Genio Play GPU (temporary)") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            current = go.AddComponent<GpuStreamSession>();
            current.genioPid = genioPid; current.width = width; current.height = height; current.fps = fps;
            current.oldBackground = Application.runInBackground;
            Application.runInBackground = true;
            current.cancel = new CancellationTokenSource();
            current.socket = new ClientWebSocket();
            current.socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            current.Connect(port);
            return "Connecting";
        }

        [CliCommand("genio_gpu_stream_stop", "Experimental: end the shared-texture session", MainThreadRequired = true)]
        public static string StopStream()
        {
            if (current != null) { var previous = current; current = null; previous.Cleanup(); Destroy(previous.gameObject); }
            return "Stopped";
        }

        /// <summary>A new stream size: the next frame goes into a new ring; the old one is closed once Genio frees it.</summary>
        public static void Resize(int width, int height)
        {
            if (current == null) return;
            if (width < 16 || height < 16 || width > 1920 || height > 1920) throw new ArgumentException("Stream dimensions must be 16–1920");
            current.width = width; current.height = height;
        }

        async void Connect(int port)
        {
            try
            {
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel.Token))
                {
                    timeout.CancelAfter(5000);
                    await socket.ConnectAsync(new Uri("ws://127.0.0.1:" + port + "/play"), timeout.Token);
                }
                if (this == null || cancel.IsCancellationRequested) return;
                Stats.RenderThread = SystemInfo.graphicsMultiThreaded;
                StartCoroutine(Capture());
                var token = cancel.Token; var connection = socket;
                _ = Task.Run(() => Sender(connection, token));
                var buffer = new byte[8192];
                while (!cancel.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancel.Token);
                    if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) break;
                    OnText(Encoding.UTF8.GetString(buffer, 0, result.Count));
                }
            }
            catch (Exception) { /* No credentials or URLs in logs; disconnect is expected on reload. */ }
            finally { if (this != null) { Cleanup(); Destroy(gameObject); } }
        }

        static readonly Regex FreeMessage = new Regex("^\\{\"type\":\"free\",\"gen\":(\\d+),\"slot\":(\\d+)\\}$");
        void OnText(string text)
        {
            var m = FreeMessage.Match(text);
            if (!m.Success) return;  // Input stays StreamSession's in this spike.
            int g = int.Parse(m.Groups[1].Value), slot = int.Parse(m.Groups[2].Value);
            if (slot < 0 || slot >= Slots) return;
            lock (gate)
            {
                Ring r = ring != null && ring.Gen == g ? ring : retired.Find(x => x.Gen == g);
                if (r != null && r.Busy[slot]) { r.Busy[slot] = false; Stats.Freed++; }
            }
        }

        IEnumerator Capture()
        {
            var endOfFrame = new WaitForEndOfFrame();
            float next = 0;
            while (socket != null && socket.State == WebSocketState.Open)
            {
                yield return endOfFrame;
                double t0 = D3D11Ring.NowMs();
                float interval = 1f / fps, now = Time.realtimeSinceStartup;
                if (now < next - interval * 0.25f) continue;
                next = next + interval < now ? now + interval : next + interval;
                CloseRetired(false);
                Stats.Frames++;
                if (!EnsureRing()) { yield break; }
                int slot = -1;
                lock (gate) { for (int k = 0; k < Slots; k++) { int s = (nextSlot + k) % Slots; if (!ring.Busy[s]) { slot = s; break; } } if (slot >= 0) { ring.Busy[slot] = true; nextSlot = (slot + 1) % Slots; } }
                if (slot < 0) { Stats.SkippedNoSlot++; continue; }
                double c0 = D3D11Ring.NowMs();
                if (screen == null || screen.width != Screen.width || screen.height != Screen.height)
                {
                    if (screen != null) Destroy(screen);
                    screen = new RenderTexture(Screen.width, Screen.height, 0, GraphicsFormat.R8G8B8A8_UNorm);
                    screen.Create();
                }
                ScreenCapture.CaptureScreenshotIntoRenderTexture(screen);
                Graphics.Blit(screen, target);
                double c1 = D3D11Ring.NowMs();
                var job = new Pending { Ring = ring, Slot = slot, Frame = Time.frameCount, T0 = t0 };
                try { CopyNow(job); }
                catch (Exception e) { Fail("copy: " + e.Message); yield break; }
                double c2 = D3D11Ring.NowMs();
                Stats.CaptureMs += c1 - c0; Stats.CopyMs += c2 - c1;
            }
        }

        /// <summary>The ring matching the current size, made on first use and after a resize; false ends the session.</summary>
        bool EnsureRing()
        {
            if (ring != null && target != null && target.width == width && target.height == height) return true;
            if (target != null) Destroy(target);
            target = new RenderTexture(width, height, 0, GraphicsFormat.R8G8B8A8_UNorm);
            target.Create();
            double t = D3D11Ring.NowMs();
            string error;
            var share = D3D11Ring.Create(target.GetNativeTexturePtr(), genioPid, Slots, out error);
            if (share == null) { Fail(error); return false; }
            Stats.RingCreateMs += D3D11Ring.NowMs() - t; Stats.Rings++;
            Stats.Fence = share.HasFence; Stats.AdapterLuid = share.AdapterLuid; Stats.Device = SystemInfo.graphicsDeviceVersion;
            lock (gate)
            {
                if (ring != null) { ring.RetiredAt = Time.realtimeSinceStartup; retired.Add(ring); }
                ring = new Ring { Share = share, Gen = ++gen };
            }
            _ = Send(RingMessage(ring));
            Stats.RingMessageAt = D3D11Ring.NowMs();
            return true;
        }

        /// <summary>A retired ring's handles close once Genio freed all of its slots, or after 2 s whatever it says.</summary>
        void CloseRetired(bool all)
        {
            lock (gate)
            {
                for (int i = retired.Count - 1; i >= 0; i--)
                {
                    var r = retired[i];
                    if (!all && Array.IndexOf(r.Busy, true) >= 0 && Time.realtimeSinceStartup - r.RetiredAt < 2f) continue;
                    r.Share.Dispose(); retired.RemoveAt(i);
                }
            }
        }

        // ---- the copy, on the thread that owns Unity's immediate context
        delegate void RenderEvent(int eventId);
        static readonly RenderEvent onRenderEvent = OnRenderEvent;
        static readonly IntPtr renderEventPtr = Marshal.GetFunctionPointerForDelegate(onRenderEvent);
        static readonly Pending[] renderJobs = new Pending[64];
        static readonly IntPtr[] renderSources = new IntPtr[64];
        static int renderJobSeq;

        void CopyNow(Pending job)
        {
            var source = target.GetNativeTexturePtr();
            if (!Stats.RenderThread) { Submit(job, source); return; }
            // With a render thread the immediate context belongs to it: run the copy there, after Unity's queued Blit.
            int id = Interlocked.Increment(ref renderJobSeq) & 63;
            renderJobs[id] = job; renderSources[id] = source;
            GL.IssuePluginEvent(renderEventPtr, id);
        }
        [AOT.MonoPInvokeCallback(typeof(RenderEvent))]
        static void OnRenderEvent(int id)
        {
            var session = current;
            if (session == null) return;
            try { session.Submit(renderJobs[id], renderSources[id]); } catch (Exception) { /* the sender times the slot out */ }
        }
        void Submit(Pending job, IntPtr source)
        {
            job.Ring.Share.Copy(source, job.Slot);
            job.TSubmit = D3D11Ring.NowMs();
            lock (ready) ready.Enqueue(job);
            readyCount.Release();
        }

        /// <summary>Worker thread: waits for each copy's GPU completion, then announces the frame. The game never waits.</summary>
        async Task Sender(ClientWebSocket connection, CancellationToken token)
        {
            var message = new byte[32];
            try
            {
                while (!token.IsCancellationRequested)
                {
                    await readyCount.WaitAsync(token);
                    Pending job; lock (ready) job = ready.Dequeue();
                    var share = job.Ring.Share;
                    if (!share.HasFence) while (!share.Done[job.Slot].WaitOne(0)) { if (token.IsCancellationRequested) return; await Task.Delay(1); }
                    else if (!share.Done[job.Slot].WaitOne(1000)) { lock (gate) job.Ring.Busy[job.Slot] = false; continue; }
                    double tReady = D3D11Ring.NowMs();
                    Stats.GpuMs += tReady - job.TSubmit;
                    message[0] = (byte)'G'; message[1] = (byte)'F'; message[2] = 1; message[3] = (byte)job.Slot;
                    WriteU32(message, 4, (uint)job.Ring.Gen); WriteU32(message, 8, (uint)job.Frame); WriteU32(message, 12, 0);
                    WriteF64(message, 16, job.T0); WriteF64(message, 24, tReady);
                    await Send(new ArraySegment<byte>(message), connection);
                    Stats.Sent++;
                }
            }
            catch (Exception) { }
        }

        // 'G' 'R' v1: slot count, gen u32, width u32, height u32, adapter LUID (low u32, high i32), DXGI format u32,
        // flags u32 (bit 0: rows bottom-up; measured off on D3D11: after CaptureScreenshotIntoRenderTexture and Blit the stream
        // texture's first row is the top of the picture), then one u64 NT handle per slot.
        static ArraySegment<byte> RingMessage(Ring r)
        {
            var m = new byte[32 + 8 * Slots];
            m[0] = (byte)'G'; m[1] = (byte)'R'; m[2] = 1; m[3] = Slots;
            WriteU32(m, 4, (uint)r.Gen); WriteU32(m, 8, (uint)r.Share.Width); WriteU32(m, 12, (uint)r.Share.Height);
            WriteU32(m, 16, (uint)(r.Share.AdapterLuid & 0xffffffff)); WriteU32(m, 20, (uint)(r.Share.AdapterLuid >> 32));
            WriteU32(m, 24, 28); WriteU32(m, 28, Stats.BottomUp ? 1u : 0u);
            for (int s = 0; s < Slots; s++) { long h = r.Share.Handles[s]; WriteU32(m, 32 + 8 * s, (uint)(h & 0xffffffff)); WriteU32(m, 36 + 8 * s, (uint)(h >> 32)); }
            return new ArraySegment<byte>(m);
        }
        static void WriteU32(byte[] b, int at, uint v) { b[at] = (byte)v; b[at + 1] = (byte)(v >> 8); b[at + 2] = (byte)(v >> 16); b[at + 3] = (byte)(v >> 24); }
        static void WriteF64(byte[] b, int at, double v) { var bits = BitConverter.DoubleToInt64Bits(v); WriteU32(b, at, (uint)(bits & 0xffffffff)); WriteU32(b, at + 4, (uint)(bits >> 32)); }

        Task Send(ArraySegment<byte> bytes) { return Send(bytes, socket); }
        async Task Send(ArraySegment<byte> bytes, ClientWebSocket connection)
        {
            var source = cancel;
            if (connection == null || source == null) return;
            var token = source.Token;
            await sending.WaitAsync(token);
            try { if (connection.State == WebSocketState.Open) await connection.SendAsync(bytes, WebSocketMessageType.Binary, true, token); }
            finally { sending.Release(); }
        }

        void Fail(string reason)
        {
            LastError = reason;
            Debug.LogWarning("Genio Play GPU stream stopped: " + reason);
            if (current == this) StopStream();
        }

        void Cleanup()
        {
            if (cancel == null) return;
            cancel.Cancel(); socket?.Abort(); socket?.Dispose(); socket = null;
            lock (gate) { if (ring != null) { retired.Add(ring); ring = null; } }
            CloseRetired(true);
            if (target != null) { Destroy(target); target = null; }
            if (screen != null) { Destroy(screen); screen = null; }
            Application.runInBackground = oldBackground;
            cancel = null;
            if (current == this) current = null;
        }
        void OnDestroy() { Cleanup(); }
        void OnApplicationQuit() { Cleanup(); }
    }
}
