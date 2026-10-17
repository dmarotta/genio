using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

namespace Genio.Spike.Boot
{
    /// <summary>Turns on the experimental assembly's define (GENIO_PLAY_GPU_SHARE) in this scratch project only; Unity recompiles once.</summary>
    [InitializeOnLoad]
    static class SpikeBoot
    {
        const string Define = "GENIO_PLAY_GPU_SHARE";
        static SpikeBoot()
        {
            if (AssetDatabase.IsAssetImportWorkerProcess()) return;
            var dir = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "spike"));
            Directory.CreateDirectory(dir);
            var target = NamedBuildTarget.Standalone;
            var defines = PlayerSettings.GetScriptingDefineSymbols(target);
            bool has = Array.IndexOf(defines.Split(';'), Define) >= 0;
            File.AppendAllText(Path.Combine(dir, "editor-events.log"), $"{DateTime.UtcNow:o} boot define={(has ? "on" : "adding")} device={SystemInfo.graphicsDeviceType}\n");
            if (!has) PlayerSettings.SetScriptingDefineSymbols(target, defines.Length == 0 ? Define : defines + ";" + Define);
        }
    }
}
