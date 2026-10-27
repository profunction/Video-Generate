param([string]$TextFile,[string]$OutputFile,[string]$VoiceName)
$ErrorActionPreference = 'Stop'
# Report one readable line on stderr instead of a PowerShell error record.
try {
 Add-Type -AssemblyName System.Speech
 $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
 try {
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  $voices = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled })
  if (-not $voices) { throw 'No Windows SAPI desktop voice is installed. Install one, or disable narration.' }
  if ($VoiceName) {
   $found = $voices | Where-Object { $_.VoiceInfo.Name -eq $VoiceName } | Select-Object -First 1
   if (-not $found) { throw ("SAPI voice '$VoiceName' is not installed. Installed voices: " + (($voices | ForEach-Object { $_.VoiceInfo.Name }) -join ', ')) }
   $speaker.SelectVoice($found.VoiceInfo.Name)
  }
  elseif ($text -match '[\u4e00-\u9fff]') {
   $chinese = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
   if (-not $chinese) { throw 'Install a Chinese SAPI desktop voice in Windows, or disable narration.' }
   $speaker.SelectVoice($chinese.VoiceInfo.Name)
  }
  $speaker.Rate = 1
  $speaker.SetOutputToWaveFile($OutputFile)
  $speaker.Speak($text)
 } finally { $speaker.Dispose() }
} catch {
 [Console]::Error.WriteLine($_.Exception.Message)
 exit 1
}
