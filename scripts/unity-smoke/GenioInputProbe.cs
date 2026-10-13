using System.Linq;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

// Copy into the disposable smoke project's Assets before starting its editor.
// Gameplay callbacks observe the player's input state buffer; a Pipeline eval
// runs in the Editor update and can read a different Input System state buffer.
public sealed class GenioInputProbe : MonoBehaviour
{
    public static int HeldSamples, ActionSamples, ReleasedSamples, VirtualDeviceId, CurrentDeviceId;
    public static bool Enabled, EventHeld, LastHeld;
    InputAction action;
    bool logged;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void StartProbe()
    {
        HeldSamples = ActionSamples = ReleasedSamples = 0;
        EventHeld = LastHeld = Enabled = false;
        var go = new GameObject("Genio input smoke probe");
        go.AddComponent<GenioInputProbe>();
    }
    void OnEnable()
    {
        action = new InputAction("Smoke W", InputActionType.Button, "<Keyboard>/w");
        action.performed += _ => ActionSamples++;
        action.canceled += _ => ReleasedSamples++;
        action.Enable(); InputSystem.onEvent += OnEvent;
    }
    void OnEvent(InputEventPtr inputEvent, InputDevice device)
    {
        if (device is Keyboard k && k.name.StartsWith("Genio") && inputEvent.IsA<StateEvent>())
            EventHeld = k.wKey.ReadValueFromEvent(inputEvent) > 0.5f;
    }
    void Update()
    {
        var k = InputSystem.devices.OfType<Keyboard>().FirstOrDefault(d => d.name.StartsWith("Genio"));
        if (k == null) return;
        Enabled = k.enabled; VirtualDeviceId = k.deviceId; CurrentDeviceId = Keyboard.current?.deviceId ?? -1;
        LastHeld = k.wKey.isPressed;
        if (LastHeld) HeldSamples++;
        if (!logged && EventHeld)
        {
            logged = true;
            Debug.Log($"Genio input probe: enabled={Enabled}, virtual={VirtualDeviceId}, current={CurrentDeviceId}, receivedW={EventHeld}, held={LastHeld}, actionSamples={ActionSamples}");
        }
    }
    void OnDisable() { InputSystem.onEvent -= OnEvent; action?.Dispose(); }
}
