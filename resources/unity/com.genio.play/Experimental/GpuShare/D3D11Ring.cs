// Experimental (spike): Play frames through D3D11 shared textures from C# only, no native plugin. See README.md.
// Plain C# 5 with no Unity types, so the same file also builds with the csc.exe of .NET Framework 4 for a standalone test.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Genio.Play.GpuShare
{
    /// <summary>
    /// A ring of D3D11 textures shared by NT handle into one other process (Genio's main), filled on the GPU by
    /// CopyResource from a texture of the same device. The device is the one behind the source texture's native
    /// pointer (ID3D11DeviceChild::GetDevice), so it is Unity's own. Create, Copy and Dispose use the device's
    /// immediate context: call them on the thread that renders (Unity's main thread when it has no render thread, else
    /// a plugin event). Completion is signalled on a wait handle per slot that any thread may wait on.
    /// </summary>
    public sealed class D3D11Ring : IDisposable
    {
        public readonly int Width, Height, Slots, SourceFormat;
        /// <summary>The slots' NT handles, valid in the target process only.</summary>
        public readonly long[] Handles;
        /// <summary>The adapter's LUID, to compare with the consumer's GPU (hybrid laptops).</summary>
        public long AdapterLuid { get; private set; }
        /// <summary>True with an ID3D11Fence (Windows 10 1703+ drivers); false falls back to event queries polled by Poll.</summary>
        public bool HasFence { get; private set; }
        public readonly AutoResetEvent[] Done;

        IntPtr device, context, context4, fence, targetProcess;
        readonly IntPtr[] textures, queries;
        readonly ulong[] pendingValue;
        ulong fenceValue;
        bool disposed;

        D3D11Ring(int width, int height, int slots, int format)
        {
            Width = width; Height = height; Slots = slots; SourceFormat = format;
            Handles = new long[slots]; textures = new IntPtr[slots]; queries = new IntPtr[slots]; pendingValue = new ulong[slots];
            Done = new AutoResetEvent[slots];
            for (int s = 0; s < slots; s++) Done[s] = new AutoResetEvent(false);
        }

        /// <summary>
        /// The D3D11 description of a native texture pointer (Unity's GetNativeTexturePtr), or an error naming what it
        /// is not. A D3D12 resource answers E_NOINTERFACE to the ID3D11Texture2D query; nothing else is called on it.
        /// </summary>
        public static bool Describe(IntPtr nativeTexture, out int width, out int height, out int format, out string error)
        {
            width = height = format = 0; error = null;
            if (nativeTexture == IntPtr.Zero) { error = "no native texture"; return false; }
            IntPtr tex; Guid iid = IID_ID3D11Texture2D;
            int hr = Fn<QI>(nativeTexture, 0)(nativeTexture, ref iid, out tex);
            if (hr < 0) { error = "the native texture is not a D3D11 texture (0x" + hr.ToString("x8") + ")"; return false; }
            var desc = new TexDesc(); Fn<GetDesc>(tex, Tex_GetDesc)(tex, ref desc); Release(tex);
            width = (int)desc.Width; height = (int)desc.Height; format = (int)desc.Format;
            if (desc.SampleCount != 1) { error = "the texture is multisampled"; return false; }
            if (desc.Format < 27 || desc.Format > 32) { error = "the texture format " + desc.Format + " is not in the R8G8B8A8 group"; return false; }
            return true;
        }

        /// <summary>A ring for frames of nativeTexture's size and format group, shared into targetPid.</summary>
        public static D3D11Ring Create(IntPtr nativeTexture, int targetPid, int slots, out string error)
        {
            int w, h, format;
            if (!Describe(nativeTexture, out w, out h, out format, out error)) return null;
            var ring = new D3D11Ring(w, h, slots, format);
            try { error = ring.Init(nativeTexture, targetPid); }
            catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
            if (error == null) return ring;
            ring.Dispose(); return null;
        }

        string Init(IntPtr nativeTexture, int targetPid)
        {
            IntPtr tex; Guid iid = IID_ID3D11Texture2D;
            Check(Fn<QI>(nativeTexture, 0)(nativeTexture, ref iid, out tex), "QueryInterface ID3D11Texture2D");
            Fn<GetDevice>(tex, Child_GetDevice)(tex, out device); Release(tex);
            if (device == IntPtr.Zero) return "GetDevice returned no device";
            Fn<GetImmediateContext>(device, Dev_GetImmediateContext)(device, out context);

            IntPtr dxgi; iid = IID_IDXGIDevice;
            if (Fn<QI>(device, 0)(device, ref iid, out dxgi) >= 0)
            {
                IntPtr adapter;
                if (Fn<GetAdapter>(dxgi, Dxgi_GetAdapter)(dxgi, out adapter) >= 0)
                {
                    var desc = Marshal.AllocHGlobal(AdapterDescSize);
                    try { if (Fn<GetAdapterDesc>(adapter, Adapter_GetDesc)(adapter, desc) >= 0) AdapterLuid = Marshal.ReadInt64(desc, AdapterLuidOffset); }
                    finally { Marshal.FreeHGlobal(desc); }
                    Release(adapter);
                }
                Release(dxgi);
            }

            IntPtr device5; iid = IID_ID3D11Device5;
            if (Fn<QI>(device, 0)(device, ref iid, out device5) >= 0)
            {
                Guid fiid = IID_ID3D11Fence; iid = IID_ID3D11DeviceContext4;
                if (Fn<CreateFence>(device5, Dev5_CreateFence)(device5, 0, 0, ref fiid, out fence) >= 0 && Fn<QI>(context, 0)(context, ref iid, out context4) >= 0) HasFence = true;
                Release(device5);
            }

            targetProcess = OpenProcess(PROCESS_DUP_HANDLE, false, targetPid);
            if (targetProcess == IntPtr.Zero) return "OpenProcess(" + targetPid + ") failed (" + Marshal.GetLastWin32Error() + ")";
            var td = new TexDesc { Width = (uint)Width, Height = (uint)Height, MipLevels = 1, ArraySize = 1, Format = R8G8B8A8_UNORM, SampleCount = 1, BindFlags = BIND_RENDER_TARGET | BIND_SHADER_RESOURCE, MiscFlags = MISC_SHARED | MISC_SHARED_NTHANDLE };
            for (int s = 0; s < Slots; s++)
            {
                Check(Fn<CreateTexture2D>(device, Dev_CreateTexture2D)(device, ref td, IntPtr.Zero, out textures[s]), "CreateTexture2D (shared)");
                IntPtr res1, local, remote; iid = IID_IDXGIResource1;
                Check(Fn<QI>(textures[s], 0)(textures[s], ref iid, out res1), "QueryInterface IDXGIResource1");
                int hr = Fn<CreateSharedHandle>(res1, Res1_CreateSharedHandle)(res1, IntPtr.Zero, SHARED_READ | SHARED_WRITE, IntPtr.Zero, out local);
                Release(res1); Check(hr, "CreateSharedHandle");
                // The target's copy keeps the shared resource reachable; ours is not needed after the duplication.
                bool ok = DuplicateHandle(GetCurrentProcess(), local, targetProcess, out remote, 0, false, DUPLICATE_SAME_ACCESS);
                int lastError = Marshal.GetLastWin32Error();
                CloseHandle(local);
                if (!ok) return "DuplicateHandle into " + targetPid + " failed (" + lastError + ")";
                Handles[s] = remote.ToInt64();
                if (!HasFence) { var qd = new QueryDesc { Query = 0 /* EVENT */ }; Check(Fn<CreateQuery>(device, Dev_CreateQuery)(device, ref qd, out queries[s]), "CreateQuery"); }
            }
            return null;
        }

        /// <summary>Queues a GPU copy of source (a texture of this ring's device, size and format group) into slot; Done[slot] is set once the GPU finished it.</summary>
        public void Copy(IntPtr source, int slot)
        {
            if (disposed) throw new ObjectDisposedException("D3D11Ring");
            Fn<CopyResource>(context, Ctx_CopyResource)(context, textures[slot], source);
            if (HasFence)
            {
                ulong value = ++fenceValue;
                Check(Fn<Signal>(context4, Ctx4_Signal)(context4, fence, value), "Signal");
                Check(Fn<SetEventOnCompletion>(fence, Fence_SetEventOnCompletion)(fence, value, Done[slot].SafeWaitHandle.DangerousGetHandle()), "SetEventOnCompletion");
            }
            else { Fn<End>(context, Ctx_End)(context, queries[slot]); pendingValue[slot] = 1; }
            // Submit now rather than at Unity's next present, so the copy is not held back for a frame.
            Fn<Flush>(context, Ctx_Flush)(context);
        }

        /// <summary>Without a fence: polls the event queries (render thread) and sets Done for the finished slots.</summary>
        public void Poll()
        {
            if (HasFence || disposed) return;
            var getData = Fn<GetData>(context, Ctx_GetData);
            for (int s = 0; s < Slots; s++)
            {
                if (pendingValue[s] == 0) continue;
                int done; if (getData(context, queries[s], out done, 4, 1 /* DONOTFLUSH */) == 0) { pendingValue[s] = 0; Done[s].Set(); }
            }
        }

        /// <summary>Releases the textures and closes the handles in the target process: call once the consumer released every slot.</summary>
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            for (int s = 0; s < Slots; s++)
            {
                if (Handles[s] != 0 && targetProcess != IntPtr.Zero) DuplicateHandle(targetProcess, new IntPtr(Handles[s]), IntPtr.Zero, IntPtr.Zero, 0, false, DUPLICATE_CLOSE_SOURCE);
                Handles[s] = 0;
                if (textures[s] != IntPtr.Zero) { Release(textures[s]); textures[s] = IntPtr.Zero; }
                if (queries[s] != IntPtr.Zero) { Release(queries[s]); queries[s] = IntPtr.Zero; }
                Done[s].Set();
            }
            if (fence != IntPtr.Zero) { Release(fence); fence = IntPtr.Zero; }
            if (context4 != IntPtr.Zero) { Release(context4); context4 = IntPtr.Zero; }
            if (context != IntPtr.Zero) { Release(context); context = IntPtr.Zero; }
            if (device != IntPtr.Zero) { Release(device); device = IntPtr.Zero; }
            if (targetProcess != IntPtr.Zero) { CloseHandle(targetProcess); targetProcess = IntPtr.Zero; }
        }

        /// <summary>Unix time in milliseconds, at the system clock's full precision (the clock Electron's performance.timeOrigin follows).</summary>
        public static double NowMs() { long ft; GetSystemTimePreciseAsFileTime(out ft); return (ft - 116444736000000000L) / 10000.0; }



        static void Check(int hr, string what) { if (hr < 0) throw new InvalidOperationException(what + " failed (0x" + hr.ToString("x8") + ")"); }
        static void Release(IntPtr obj) { Fn<Rel>(obj, 2)(obj); }
        static T Fn<T>(IntPtr obj, int slot) where T : class
        {
            IntPtr vtbl = Marshal.ReadIntPtr(obj);
            return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T)) as T;
        }

        // COM vtable slots, checked against the Windows SDK 10.0.22000 C declarations (offsetof over the *Vtbl structs).
        const int Child_GetDevice = 3, Tex_GetDesc = 10;
        const int Dev_CreateTexture2D = 5, Dev_CreateQuery = 24, Dev_GetImmediateContext = 40, Dev5_CreateFence = 68;
        const int Ctx_End = 28, Ctx_GetData = 29, Ctx_CopyResource = 47, Ctx_Flush = 111, Ctx4_Signal = 147;
        const int Fence_SetEventOnCompletion = 9, Res1_CreateSharedHandle = 13, Dxgi_GetAdapter = 7, Adapter_GetDesc = 8;
        const int AdapterDescSize = 304, AdapterLuidOffset = 296;
        const uint R8G8B8A8_UNORM = 28, BIND_SHADER_RESOURCE = 0x8, BIND_RENDER_TARGET = 0x20, MISC_SHARED = 0x2, MISC_SHARED_NTHANDLE = 0x800;
        const uint SHARED_READ = 0x80000000, SHARED_WRITE = 1, PROCESS_DUP_HANDLE = 0x40, DUPLICATE_CLOSE_SOURCE = 1, DUPLICATE_SAME_ACCESS = 2;
        static readonly Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        static readonly Guid IID_ID3D11Device5 = new Guid("8ffde202-a0e7-45df-9e01-e837801b5ea0");
        static readonly Guid IID_ID3D11DeviceContext4 = new Guid("917600da-f58c-4c33-98d8-3e15b390fa24");
        static readonly Guid IID_ID3D11Fence = new Guid("affde9d1-1df7-4bb7-8a34-0f46251dab80");
        static readonly Guid IID_IDXGIResource1 = new Guid("30961379-4609-4a41-998e-54fe567ee0c1");
        static readonly Guid IID_IDXGIDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");

        [StructLayout(LayoutKind.Sequential)] struct TexDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
        [StructLayout(LayoutKind.Sequential)] struct QueryDesc { public uint Query, MiscFlags; }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QI(IntPtr self, ref Guid iid, out IntPtr obj);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint Rel(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDevice(IntPtr self, out IntPtr device);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDesc(IntPtr self, ref TexDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetImmediateContext(IntPtr self, out IntPtr context);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture2D(IntPtr self, ref TexDesc desc, IntPtr init, out IntPtr tex);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateQuery(IntPtr self, ref QueryDesc desc, out IntPtr query);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateFence(IntPtr self, ulong initial, uint flags, ref Guid iid, out IntPtr fence);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self, IntPtr dst, IntPtr src);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void End(IntPtr self, IntPtr query);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetData(IntPtr self, IntPtr query, out int data, uint size, uint flags);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Flush(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Signal(IntPtr self, IntPtr fence, ulong value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetEventOnCompletion(IntPtr self, ulong value, IntPtr evt);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateSharedHandle(IntPtr self, IntPtr attributes, uint access, IntPtr name, out IntPtr handle);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAdapter(IntPtr self, out IntPtr adapter);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAdapterDesc(IntPtr self, IntPtr desc);

        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProcess, IntPtr src, IntPtr dstProcess, out IntPtr dst, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr srcProcess, IntPtr src, IntPtr dstProcess, IntPtr dstNull, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long fileTime);
    }
}
