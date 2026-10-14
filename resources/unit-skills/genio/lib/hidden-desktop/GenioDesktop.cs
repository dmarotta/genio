// Genio's hidden-desktop helper: Win32 primitives only, every decision lives in hidden-desktop.mjs.
// Compiled once per source hash with the csc.exe that ships with .NET Framework 4 (C# 5, no newer syntax).
//
//   launch     --desktop NAME --cwd DIR --command BASE64 --dir OUT   create NAME, start the command on it,
//              print one JSON line {ok,pid,created,desktop,helper}, stay until the process exits, write OUT/exit.json
//   windows    --desktop NAME                                        JSON array of visible top-level windows there
//   click      --desktop NAME --hwnd H --button LABEL                press one button of one window there
//   screenshot --desktop NAME --out FILE                             PNG of the visible windows there
//   close      --desktop NAME --pid P                                post WM_CLOSE to that process's windows there
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class GenioDesktop
{
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attributes);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);

    const uint GENERIC_ALL = 0x10000000;
    const uint WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, WM_CLOSE = 0x0010, BM_CLICK = 0x00F5;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    const uint GW_OWNER = 4;
    const uint CREATE_NO_WINDOW = 0x08000000;

    static int Main(string[] argv)
    {
        var args = new Dictionary<string, string>();
        for (int i = 1; i + 1 < argv.Length; i += 2) args[argv[i].TrimStart('-')] = argv[i + 1];
        string verb = argv.Length > 0 ? argv[0] : "";
        try
        {
            if (verb == "launch") return Launch(args);
            // Window messages only reach windows on the caller's own desktop, so every query runs on a
            // fresh thread (no windows or hooks of its own) attached to the hidden desktop.
            int code = 1; string output = null; Exception failure = null;
            var thread = new Thread(() => { try { output = OnDesktop(verb, args, out code); } catch (Exception e) { failure = e; } });
            thread.Start(); thread.Join();
            if (failure != null) throw failure;
            Console.Out.Write(output + "\n"); Console.Out.Flush();
            return code;
        }
        catch (Exception e)
        {
            Console.Out.Write("{\"ok\":false,\"message\":" + Json(e.Message) + "}\n"); Console.Out.Flush();
            return 1;
        }
    }

    static string Arg(Dictionary<string, string> args, string key)
    {
        string value;
        if (!args.TryGetValue(key, out value) || value.Length == 0) throw new ArgumentException("missing --" + key);
        return value;
    }

    static string Station()
    {
        var name = new StringBuilder(256); int needed;
        return GetUserObjectInformation(GetProcessWindowStation(), 2, name, name.Capacity * 2, out needed) ? name.ToString() : "WinSta0";
    }

    static int Launch(Dictionary<string, string> args)
    {
        string name = Arg(args, "desktop"), cwd = Arg(args, "cwd"), dir = Arg(args, "dir");
        string command = Encoding.UTF8.GetString(Convert.FromBase64String(Arg(args, "command")));
        bool visible = args.ContainsKey("visible") && args["visible"] == "true";
        IntPtr desktop = visible ? OpenDesktop("Default", 0, false, GENERIC_ALL) : CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (desktop == IntPtr.Zero) return Fail("desktop", Marshal.GetLastWin32Error(), "CreateDesktop failed");
        string path = Station() + "\\" + name;
        var startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup); startup.lpDesktop = visible ? null : path;
        PROCESS_INFORMATION info;
        // No inherited handles: the editor never holds Genio's pipes. A null environment inherits ours,
        // which is exactly the environment the caller gave this helper. CREATE_NO_WINDOW keeps a console
        // program's console off the player's desktop; GUI programs such as Unity ignore it.
        if (!CreateProcess(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref startup, out info))
        {
            int error = Marshal.GetLastWin32Error(); CloseDesktop(desktop);
            return Fail("process", error, "CreateProcess failed");
        }
        CloseHandle(info.hThread);
        long creation, exit, kernel, user;
        // Microseconds, like the CIM CreationDate Genio compares process identities with.
        string created = GetProcessTimes(info.hProcess, out creation, out exit, out kernel, out user) ? (creation / 10 * 10).ToString() : "";
        Console.Out.Write("{\"ok\":true,\"pid\":" + info.dwProcessId + ",\"created\":" + Json(created) + ",\"desktop\":" + Json(path) + ",\"helper\":" + Process.GetCurrentProcess().Id + "}\n");
        Console.Out.Flush();
        // The caller stops reading after that line; nothing else is written to stdout.
        try { Console.Out.Close(); } catch { }
        Process owner = null;
        if (args.ContainsKey("owner") && args.ContainsKey("owner-created"))
        {
            try
            {
                owner = Process.GetProcessById(int.Parse(args["owner"]));
                var pinned = owner.Handle; // Pin before reading creation time: PID reuse cannot inherit ownership.
                if ((owner.StartTime.ToFileTimeUtc() / 10 * 10).ToString() != args["owner-created"]) { owner.Dispose(); owner = null; }
            }
            catch { if (owner != null) owner.Dispose(); owner = null; }
        }
        DateTime? missingSince = null;
        while (WaitForSingleObject(info.hProcess, 1000) == 258)
        {
            if (!args.ContainsKey("owner")) continue; // Unit slots retain their existing ownership rules.
            bool gone = owner == null;
            if (owner != null) { try { gone = owner.HasExited; } catch { gone = true; } }
            if (!gone) { missingSince = null; continue; }
            if (!missingSince.HasValue) missingSince = DateTime.UtcNow;
            if ((DateTime.UtcNow - missingSince.Value).TotalSeconds < 120) continue;
            try { File.WriteAllText(Path.Combine(dir, "watchdog.json"), "{\"reason\":\"Genio owner exited\",\"pid\":" + info.dwProcessId + "}"); } catch { }
            foreach (var hwnd in TopLevel(desktop))
            {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                if (pid == info.dwProcessId) PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            }
            if (WaitForSingleObject(info.hProcess, 30000) == 258)
            {
                StopWatchdogChildren(info.dwProcessId, creation);
                // The original CreateProcess handle proves this is exactly the launched editor.
                TerminateProcess(info.hProcess, 1);
            }
        }
        if (owner != null) owner.Dispose();
        uint code; GetExitCodeProcess(info.hProcess, out code);
        CloseHandle(info.hProcess);
        try { File.WriteAllText(Path.Combine(dir, "exit.json"), "{\"pid\":" + info.dwProcessId + ",\"exitCode\":" + code + ",\"at\":" + Json(DateTime.UtcNow.ToString("o")) + "}"); } catch { }
        CloseDesktop(desktop);
        return 0;
    }

    // Snapshot descendant identities before stopping; handle-pinned StartTime checks protect against PID reuse.
    // Never terminate a shared licence client or an editor naming another project.
    static void StopWatchdogChildren(int root, long rootCreated)
    {
        var parents = new Dictionary<int, long>(); parents[root] = rootCreated;
        var children = new List<Process>();
        try
        {
            using (var search = new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,CreationDate,CommandLine FROM Win32_Process"))
            using (var rows = search.Get())
            {
                bool grew = true;
                while (grew)
                {
                    grew = false;
                    foreach (ManagementObject row in rows)
                    {
                        int pid = Convert.ToInt32(row["ProcessId"]), parent = Convert.ToInt32(row["ParentProcessId"]);
                        if (parents.ContainsKey(pid) || !parents.ContainsKey(parent)) continue;
                        string cmd = Convert.ToString(row["CommandLine"]);
                        if (cmd.IndexOf("Unity.Licensing.Client", StringComparison.OrdinalIgnoreCase) >= 0 || cmd.IndexOf("-projectPath", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                        try
                        {
                            long born = ManagementDateTimeConverter.ToDateTime(Convert.ToString(row["CreationDate"])).ToUniversalTime().ToFileTimeUtc();
                            if (born / 10 < parents[parent] / 10) continue;
                            var p = Process.GetProcessById(pid); var pinned = p.Handle;
                            if (p.StartTime.ToFileTimeUtc() / 10 != born / 10) { p.Dispose(); continue; }
                            parents[pid] = born; children.Add(p); grew = true;
                        }
                        catch { }
                    }
                }
            }
            for (int at = children.Count - 1; at >= 0; at--) { try { children[at].Kill(); } catch { } }
        }
        catch { }
        finally { foreach (var child in children) child.Dispose(); }
    }

    static int Fail(string stage, int error, string message)
    {
        Console.Out.Write("{\"ok\":false,\"stage\":" + Json(stage) + ",\"error\":" + error + ",\"message\":" + Json(message + " (Win32 error " + error + ")") + "}\n");
        Console.Out.Flush();
        return 1;
    }

    static string OnDesktop(string verb, Dictionary<string, string> args, out int code)
    {
        code = 0;
        string name = Arg(args, "desktop");
        int slash = name.LastIndexOf('\\');
        if (slash >= 0) name = name.Substring(slash + 1);
        IntPtr desktop = OpenDesktop(name, 0, false, GENERIC_ALL);
        if (desktop == IntPtr.Zero) { code = 3; return "{\"ok\":false,\"gone\":true,\"message\":" + Json("OpenDesktop failed (Win32 error " + Marshal.GetLastWin32Error() + ")") + "}"; }
        try
        {
            if (!SetThreadDesktop(desktop)) { code = 1; return "{\"ok\":false,\"message\":" + Json("SetThreadDesktop failed (Win32 error " + Marshal.GetLastWin32Error() + ")") + "}"; }
            var windows = TopLevel(desktop);
            if (verb == "windows")
            {
                var parts = new List<string>();
                foreach (var hwnd in windows) parts.Add(Describe(hwnd));
                return "[" + string.Join(",", parts.ToArray()) + "]";
            }
            if (verb == "click")
            {
                var target = new IntPtr(long.Parse(Arg(args, "hwnd")));
                string label = Plain(Arg(args, "button"));
                if (!windows.Contains(target)) { code = 1; return "{\"ok\":false,\"message\":\"window is not on this desktop\"}"; }
                foreach (var child in Children(target))
                {
                    if (Class(child) != "Button" || Plain(Text(child)) != label) continue;
                    IntPtr result;
                    bool sent = SendMessageTimeout(child, BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 3000, out result) != IntPtr.Zero;
                    return "{\"ok\":" + (sent ? "true" : "false") + "}";
                }
                code = 1; return "{\"ok\":false,\"message\":\"no such button\"}";
            }
            if (verb == "close")
            {
                uint pid = uint.Parse(Arg(args, "pid")); int posted = 0;
                foreach (var hwnd in windows) { uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner == pid && PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) posted++; }
                return "{\"ok\":true,\"windows\":" + posted + "}";
            }
            if (verb == "screenshot")
            {
                string file = Arg(args, "out");
                int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = Math.Max(1, GetSystemMetrics(78)), h = Math.Max(1, GetSystemMetrics(79));
                using (var canvas = new Bitmap(w, h))
                using (var g = Graphics.FromImage(canvas))
                {
                    g.Clear(Color.FromArgb(32, 32, 32));
                    // EnumDesktopWindows lists the top of the Z order first: paint bottom-up.
                    for (int i = windows.Count - 1; i >= 0; i--)
                    {
                        RECT r; if (!GetWindowRect(windows[i], out r) || r.Right <= r.Left || r.Bottom <= r.Top) continue;
                        using (var shot = new Bitmap(r.Right - r.Left, r.Bottom - r.Top))
                        {
                            using (var sg = Graphics.FromImage(shot)) { IntPtr dc = sg.GetHdc(); try { PrintWindow(windows[i], dc, 2); } finally { sg.ReleaseHdc(dc); } }
                            g.DrawImage(shot, r.Left - x, r.Top - y);
                        }
                    }
                    canvas.Save(file, ImageFormat.Png);
                }
                return "{\"ok\":true,\"file\":" + Json(file) + ",\"windows\":" + windows.Count + "}";
            }
            code = 2; return "{\"ok\":false,\"message\":\"unknown verb\"}";
        }
        finally { CloseDesktop(desktop); }
    }

    static List<IntPtr> TopLevel(IntPtr desktop)
    {
        var list = new List<IntPtr>();
        EnumDesktopWindows(desktop, (h, p) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    static List<IntPtr> Children(IntPtr parent)
    {
        var list = new List<IntPtr>();
        EnumChildWindows(parent, (h, p) => { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    static string Class(IntPtr hwnd) { var s = new StringBuilder(256); GetClassName(hwnd, s, s.Capacity); return s.ToString(); }

    // WM_GETTEXT with a timeout: a hung dialog never hangs the helper.
    static string Text(IntPtr hwnd)
    {
        IntPtr length;
        if (SendMessageTimeout(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out length) == IntPtr.Zero) return "";
        int n = Math.Min(8192, Math.Max(0, length.ToInt32()));
        var s = new StringBuilder(n + 1); IntPtr copied;
        if (SendMessageTimeout(hwnd, WM_GETTEXT, new IntPtr(n + 1), s, SMTO_ABORTIFHUNG, 1000, out copied) == IntPtr.Zero) return "";
        return s.ToString();
    }

    static string Plain(string label) { return label.Replace("&", "").Trim().ToLowerInvariant(); }

    static string Describe(IntPtr hwnd)
    {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        string exe = "";
        try { exe = Process.GetProcessById((int)pid).ProcessName; } catch { }
        RECT r; GetWindowRect(hwnd, out r);
        var texts = new List<string>(); var buttons = new List<string>();
        foreach (var child in Children(hwnd))
        {
            if (!IsWindowVisible(child)) continue;
            string cls = Class(child), text = Text(child).Trim();
            if (text.Length == 0) continue;
            if (cls == "Button") buttons.Add(Json(text));
            else if (cls == "Static" || cls == "Edit" || cls == "RichEdit20W" || cls == "SysLink") texts.Add(Json(text.Length > 2000 ? text.Substring(0, 2000) : text));
        }
        return "{\"hwnd\":" + Json(hwnd.ToInt64().ToString()) + ",\"pid\":" + pid + ",\"process\":" + Json(exe) + ",\"className\":" + Json(Class(hwnd)) +
            ",\"title\":" + Json(Text(hwnd)) + ",\"owner\":" + Json(GetWindow(hwnd, GW_OWNER).ToInt64().ToString()) + ",\"enabled\":" + (IsWindowEnabled(hwnd) ? "true" : "false") +
            ",\"rect\":[" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "],\"texts\":[" + string.Join(",", texts.ToArray()) + "],\"buttons\":[" + string.Join(",", buttons.ToArray()) + "]}";
    }

    static string Json(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
}
