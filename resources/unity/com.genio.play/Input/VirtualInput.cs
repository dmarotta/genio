using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace Genio.Play
{
    public static class VirtualInput
    {
        // scroll: wheel notches since the last packet, positive up; absent (0) in older packets.
        [Serializable] class Packet { public string type; public string[] keys; public float x, y; public int buttons; public float[] axes; public int gamepadButtons; public float scroll; }
        static Keyboard keyboard;
        static Mouse mouse;
        static Gamepad pad;
        static Vector2 position;
        static float scrollPerNotch = 1;
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
            keyboard = InputSystem.AddDevice<Keyboard>("GenioVirtualKeyboard");
            mouse = InputSystem.AddDevice<Mouse>("Genio Mouse");
            pad = InputSystem.AddDevice<Gamepad>("Genio Gamepad");
            InputSystem.EnableDevice(keyboard); InputSystem.EnableDevice(mouse); InputSystem.EnableDevice(pad);
            keyboard.MakeCurrent();
            scrollPerNotch = ScrollPerNotch();
        }
        // A hardware wheel reaches Mouse.scroll scaled by the native backend: 1 per notch when the project's Scroll Delta
        // Behavior is uniform (the default since Input System 1.8), the platform range (120 on Windows) otherwise or on
        // older packages. State queued on a virtual mouse skips that step, so the same scale is applied here.
        static float ScrollPerNotch()
        {
            const BindingFlags any = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            try
            {
                // Internal property when the editor can normalize; a literal 1 (no native scaling) otherwise.
                var property = typeof(InputSystem).GetProperty("scrollWheelDeltaPerTick", any);
                if (property != null && property.GetValue(null) is float tick && tick > 0 && !float.IsInfinity(tick)) return tick;
            }
            catch { }
            return Application.platform == RuntimePlatform.WindowsEditor || Application.platform == RuntimePlatform.WindowsPlayer ? 120 : 1;
        }
        static void Apply(string json)
        {
            Packet p;
            try { p = JsonUtility.FromJson<Packet>(json); } catch { Release(); return; }
            if (p == null || p.type == "release") { Remove(); return; }
            if (p.type != "state" || p.keys == null || p.keys.Length > 32 || p.axes == null || p.axes.Length != 6) { Release(); return; }
            bool firstPacket = keyboard == null;
            Ensure();
            var keys = new List<Key>();
            foreach (var name in p.keys) if (Enum.TryParse<Key>(name, true, out var key) && key != Key.None) keys.Add(key);
            InputSystem.QueueStateEvent(keyboard, new KeyboardState(keys.ToArray()));
            var next = new Vector2(Mathf.Clamp01(p.x) * Screen.width, (1 - Mathf.Clamp01(p.y)) * Screen.height);
            // Mouse sums scroll across the events of one update and zeroes it on the next, so each notch is read once.
            // Legacy Input.mouseScrollDelta reads only the OS wheel and cannot be fed from here.
            var notches = float.IsNaN(p.scroll) ? 0 : Mathf.Clamp(p.scroll, -50, 50);
            InputSystem.QueueStateEvent(mouse, new MouseState { position = next, delta = next - position, scroll = new Vector2(0, notches * scrollPerNotch), buttons = (ushort)(p.buttons & 7) });
            position = next;
            var state = new GamepadState { leftStick = new Vector2(p.axes[0], -p.axes[1]), rightStick = new Vector2(p.axes[2], -p.axes[3]), leftTrigger = Mathf.Clamp01(p.axes[4]), rightTrigger = Mathf.Clamp01(p.axes[5]) };
            var buttons = new[] { GamepadButton.South, GamepadButton.East, GamepadButton.West, GamepadButton.North, GamepadButton.LeftShoulder, GamepadButton.RightShoulder, GamepadButton.Select, GamepadButton.Start, GamepadButton.LeftStick, GamepadButton.RightStick, GamepadButton.DpadUp, GamepadButton.DpadDown, GamepadButton.DpadLeft, GamepadButton.DpadRight };
            for (int i = 0; i < buttons.Length; i++) if ((p.gamepadButtons & (1 << i)) != 0) state = state.WithButton(buttons[i]);
            InputSystem.QueueStateEvent(pad, state);
            // Flush the initial state after creating devices while the Editor is
            // unfocused. Later packets use Unity's normal per-frame input update.
            if (firstPacket) InputSystem.Update();
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
