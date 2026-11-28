# PiArc shell integration for PowerShell (Windows PowerShell 5.1 and PowerShell 7). Loaded
# after the user's profile; wraps the prompt to report prompts, typed commands, command output
# and exit codes (OSC 133 A, B, C, D) and the working directory (OSC 7). No file of the
# user's is changed.
if ($global:__PiarcMarks) { return }
$global:__PiarcMarks = $true
$global:__PiarcBusy = $false
$global:__PiarcExitBefore = $null
$global:__PiarcPrompt = $function:prompt
$global:__PiarcEsc = [char]27
$global:__PiarcBel = [char]7

function global:prompt {
    $succeeded = $global:?
    $native = $global:LASTEXITCODE
    $esc = $global:__PiarcEsc
    $bel = $global:__PiarcBel
    $out = ''
    if ($global:__PiarcBusy) {
        if ($null -eq $native) {
            # No native program ran: the result is the command's success, and $LASTEXITCODE
            # keeps the value it had before.
            $code = if ($succeeded) { 0 } else { 1 }
            $native = $global:__PiarcExitBefore
        } else {
            $code = if ($succeeded) { 0 } elseif ($native -ne 0) { $native } else { 1 }
        }
        $out += "$esc]133;D;$code$bel"
        $global:__PiarcBusy = $false
    }
    $location = Get-Location
    if ($location.Provider.Name -eq 'FileSystem') {
        $path = [uri]::EscapeUriString(($location.ProviderPath -replace '\\', '/'))
        $out += "$esc]7;file://$env:COMPUTERNAME/$path$bel"
    }
    $out += "$esc]133;A$bel"
    $out += & $global:__PiarcPrompt
    $out += "$esc]133;B$bel"
    $global:LASTEXITCODE = $native
    return $out
}

if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        $line = $null
        $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        # A native program sets $LASTEXITCODE again; anything else leaves it empty.
        $global:__PiarcExitBefore = $global:LASTEXITCODE
        $global:LASTEXITCODE = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        $encoded = [uri]::EscapeDataString($line)
        [Console]::Write("$($global:__PiarcEsc)]133;C;cmdline_url=$encoded$($global:__PiarcBel)")
        $global:__PiarcBusy = $true
    }
}
