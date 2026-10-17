// Standalone check of D3D11Ring on .NET Framework (not Unity): a D3D11 device of its own, a render target standing in
// for Unity's stream RT, a ring shared into this same process, 300 copies, fence waits timed.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Genio.Play;

static class RingTest
{
    [StructLayout(LayoutKind.Sequential)] struct TexDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, int[] levels, uint numLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture2D(IntPtr self, ref TexDesc d, IntPtr init, out IntPtr tex);
    static T Fn<T>(IntPtr obj, int slot) where T : class { return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T)) as T; }

    static int Main()
    {
        IntPtr dev, ctx; int level;
        if (D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, new[] { 0xb000 }, 1, 7, out dev, out level, out ctx) < 0) { Console.WriteLine("no device"); return 2; }
        var d = new TexDesc { Width = 1280, Height = 720, MipLevels = 1, ArraySize = 1, Format = 27 /* TYPELESS, as Unity's RTs */, SampleCount = 1, BindFlags = 0x28 };
        IntPtr rt; if (Fn<CreateTexture2D>(dev, 5)(dev, ref d, IntPtr.Zero, out rt) < 0) { Console.WriteLine("no rt"); return 2; }
        int w, h, f; string error;
        Console.WriteLine("describe " + D3D11Ring.Describe(rt, out w, out h, out f, out error) + " " + w + "x" + h + " fmt " + f + " " + error);
        var sw = Stopwatch.StartNew();
        var ring = D3D11Ring.Create(rt, Process.GetCurrentProcess().Id, 3, out error);
        if (ring == null) { Console.WriteLine("create failed: " + error); return 3; }
        Console.WriteLine("ring " + sw.Elapsed.TotalMilliseconds.ToString("F2") + " ms luid=" + ring.AdapterLuid.ToString("x") + " gpu=" + ring.VendorId.ToString("x") + ":" + ring.DeviceId.ToString("x") + " handles=" + string.Join(",", Array.ConvertAll(ring.Handles, x => x.ToString())));
        double cpu = 0, gpu = 0; int n = 300;
        for (int i = 0; i < n; i++)
        {
            int slot = i % 3; double t0 = D3D11Ring.NowMs();
            ring.Copy(rt, slot); double t1 = D3D11Ring.NowMs();
            ring.Done[slot].WaitOne();
            double t2 = D3D11Ring.NowMs(); cpu += t1 - t0; gpu += t2 - t1;
        }
        Console.WriteLine("copy cpu avg " + (cpu / n).ToString("F3") + " ms, submit->done avg " + (gpu / n).ToString("F3") + " ms");
        ring.Dispose();
        Console.WriteLine("disposed");
        return 0;
    }
}
