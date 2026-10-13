using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace Genio.Play
{
    public static class VirtualInput
    {
        [Serializable] class Packet { public string type; public string[] keys; public float x, y; public int buttons; public float[] axes; public int gamepadButtons; }
        static Keyboard keyboard;
        static Mouse mouse;
        static Gamepad pad;
        static Vector2 position;
        static InputSettings originalSettings;
        static InputSettings temporarySettings;
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init()
        {
            Remove();
            StreamSession.Input = Apply;
            StreamSession.ReleaseInput = Remove;
            Application.quitting -= Remove; Application.quitting += Remove;
#if UNITY_EDITOR
            UnityEditor.EditorApplication.playModeStateChanged -= OnMode;
            UnityEditor.EditorApplication.playModeStateChanged += OnMode;
            UnityEditor.AssemblyReloadEvents.beforeAssemblyReload -= Remove;
            UnityEditor.AssemblyReloadEvents.beforeAssemblyReload += Remove;
#endif
        }
#if UNITY_EDITOR
        static void OnMode(UnityEditor.PlayModeStateChange state) { if (state == UnityEditor.PlayModeStateChange.ExitingPlayMode) Remove(); }
#endif
        static void Ensure()
        {
            if (keyboard != null) return;
            originalSettings = InputSystem.settings;
            temporarySettings = UnityEngine.Object.Instantiate(originalSettings);
            temporarySettings.hideFlags = HideFlags.HideAndDontSave;
            temporarySettings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
#if UNITY_EDITOR
            temporarySettings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
#endif
            InputSystem.settings = temporarySettings;
            keyboard = InputSystem.AddDevice<Keyboard>("Genio Keyboard");
            mouse = InputSystem.AddDevice<Mouse>("Genio Mouse");
            pad = InputSystem.AddDevice<Gamepad>("Genio Gamepad");
            InputSystem.EnableDevice(keyboard); InputSystem.EnableDevice(mouse); InputSystem.EnableDevice(pad);
        }
        static void Apply(string json)
        {
            Packet p;
            try { p = JsonUtility.FromJson<Packet>(json); } catch { Release(); return; }
            if (p == null || p.type == "release") { Remove(); return; }
            if (p.type != "state" || p.keys == null || p.keys.Length > 32 || p.axes == null || p.axes.Length != 6) { Release(); return; }
            Ensure();
            var keys = new List<Key>();
            foreach (var name in p.keys) if (Enum.TryParse<Key>(name, true, out var key) && key != Key.None) keys.Add(key);
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(keys.ToArray()));
            var next = new Vector2(Mathf.Clamp01(p.x) * Screen.width, (1 - Mathf.Clamp01(p.y)) * Screen.height);
            InputSystem.QueueStateEvent(mouse, new MouseState { position = next, delta = next - position, buttons = (ushort)(p.buttons & 7) });
            position = next;
            var state = new GamepadState { leftStick = new Vector2(p.axes[0], -p.axes[1]), rightStick = new Vector2(p.axes[2], -p.axes[3]), leftTrigger = Mathf.Clamp01(p.axes[4]), rightTrigger = Mathf.Clamp01(p.axes[5]) };
            var buttons = new[] { GamepadButton.South, GamepadButton.East, GamepadButton.West, GamepadButton.North, GamepadButton.LeftShoulder, GamepadButton.RightShoulder, GamepadButton.Select, GamepadButton.Start, GamepadButton.LeftStick, GamepadButton.RightStick, GamepadButton.DpadUp, GamepadButton.DpadDown, GamepadButton.DpadLeft, GamepadButton.DpadRight };
            for (int i = 0; i < buttons.Length; i++) if ((p.gamepadButtons & (1 << i)) != 0) state = state.WithButton(buttons[i]);
            InputSystem.QueueStateEvent(pad, state);
        }
        static void Release()
        {
            if (keyboard == null) return;
            InputSystem.QueueStateEvent(keyboard, new KeyboardState());
            InputSystem.QueueStateEvent(mouse, new MouseState { position = position });
            InputSystem.QueueStateEvent(pad, new GamepadState());
        }
        static void Remove()
        {
            if (keyboard == null) return;
            Release();
            InputSystem.RemoveDevice(keyboard); InputSystem.RemoveDevice(mouse); InputSystem.RemoveDevice(pad);
            keyboard = null; mouse = null; pad = null;
            if (InputSystem.settings == temporarySettings) InputSystem.settings = originalSettings;
            UnityEngine.Object.Destroy(temporarySettings); temporarySettings = null; originalSettings = null;
        }
    }
}
