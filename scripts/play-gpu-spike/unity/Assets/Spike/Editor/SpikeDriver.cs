using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Genio.Play;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Genio.Spike.Editor
{
    /// <summary>
    /// Drives one run per request file written by the consumer: <project>/spike/request.json. Sets the Game view size,
    /// enters Play, starts com.genio.play's StreamSession against the consumer's socket as Genio does (with Genio's
    /// process id for the GPU stream, without it for JPEG), stops after the run and writes
    /// <project>/spike/result-<id>.json (frame times, editor facts, the package's warnings). A 'session' request during a
    /// run starts a new session at a new size, as Genio's resize does.
    /// </summary>
    [InitializeOnLoad]
    static class SpikeDriver
    {
        [Serializable] class Request { public string id; public string mode; public int port; public string token; public int pid; public int w = 1280, h = 720; public float seconds = 15; public string apis; }
        static readonly string Dir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "spike"));
        static string handled;
        static Request run;
        static double started, warmed, nextPoll;
        static bool startedSession;
        static TimeSpan cpu0;
        static readonly List<string> warnings = new List<string>();

        static SpikeDriver()
        {
            // Import workers run [InitializeOnLoad] too (on Unity's default API, D3D12): only the editor drives runs.
            if (AssetDatabase.IsAssetImportWorkerProcess()) return;
            EditorApplication.update += Tick;
            Application.logMessageReceivedThreaded += (text, _stack, type) => { if (type != LogType.Log && text.StartsWith("Genio Play")) lock (warnings) warnings.Add(text); };
            Directory.CreateDirectory(Dir);
            handled = SessionState.GetString("Genio.Spike.Handled", "");
            // Entering Play reloads the domain: the run in progress survives in SessionState.
            var saved = SessionState.GetString("Genio.Spike.Run", "");
            if (saved != "") { run = JsonUtility.FromJson<Request>(saved); started = EditorApplication.timeSinceStartup; }
            Event($"loaded device={SystemInfo.graphicsDeviceType} '{SystemInfo.graphicsDeviceVersion}' mt={SystemInfo.graphicsMultiThreaded} playing={EditorApplication.isPlaying} windowsApis={string.Join(",", PlayerSettings.GetGraphicsAPIs(BuildTarget.StandaloneWindows64))} automatic={PlayerSettings.GetUseDefaultGraphicsAPIs(BuildTarget.StandaloneWindows64)}");
        }

        static void Event(string s) { try { File.AppendAllText(Path.Combine(Dir, "editor-events.log"), $"{DateTime.UtcNow:o} {s}\n"); } catch { } }

        static Request Next()
        {
            var file = Path.Combine(Dir, "request.json");
            if (!File.Exists(file)) return null;
            Request r;
            try { r = JsonUtility.FromJson<Request>(File.ReadAllText(file)); } catch { return null; }
            if (r == null || string.IsNullOrEmpty(r.id) || r.id == handled) return null;
            handled = r.id; SessionState.SetString("Genio.Spike.Handled", handled);
            return r;
        }

        static void Tick()
        {
            double now = EditorApplication.timeSinceStartup;
            Request r = null;
            if (now >= nextPoll) { nextPoll = now + 0.1; r = Next(); }
            if (r != null && r.mode == "quit") { Event("quit"); EditorApplication.Exit(0); return; }
            if (run == null)
            {
                if (r == null) return;
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
                if (r.mode != "gpu" && r.mode != "jpeg") return;
                run = r; startedSession = false; started = now; warmed = 0;
                lock (warnings) warnings.Clear();
                SessionState.SetString("Genio.Spike.Run", JsonUtility.ToJson(r));
                Event($"request {r.id} {r.mode} {r.w}x{r.h} {r.seconds}s");
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
                try { Start(run.port, run.token, run.w, run.h, run.mode == "gpu" ? run.pid : 0); }
                catch (Exception e) { Finish("start: " + e.Message); }
                return;
            }
            // Genio's resize: a new session at the new size, on a new socket.
            if (r != null && r.mode == "session")
            {
                PlayModeWindow.SetCustomRenderingResolution((uint)r.w, (uint)r.h, "Genio Spike");
                try { Start(r.port, r.token, r.w, r.h, r.pid); } catch (Exception e) { Event("session failed: " + e.Message); }
                Event($"session {r.w}x{r.h} at frame {Time.frameCount}");
            }
            if (now - started >= run.seconds + 3) Finish(null);
        }

        static void Start(int port, string token, int w, int h, int pid)
        {
            StreamSession.StartStream(port, token, w, h, pid);
            Event($"started {(pid > 0 ? "gpu" : "jpeg")} {w}x{h} screen={Screen.width}x{Screen.height}");
        }

        static void Finish(string error)
        {
            var r = run; run = null;
            SessionState.EraseString("Genio.Spike.Run");
            double wall = EditorApplication.timeSinceStartup - started;
            var cpuMs = (Process.GetCurrentProcess().TotalProcessorTime - cpu0).TotalMilliseconds;
            StreamSession.StopStream();
            var scene = SpikeScene.Instance;
            if (scene != null) scene.Logging = false;
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            Func<double, string> f = v => v.ToString("0.###", inv);
            Func<string, string> q = s => s == null ? "null" : "\"" + s.Replace("\\", "\\\\").Replace("\"", "'").Replace("\n", " ").Replace("\r", "") + "\"";
            var sb = new StringBuilder();
            sb.Append("{\"id\":\"").Append(r.id).Append("\",\"mode\":\"").Append(r.mode).Append("\"");
            sb.Append(",\"error\":").Append(q(error));
            lock (warnings) sb.Append(",\"warnings\":[").Append(string.Join(",", warnings.Select(q))).Append("]");
            sb.Append(",\"unity\":\"").Append(Application.unityVersion).Append("\",\"device\":\"").Append(SystemInfo.graphicsDeviceType).Append("\",\"deviceVersion\":\"").Append(SystemInfo.graphicsDeviceVersion).Append("\",\"gpu\":\"").Append(SystemInfo.graphicsDeviceName).Append("\"");
            sb.Append(",\"renderThread\":").Append(SystemInfo.graphicsMultiThreaded ? "true" : "false");
            sb.Append(",\"pid\":").Append(Process.GetCurrentProcess().Id);
            sb.Append(",\"screen\":[").Append(Screen.width).Append(",").Append(Screen.height).Append("]");
            sb.Append(",\"wallMs\":").Append(f(wall * 1000)).Append(",\"editorCpuMs\":").Append(f(cpuMs));
            sb.Append(",\"frames\":[");
            if (scene != null) for (int i = 0; i < scene.LogCount; i++) { if (i > 0) sb.Append(','); sb.Append('[').Append(scene.LogFrames[i]).Append(',').Append(f(scene.LogT0[i])).Append(']'); }
            sb.Append("]}");
            File.WriteAllText(Path.Combine(Dir, "result-" + r.id + ".json"), sb.ToString());
            Event($"finished {r.id} error={error ?? "none"}");
        }
    }
}
