param([string]$TextFile,[string]$OutputFile,[string]$VoiceName)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
 $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
 if ($VoiceName) { $speaker.SelectVoice($VoiceName) }
 elseif ($text -match '[\u4e00-\u9fff]') {
  $chinese = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
  if (-not $chinese) { throw 'Install a Chinese SAPI desktop voice in Windows, or disable narration.' }
  $speaker.SelectVoice($chinese.VoiceInfo.Name)
 }
 $speaker.Rate = 1
 $speaker.SetOutputToWaveFile($OutputFile)
 $speaker.Speak($text)
} finally { $speaker.Dispose() }
