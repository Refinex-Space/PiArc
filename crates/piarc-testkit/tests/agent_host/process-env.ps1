# Prints the environment block of another process, one NAME=value per line: the Windows
# counterpart of `ps -E` for the T08-A10 check in credentials.rs (W0). Reads the process's PEB
# (ProcessParameters → Environment, EnvironmentSize) with NtQueryInformationProcess and
# ReadProcessMemory; x64 processes of the same user only. Test-only.
param([Parameter(Mandatory = $true)][int]$ProcessId)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PiarcProcessEnv {
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessBasicInformation {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass,
        ref ProcessBasicInformation info, int size, out int returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer,
        IntPtr size, out IntPtr read);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    const int QueryInformation = 0x0400;
    const int VmRead = 0x0010;

    static byte[] Read(IntPtr process, IntPtr address, int size) {
        var buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, (IntPtr)size, out read)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return buffer;
    }

    public static string Environment(int pid) {
        IntPtr process = OpenProcess(QueryInformation | VmRead, false, pid);
        if (process == IntPtr.Zero) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            var info = new ProcessBasicInformation();
            int returned;
            int status = NtQueryInformationProcess(process, 0, ref info,
                Marshal.SizeOf(info), out returned);
            if (status != 0) {
                throw new InvalidOperationException("NtQueryInformationProcess: " + status);
            }
            // x64 layouts: PEB.ProcessParameters at 0x20; RTL_USER_PROCESS_PARAMETERS.Environment
            // at 0x80 and EnvironmentSize at 0x3F0.
            IntPtr parameters = (IntPtr)BitConverter.ToInt64(
                Read(process, info.PebBaseAddress + 0x20, 8), 0);
            IntPtr environment = (IntPtr)BitConverter.ToInt64(
                Read(process, parameters + 0x80, 8), 0);
            long size = BitConverter.ToInt64(Read(process, parameters + 0x3F0, 8), 0);
            byte[] block = Read(process, environment, (int)size);
            return System.Text.Encoding.Unicode.GetString(block).Replace('\0', '\n');
        } finally {
            CloseHandle(process);
        }
    }
}
'@

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([PiarcProcessEnv]::Environment($ProcessId))
