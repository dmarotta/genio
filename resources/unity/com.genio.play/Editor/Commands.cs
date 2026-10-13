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
        [CliCommand("genio_step", "Advance one paused frame", MainThreadRequired = true)]
        public static string Step()
        {
            if (!EditorApplication.isPlaying || !EditorApplication.isPaused) throw new InvalidOperationException("Pause Play Mode first");
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
