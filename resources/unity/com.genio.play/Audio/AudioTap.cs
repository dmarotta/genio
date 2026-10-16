using System;
using System.Diagnostics;
using System.Threading;
using UnityEngine;

namespace Genio.Play
{
    /// Streams the active AudioListener's final mix (AudioMixer routes included) to Genio as 'GA' packets on the
    /// session's socket. The listener hears the mix even while Unity's Mute Audio is on, and the mix is zeroed after
    /// the copy, so the hidden editor stays silent whatever that per-user setting says. The setting is never touched.
    public sealed class AudioTap : MonoBehaviour
    {
        // 'GA' v1, little-endian: 'G' 'A', version u8, channels u8, seq u32, rate u32, frames u16, reserved u16,
        // capture time f64 (Unix ms), then frames x channels interleaved int16. A seq gap is a dropped block.
        public const int Header = 24, MaxFrames = 4096;
        const int RingFrames = 1 << 16, Blocks = 256; // 256 KB of stereo int16: 1.4 s at 48 kHz
        const float Half = 0.7071068f;
        struct Block { public long start; public int frames, rate; public uint seq; public double time; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init() { StreamSession.StartAudio = Begin; StreamSession.StopAudio = End; }
        static void Begin(StreamSession session) { var tap = session.gameObject.AddComponent<AudioTap>(); tap.session = session; tap.StartSender(); tap.Follow(); }
        static void End(StreamSession session) { var tap = session.GetComponent<AudioTap>(); if (tap != null) tap.Stop(); }

        StreamSession session;
        AudioListener listener;
        ListenerTap filter;
        // Everything the audio thread touches is allocated here: one producer (the mixer), one consumer (the sender).
        readonly short[] ring = new short[RingFrames * 2];
        readonly Block[] blocks = new Block[Blocks];
        readonly byte[] packet = new byte[Header + MaxFrames * 4];
        readonly AutoResetEvent wake = new AutoResetEvent(false);
        long writeFrame, readFrame;
        int blockWrite, blockRead;
        uint seq;
        volatile int rate;
        volatile bool running;
        double epochMs, msPerTick;
        float nextFollow;

        void StartSender()
        {
            rate = AudioSettings.outputSampleRate;
            AudioSettings.OnAudioConfigurationChanged += OnConfiguration;
            msPerTick = 1000.0 / Stopwatch.Frequency;
            epochMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Stopwatch.GetTimestamp() * msPerTick;
            running = true;
            new Thread(Send) { IsBackground = true, Name = "Genio Play audio" }.Start();
        }
        void OnConfiguration(bool deviceChanged) { rate = AudioSettings.outputSampleRate; }

        // A scene load or a camera switch can replace the listener: re-check twice a second, in real time.
        void Update() { if (running && Time.realtimeSinceStartup >= nextFollow) Follow(); }
        void Follow()
        {
            nextFollow = Time.realtimeSinceStartup + 0.5f;
            if (listener != null && listener.isActiveAndEnabled && filter != null) return;
            AudioListener next = null;
            // Obsolete from 6000.5, but the overloads that replace it are not in 6000.0, the package's minimum.
#pragma warning disable CS0618
            foreach (var l in FindObjectsByType<AudioListener>(FindObjectsSortMode.None)) if (l.isActiveAndEnabled) { next = l; break; }
#pragma warning restore CS0618
            if (filter != null && filter.tap == this) filter.tap = null;
            listener = next; filter = null;
            if (next == null) return;
            // Added last, it runs after the game's own listener filters and so hears what the speakers would.
            filter = next.GetComponent<ListenerTap>();
            if (filter == null) { filter = next.gameObject.AddComponent<ListenerTap>(); filter.hideFlags = HideFlags.HideInInspector | HideFlags.DontSave; }
            filter.tap = this;
        }

