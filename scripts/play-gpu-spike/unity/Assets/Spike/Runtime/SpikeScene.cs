using System;
using System.Collections;
using UnityEngine;

namespace Genio.Spike
{
    /// <summary>
    /// The spike's test scene, built in code at Play: moving content, and a strip of 20 black or white blocks in the
    /// top-left corner that spells Time.frameCount, so the consumer can tell which frame it drew whatever the path.
    /// Logs each frame's end-of-frame time (t0) for the latency join.
    /// </summary>
    public sealed class SpikeScene : MonoBehaviour
    {
        public static SpikeScene Instance;
        public const int Bits = 20;
        public int[] LogFrames = new int[20000];
        public double[] LogT0 = new double[20000];
        public int LogCount;
        public bool Logging;
        Camera cam;
        Transform stripBack;
        readonly Renderer[] blocks = new Renderer[Bits];
        readonly Transform[] cubes = new Transform[40];
        Material black, white;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Build()
        {
            if (Instance != null) return;
            QualitySettings.vSyncCount = 0; QualitySettings.antiAliasing = 0;
            Application.targetFrameRate = 60;
            var go = new GameObject("Spike scene");
            Instance = go.AddComponent<SpikeScene>();
        }

        Material Unlit(Color c) { var m = new Material(Shader.Find("Unlit/Color")); m.color = c; return m; }

        void Awake()
        {
            foreach (var existing in Camera.allCameras) existing.enabled = false;
            cam = new GameObject("Spike camera").AddComponent<Camera>();
            cam.orthographic = true; cam.clearFlags = CameraClearFlags.SolidColor; cam.allowMSAA = false;
            cam.transform.position = new Vector3(0, 0, -100); cam.nearClipPlane = 0.1f; cam.farClipPlane = 1000;
            black = Unlit(Color.black); white = Unlit(Color.white);
            var grey = Unlit(new Color(0.5f, 0.5f, 0.5f));
            stripBack = Quad("strip", grey, 2).transform;
            for (int b = 0; b < Bits; b++) blocks[b] = Quad("bit" + b, black, 1).GetComponent<Renderer>();
            var rnd = new System.Random(7);
            for (int i = 0; i < cubes.Length; i++)
            {
                var c = GameObject.CreatePrimitive(PrimitiveType.Cube);
                Destroy(c.GetComponent<Collider>());
                c.GetComponent<Renderer>().sharedMaterial = Unlit(Color.HSVToRGB((float)rnd.NextDouble(), 0.7f, 0.9f));
                cubes[i] = c.transform;
            }
            StartCoroutine(EndOfFrame());
        }

        GameObject Quad(string name, Material m, float z)
        {
            var q = GameObject.CreatePrimitive(PrimitiveType.Quad);
            q.name = name; Destroy(q.GetComponent<Collider>());
            q.GetComponent<Renderer>().sharedMaterial = m;
            q.transform.position = new Vector3(0, 0, z);
            return q;
        }

        // Pixel coordinates from the top-left corner, with one world unit per pixel.
        Vector3 Px(float x, float y, float z) { return new Vector3(x - Screen.width / 2f, Screen.height / 2f - y, z); }

        void Update()
        {
            float w = Screen.width, h = Screen.height, t = Time.time;
            cam.orthographicSize = h / 2f;
            cam.backgroundColor = new Color(0.25f + 0.2f * Mathf.Sin(t * 1.9f), 0.25f + 0.2f * Mathf.Sin(t * 1.4f + 2), 0.35f + 0.2f * Mathf.Sin(t + 4));
            stripBack.position = Px(8 + Bits * 36 / 2f, 24, -2); stripBack.localScale = new Vector3(16 + Bits * 36, 48, 1);
            int n = Time.frameCount;
            for (int b = 0; b < Bits; b++)
            {
                blocks[b].transform.position = Px(8 + b * 36 + 16 + 4, 24, -3);
                blocks[b].transform.localScale = new Vector3(32, 32, 1);
                blocks[b].sharedMaterial = ((n >> b) & 1) != 0 ? white : black;
            }
            for (int i = 0; i < cubes.Length; i++)
            {
                float a = t * 0.6f + i * 0.157f;
                cubes[i].position = new Vector3(Mathf.Cos(a) * w * 0.38f, Mathf.Sin(a * 1.3f) * h * 0.32f, 10 + i);
                cubes[i].localScale = Vector3.one * (h * 0.08f);
                cubes[i].rotation = Quaternion.Euler(t * 40 + i * 9, t * 70 + i * 13, 0);
            }
        }

        IEnumerator EndOfFrame()
        {
            var wait = new WaitForEndOfFrame();
            while (true)
            {
                yield return wait;
                if (!Logging || LogCount >= LogFrames.Length) continue;
                LogFrames[LogCount] = Time.frameCount; LogT0[LogCount] = Genio.Play.GpuShare.D3D11Ring.NowMs(); LogCount++;
            }
        }
    }
}
