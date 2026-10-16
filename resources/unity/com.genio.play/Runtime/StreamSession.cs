using System;
using System.Collections;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using Unity.Pipeline.Commands;

namespace Genio.Play
{
    // Inert until an authenticated Pipeline command supplies a loopback session.
    public sealed class StreamSession : MonoBehaviour
    {
        public static Action<string> Input;
        public static Action ReleaseInput;
        /// Set by the optional audio assembly: start the listener tap on a session, and stop it.
        public static Action<StreamSession> StartAudio, StopAudio;
        static StreamSession current;
        public static bool Active => current != null;
        ClientWebSocket socket;
        CancellationTokenSource cancel;
        readonly SemaphoreSlim sending = new SemaphoreSlim(1, 1);
        RenderTexture target;
        RenderTexture screen;
        volatile bool pending;
        bool step;
        string latestInput;
        bool oldBackground;
        float inputAt;
        int width, height;

        [CliCommand("genio_stream_start", "Connect Genio's local video session", MainThreadRequired = true)]
        public static string StartStream(int port, string token, int width = 1280, int height = 720)
        {
            if (!Application.isPlaying) throw new InvalidOperationException("Enter Play Mode first");
            if (port < 1 || port > 65535 || token == null || !System.Text.RegularExpressions.Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new ArgumentException("Invalid local session");
            if (width < 16 || height < 16 || width > 1920 || height > 1920) throw new ArgumentException("Stream dimensions must be 16–1920");
            StopStream();
            var go = new GameObject("Genio Play (temporary)") { hideFlags = HideFlags.HideAndDontSave };
            DontDestroyOnLoad(go);
            current = go.AddComponent<StreamSession>();
            current.width = width; current.height = height;
            current.oldBackground = Application.runInBackground;
            Application.runInBackground = true;
            current.cancel = new CancellationTokenSource();
            current.socket = new ClientWebSocket();
            current.socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            current.Connect(port);
            // At once rather than after the connect, so a resolution swap leaves no gap where the editor sounds.
            StartAudio?.Invoke(current);
            return "Connecting";
        }

        [CliCommand("genio_stream_stop", "Disconnect Genio and release virtual input", MainThreadRequired = true)]
        public static string StopStream()
        {
            if (current != null) { var previous = current; current = null; previous.Cleanup(); Destroy(previous.gameObject); }
            return "Stopped";
        }

        /// The next frame is a paused editor's single step: capture it whatever the cadence, and finish its readback
        /// inside that frame. A paused editor runs no further frame, so a readback left for the next frame would
        /// show each step one step late.
        public static void CaptureStep() { if (current != null) current.step = true; }

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
                target = new RenderTexture(width, height, 0, GraphicsFormat.R8G8B8A8_UNorm);
                target.Create();
                StartCoroutine(Capture());
                var buffer = new byte[8192];
                while (!cancel.IsCancellationRequested && socket.State == WebSocketState.Open)
                {
                    var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancel.Token);
                    if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) break;
                    Interlocked.Exchange(ref latestInput, Encoding.UTF8.GetString(buffer, 0, result.Count));
                }
            }
            catch (Exception) { /* No credentials or URLs in logs; disconnect is expected on reload. */ }
            finally { if (this != null) { Cleanup(); Destroy(gameObject); } }
        }

        IEnumerator Capture()
        {
            var endOfFrame = new WaitForEndOfFrame();
            float next = 0;
            while (socket != null && socket.State == WebSocketState.Open)
            {
                yield return endOfFrame;
                // A fixed 30 fps cadence with a quarter-frame tolerance. Gating on "now + 1/30" skipped every
                // other frame of a 30 fps game whose frames land a hair early (about 20 fps streamed).
                const float interval = 1f / 30f;
                float now = Time.realtimeSinceStartup;
                bool stepped = step; step = false;
                if (target == null || !stepped && (pending || now < next - interval * 0.25f)) continue;
                // After a stall, restart the cadence from now instead of bursting to catch up.
                if (!stepped) next = next + interval < now ? now + interval : next + interval;
                pending = true;
                if (screen == null || screen.width != Screen.width || screen.height != Screen.height)
                {
                    if (screen != null) Destroy(screen);
                    screen = new RenderTexture(Screen.width, Screen.height, 0, GraphicsFormat.R8G8B8A8_UNorm);
                    screen.Create();
                }
                ScreenCapture.CaptureScreenshotIntoRenderTexture(screen);
                Graphics.Blit(screen, target);
                AsyncGPUReadback.Request(target, 0, TextureFormat.RGBA32, request =>
                {
                    if (request.hasError || cancel == null || cancel.IsCancellationRequested) { pending = false; return; }
                    var pixels = request.GetData<byte>().ToArray();
                    var connection = socket;
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            // Readback texture rows use Unity's bottom-left texture origin;
                            // JPEG rows start at the top, irrespective of the GPU UV convention.
                            FlipRows(pixels, width, height);
                            var jpg = ImageConversion.EncodeArrayToJPG(pixels, GraphicsFormat.R8G8B8A8_UNorm, (uint)width, (uint)height, 0, 75);
                            if (jpg.Length <= 4 * 1024 * 1024 && connection.State == WebSocketState.Open)
                                await Send(new ArraySegment<byte>(jpg));
                        }
                        catch (Exception) { }
                        finally { pending = false; }
                    });
                });
                if (stepped) AsyncGPUReadback.WaitAllRequests();
            }
        }
        /// Any thread. One message at a time: ClientWebSocket allows a single outstanding send, and audio and frames
        /// share the socket. Dropped quietly before the connection opens and after it closes.
        public async Task Send(ArraySegment<byte> bytes)
        {
            var connection = socket; var source = cancel;
            if (connection == null || source == null) return;
            var token = source.Token;
            await sending.WaitAsync(token);
            try { if (connection.State == WebSocketState.Open) await connection.SendAsync(bytes, WebSocketMessageType.Binary, true, token); }
            finally { sending.Release(); }
        }
        static void FlipRows(byte[] pixels, int w, int h)
        {
            int stride = w * 4; var row = new byte[stride];
            for (int y = 0; y < h / 2; y++) { int a = y * stride, b = (h - y - 1) * stride; Buffer.BlockCopy(pixels, a, row, 0, stride); Buffer.BlockCopy(pixels, b, pixels, a, stride); Buffer.BlockCopy(row, 0, pixels, b, stride); }
        }
        void Update()
        {
            var json = Interlocked.Exchange(ref latestInput, null);
            if (json != null) { inputAt = Time.realtimeSinceStartup; Input?.Invoke(json); }
            else if (Time.realtimeSinceStartup - inputAt > 0.3f) ReleaseInput?.Invoke();
        }
        void Cleanup()
        {
            if (cancel == null) return;
            cancel.Cancel(); socket?.Abort(); socket?.Dispose(); socket = null;
            StopAudio?.Invoke(this);
            // Readback callbacks may still complete; cancellation fences them before encoding.
            if (target != null) { Destroy(target); target = null; }
            if (screen != null) { Destroy(screen); screen = null; }
            ReleaseInput?.Invoke(); Application.runInBackground = oldBackground;
            cancel = null;
            if (current == this) current = null;
        }
        void OnDestroy() { Cleanup(); }
        void OnApplicationQuit() { Cleanup(); }
    }
}