        /// Audio thread. Copies one mixer block into the ring as stereo int16, in blocks of at most MaxFrames.
        internal void Write(float[] data, int channels)
        {
            if (!running || channels < 1) return;
            int sampleRate = rate, total = data.Length / channels, offset = 0;
            double time = epochMs + Stopwatch.GetTimestamp() * msPerTick;
            while (total > 0)
            {
                int n = Math.Min(total, MaxFrames);
                Push(data, offset, n, channels, sampleRate, time);
                offset += n * channels; total -= n; time += n * 1000.0 / sampleRate;
            }
        }
        void Push(float[] data, int offset, int frames, int channels, int sampleRate, double time)
        {
            long w = writeFrame;
            // The sender is behind: drop this block; its seq is skipped so the gap shows.
            if (w + frames - Volatile.Read(ref readFrame) > RingFrames || blockWrite - Volatile.Read(ref blockRead) >= Blocks) { seq++; return; }
            for (int i = 0; i < frames; i++)
            {
                Downmix(data, offset + i * channels, channels, out float l, out float r);
                int at = (int)((w + i) & (RingFrames - 1)) * 2;
                ring[at] = Pcm(l); ring[at + 1] = Pcm(r);
            }
            blocks[blockWrite & (Blocks - 1)] = new Block { start = w, frames = frames, rate = sampleRate, seq = seq++, time = time };
            writeFrame = w + frames;
            Volatile.Write(ref blockWrite, blockWrite + 1);
            wake.Set();
        }
        // Unity's speaker layouts: quad FL FR RL RR; 5.0 FL FR C RL RR; 5.1 FL FR C LFE RL RR; 7.1 adds SL SR. LFE is left out.
        static void Downmix(float[] d, int s, int channels, out float l, out float r)
        {
            switch (channels)
            {
                case 1: l = r = d[s]; return;
                case 4: l = d[s] + Half * d[s + 2]; r = d[s + 1] + Half * d[s + 3]; return;
                case 5: l = d[s] + Half * (d[s + 2] + d[s + 3]); r = d[s + 1] + Half * (d[s + 2] + d[s + 4]); return;
                case 6: l = d[s] + Half * (d[s + 2] + d[s + 4]); r = d[s + 1] + Half * (d[s + 2] + d[s + 5]); return;
                case 8: l = d[s] + Half * (d[s + 2] + d[s + 4] + d[s + 6]); r = d[s + 1] + Half * (d[s + 2] + d[s + 5] + d[s + 7]); return;
                default: l = d[s]; r = d[s + 1]; return;
            }
        }
        static short Pcm(float x)
        {
            float v = x * 32767f;
            return v >= 32767f ? (short)32767 : v <= -32768f ? (short)-32768 : float.IsNaN(v) ? (short)0 : (short)v;
        }

        /// Sender thread: one packet per block, in order, through the session's single-send gate shared with frames.
        void Send()
        {
            try
            {
                while (running)
                {
                    if (blockRead == Volatile.Read(ref blockWrite)) { wake.WaitOne(50); continue; }
                    var b = blocks[blockRead & (Blocks - 1)];
                    int length = Pack(b);
                    Volatile.Write(ref readFrame, b.start + b.frames);
                    Volatile.Write(ref blockRead, blockRead + 1);
                    if (b.rate >= 8000 && b.rate <= 192000) session.Send(new ArraySegment<byte>(packet, 0, length)).Wait();
                }
            }
            catch (Exception) { /* The socket closed; the session stops the tap. */ }
            finally { running = false; }
        }
        int Pack(Block b)
        {
            var p = packet;
            p[0] = (byte)'G'; p[1] = (byte)'A'; p[2] = 1; p[3] = 2;
            Put(p, 4, b.seq); Put(p, 8, (uint)b.rate);
            p[12] = (byte)b.frames; p[13] = (byte)(b.frames >> 8); p[14] = 0; p[15] = 0;
            long bits = BitConverter.DoubleToInt64Bits(b.time);
            for (int i = 0; i < 8; i++) p[16 + i] = (byte)(bits >> (8 * i));
            // BlockCopy keeps the host's byte order: little-endian on every desktop runtime ClientWebSocket supports.
            int at = (int)(b.start & (RingFrames - 1)), first = Math.Min(b.frames, RingFrames - at);
            Buffer.BlockCopy(ring, at * 4, p, Header, first * 4);
            if (first < b.frames) Buffer.BlockCopy(ring, 0, p, Header + first * 4, (b.frames - first) * 4);
            return Header + b.frames * 4;
        }
        static void Put(byte[] p, int at, uint v) { p[at] = (byte)v; p[at + 1] = (byte)(v >> 8); p[at + 2] = (byte)(v >> 16); p[at + 3] = (byte)(v >> 24); }

        void Stop()
        {
            running = false; wake.Set();
            AudioSettings.OnAudioConfigurationChanged -= OnConfiguration;
            if (filter != null && filter.tap == this) filter.tap = null;
            filter = null; listener = null;
        }
        void OnDestroy() { Stop(); }
    }

    /// On the listener: hands the mix to the session's tap, then silences the speakers. Once a session has started it
    /// stays until the listener goes (scene unload, Play Mode exit), so the editor keeps quiet between sessions too.
    public sealed class ListenerTap : MonoBehaviour
    {
        internal volatile AudioTap tap;
        void OnAudioFilterRead(float[] data, int channels)
        {
            // A plain reference test: UnityEngine.Object's == asks the engine, which the audio thread must not.
            var current = tap;
            if (!ReferenceEquals(current, null)) current.Write(data, channels);
            Array.Clear(data, 0, data.Length);
        }
    }
}
