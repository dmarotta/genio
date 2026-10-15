using System;
using UnityEditor;
using Unity.Pipeline.Commands;
using System.Reflection;

namespace Genio.Play.Editor
{
    [InitializeOnLoad]
    public static class Commands
    {
        static double next;
        static readonly MethodInfo SignalTick = typeof(EditorApplication).GetMethod("SignalTick", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        static Commands()
        {
            AssemblyReloadEvents.beforeAssemblyReload += () => StreamSession.StopStream();
            EditorApplication.quitting += () => StreamSession.StopStream();
            EditorApplication.pauseStateChanged += state => { if (state == PauseState.Paused) StreamSession.ReleaseInput?.Invoke(); };
            // The spike proved forced ticks keep an unfocused Editor running. Only our
            // temporary streaming object opts in; no Pipeline autotick setting is changed.
            EditorApplication.update += () =>
            {
                if (!EditorApplication.isPlaying || EditorApplication.isPaused || EditorApplication.timeSinceStartup < next) return;
                if (!StreamSession.Active) return;
                next = EditorApplication.timeSinceStartup + 0.016;
                if (SignalTick != null) SignalTick.Invoke(null, null);
                else EditorApplication.QueuePlayerLoopUpdate();
            };
        }
        [CliCommand("genio_sync_begin", "Suspend imports while Genio mirrors its player copy", MainThreadRequired = true)]
        public static string SyncBegin()
        {
            if (EditorApplication.isPlaying || EditorApplication.isCompiling) throw new InvalidOperationException("Stop Play and wait for compilation first");
            if (!SessionState.GetBool("Genio.Play.Sync", false))
            {
                AssetDatabase.DisallowAutoRefresh();
                SessionState.SetBool("Genio.Play.Sync", true);
            }
            return "Suspended";
        }
        [CliCommand("genio_sync_end", "Resume imports and refresh Genio's player copy", MainThreadRequired = true)]
        public static string SyncEnd()
        {
            if (SessionState.GetBool("Genio.Play.Sync", false))
            {
                SessionState.SetBool("Genio.Play.Sync", false);
                AssetDatabase.AllowAutoRefresh();
            }
            AssetDatabase.Refresh();
            return "Refreshing";
        }
        [CliCommand("genio_step", "Advance one paused frame", MainThreadRequired = true)]
        public static string Step()
        {
            if (!EditorApplication.isPlaying || !EditorApplication.isPaused) throw new InvalidOperationException("Pause Play Mode first");
            StreamSession.CaptureStep();
            EditorApplication.Step(); return "Stepped";
        }
        [CliCommand("genio_set_resolution", "Set Game view rendering resolution", MainThreadRequired = true)]
        public static string Resolution(int width, int height)
        {
            if (width < 16 || height < 16 || width > 3840 || height > 3840) throw new ArgumentException("Resolution must be 16–3840");
            PlayModeWindow.SetCustomRenderingResolution((uint)width, (uint)height, "Genio Play");
            return "Resolution set";
        }
    }
}
