using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Genio.Play;
using Genio.Play.GpuShare;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Genio.Spike.Editor
{
    /// <summary>
    /// Drives one spike run per request file written by the consumer: <project>/spike/request.json. Sets the Game view
    /// size, enters Play, starts the GPU or the JPEG session against the consumer's socket, optionally resizes, stops
    /// after the run and writes <project>/spike/result-<id>.json (frame times, session stats, editor facts).
    /// </summary>
    [InitializeOnLoad]
    static class SpikeDriver
    {
        [Serializable] class Request { public string id; public string mode; public int port; public string token; public int pid; public int w = 1280, h = 720, fps = 60; public float seconds = 15, resizeAt; public int resizeW, resizeH; public string apis; }
        static readonly string Dir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "spike"));
        static string handled;
        static Request run;
        static double started, warmed, nextPoll, pumpAt;
        static bool resized, startedSession;
        static TimeSpan cpu0;

        static SpikeDriver()
        {
            // Import workers run [InitializeOnLoad] too (on Unity's default API, D3D12): only the editor drives runs.
            if (AssetDatabase.IsAssetImportWorkerProcess()) return;
            EditorApplication.update += Tick;
            // The same forced ticks Genio.Play.Editor gives StreamSession, for the GPU session too.
            EditorApplication.update += () =>
            {
                if (!EditorApplication.isPlaying || EditorApplication.isPaused || !GpuStreamSession.Active || EditorApplication.timeSinceStartup < pumpAt) return;
                pumpAt = EditorApplication.timeSinceStartup + 0.016;
                EditorApplication.QueuePlayerLoopUpdate();
            };
            Directory.CreateDirectory(Dir);
            handled = SessionState.GetString("Genio.Spike.Handled", "");
            // Entering Play reloads the domain: the run in progress survives in SessionState.
            var saved = SessionState.GetString("Genio.Spike.Run", "");
            if (saved != "") { run = JsonUtility.FromJson<Request>(saved); started = EditorApplication.timeSinceStartup; }
            File.AppendAllText(Path.Combine(Dir, "editor-events.log"), $"{DateTime.UtcNow:o} loaded device={SystemInfo.graphicsDeviceType} '{SystemInfo.graphicsDeviceVersion}' mt={SystemInfo.graphicsMultiThreaded} playing={EditorApplication.isPlaying} windowsApis={string.Join(",", PlayerSettings.GetGraphicsAPIs(BuildTarget.StandaloneWindows64))} automatic={PlayerSettings.GetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64)}\n");
        }

        static void Event(string s) { try { File.AppendAllText(Path.Combine(Dir, "editor-events.log"), $"{DateTime.UtcNow:o} {s}\n"); } catch { } }

        static void Tick()
        {
            double now = EditorApplication.timeSinceStartup;
            if (run == null)
            {
                if (now < nextPoll) return;
                nextPoll = now + 0.25;
                var file = Path.Combine(Dir, "request.json");
                if (!File.Exists(file)) return;
                Request r;
                try { r = JsonUtility.FromJson<Request>(File.ReadAllText(file)); } catch { return; }
                if (r == null || string.IsNullOrEmpty(r.id) || r.id == handled) return;
                handled = r.id; SessionState.SetString("Genio.Spike.Handled", handled);
                if (r.mode == "quit") { Event("quit"); EditorApplication.Exit(0); return; }
                // The Windows graphics API list, as a project that needs DirectX 12 would set it (comma-separated
                // GraphicsDeviceType names; empty = automatic). For checking the fallback rule against the saved asset.
                if (r.mode == "apis")
                {
                    var list = (r.apis ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(n => (UnityEngine.Rendering.GraphicsDeviceType)Enum.Parse(typeof(UnityEngine.Rendering.GraphicsDeviceType), n.Trim())).ToArray();
                    PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64, list.Length == 0);
                    if (list.Length > 0) PlayerSettings.SetGraphicsAPIs(BuildTarget.StandaloneWindows64, list);
                    AssetDatabase.SaveAssets();
                    Event("apis " + string.Join(",", PlayerSettings.GetGraphicsAPIs(BuildTarget.StandaloneWindows64)) + " automatic=" + PlayerSettings.GetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64));
                    return;
                }
                run = r; startedSession = resized = false; started = now; warmed = 0;
                SessionState.SetString("Genio.Spike.Run", JsonUtility.ToJson(r));
                Event($"request {r.id} {r.mode} {r.w}x{r.h}@{r.fps} {r.seconds}s");
                PlayModeWindow.SetCustomRenderingResolution((uint)r.w, (uint)r.h, "Genio Spike");
                if (!EditorApplication.isPlaying) EditorApplication.EnterPlaymode();
                return;
            }
            if (!EditorApplication.isPlaying || SpikeScene.Instance == null) { if (now - started > 120) Finish("never entered Play Mode"); return; }
            if (!startedSession)
            {
                // Let the Game view take the new size before the first frame is captured.
                if (warmed == 0) { warmed = now + 1.0; return; }
                if (now < warmed) return;
                startedSession = true; started = now;
                cpu0 = Process.GetCurrentProcess().TotalProcessorTime;
                SpikeScene.Instance.LogCount = 0; SpikeScene.Instance.Logging = true;
                try
                {
                    if (run.mode == "gpu") GpuStreamSession.StartStream(run.port, run.token, run.pid, run.w, run.h, run.fps);
                    else StreamSession.StartStream(run.port, run.token, run.w, run.h);
                    Event($"started {run.mode} screen={Screen.width}x{Screen.height}");
                }
                catch (Exception e) { Finish("start: " + e.Message); }
                return;
            }
            if (!resized && run.resizeAt > 0 && now - started >= run.resizeAt)
            {
                resized = true;
                PlayModeWindow.SetCustomRenderingResolution((uint)run.resizeW, (uint)run.resizeH, "Genio Spike");
                // As Genio resizes today: the JPEG stream restarts at the new size; the GPU stream swaps rings in place.
                if (run.mode == "gpu") GpuStreamSession.Resize(run.resizeW, run.resizeH);
                else StreamSession.StartStream(run.port, run.token, run.resizeW, run.resizeH);
                Event($"resized to {run.resizeW}x{run.resizeH} at frame {Time.frameCount}");
            }
            if (run.mode == "gpu" && !GpuStreamSession.Active && now - started > 6) { Finish("gpu session ended: " + GpuStreamSession.LastError); return; }
            if (now - started >= run.seconds + 3) Finish(null);
        }

        static void Finish(string error)
        {
            var r = run; run = null;
            SessionState.EraseString("Genio.Spike.Run");
            double wall = EditorApplication.timeSinceStartup - started;
            var cpuMs = (Process.GetCurrentProcess().TotalProcessorTime - cpu0).TotalMilliseconds;
            string lastError = GpuStreamSession.LastError;
            GpuStreamSession.StopStream(); StreamSession.StopStream();
            var scene = SpikeScene.Instance;
            if (scene != null) scene.Logging = false;
            var s = GpuStreamSession.Stats;
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            Func<double, string> f = v => v.ToString("0.###", inv);
            var sb = new StringBuilder();
            sb.Append("{\"id\":\"").Append(r.id).Append("\",\"mode\":\"").Append(r.mode).Append("\"");
            sb.Append(",\"error\":").Append(error == null ? "null" : "\"" + error.Replace("\\", "\\\\").Replace("\"", "'") + "\"");
            sb.Append(",\"sessionError\":").Append(lastError == null ? "null" : "\"" + lastError.Replace("\\", "\\\\").Replace("\"", "'") + "\"");
            sb.Append(",\"unity\":\"").Append(Application.unityVersion).Append("\",\"device\":\"").Append(SystemInfo.graphicsDeviceType).Append("\",\"deviceVersion\":\"").Append(SystemInfo.graphicsDeviceVersion).Append("\",\"gpu\":\"").Append(SystemInfo.graphicsDeviceName).Append("\"");
            sb.Append(",\"renderThread\":").Append(SystemInfo.graphicsMultiThreaded ? "true" : "false");
            sb.Append(",\"runtime\":\"").Append(Environment.Version).Append("\",\"pid\":").Append(Process.GetCurrentProcess().Id);
            sb.Append(",\"screen\":[").Append(Screen.width).Append(",").Append(Screen.height).Append("]");
            sb.Append(",\"wallMs\":").Append(f(wall * 1000)).Append(",\"editorCpuMs\":").Append(f(cpuMs));
            if (r.mode == "gpu")
            {
                int n = Math.Max(1, s.Frames - s.SkippedNoSlot);
                sb.Append(",\"gpu\":{\"rings\":").Append(s.Rings).Append(",\"frames\":").Append(s.Frames).Append(",\"sent\":").Append(s.Sent).Append(",\"skippedNoSlot\":").Append(s.SkippedNoSlot).Append(",\"freed\":").Append(s.Freed);
                sb.Append(",\"fence\":").Append(s.Fence ? "true" : "false").Append(",\"renderThread\":").Append(s.RenderThread ? "true" : "false").Append(",\"adapterLuid\":\"").Append(s.AdapterLuid.ToString("x")).Append("\"");
                sb.Append(",\"ringCreateMsAvg\":").Append(f(s.RingCreateMs / Math.Max(1, s.Rings))).Append(",\"captureBlitMsAvg\":").Append(f(s.CaptureMs / n)).Append(",\"copySignalFlushMsAvg\":").Append(f(s.CopyMs / n)).Append(",\"submitToGpuDoneMsAvg\":").Append(f(s.GpuMs / Math.Max(1, s.Sent))).Append("}");
            }
            sb.Append(",\"frames\":[");
            if (scene != null) for (int i = 0; i < scene.LogCount; i++) { if (i > 0) sb.Append(','); sb.Append('[').Append(scene.LogFrames[i]).Append(',').Append(f(scene.LogT0[i])).Append(']'); }
            sb.Append("]}");
            File.WriteAllText(Path.Combine(Dir, "result-" + r.id + ".json"), sb.ToString());
            Event($"finished {r.id} error={error ?? "none"} session={lastError ?? "none"}");
        }
    }
}
