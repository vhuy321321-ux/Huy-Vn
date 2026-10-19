$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$archivePath = Join-Path $root 'GoalFlow-Android-WebView-MVP.zip'
$runId = [guid]::NewGuid().ToString('N')
$tempPath = Join-Path $root ".GoalFlow-Android-WebView-MVP.$runId.pending.zip"
$backupPath = Join-Path ([IO.Path]::GetTempPath()) "GoalFlow-Android-WebView-MVP.$runId.previous.zip"
$mappings = @{
    'GoalFlowAndroid-WebView/app/src/main/assets/index.html' = Join-Path $root 'worker/public/index.html'
    'GoalFlowAndroid-WebView/app/src/main/AndroidManifest.xml' = Join-Path $root 'worker/android-src/app/src/main/AndroidManifest.xml'
    'GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/MainActivity.kt' = Join-Path $root 'worker/android-src/app/src/main/java/com/goalflow/app/MainActivity.kt'
    'GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/GoalData.kt' = Join-Path $root 'worker/android-src/app/src/main/java/com/goalflow/app/GoalData.kt'
    'GoalFlowAndroid-WebView/app/src/main/java/com/goalflow/app/GoalWidgetProvider.kt' = Join-Path $root 'worker/android-src/app/src/main/java/com/goalflow/app/GoalWidgetProvider.kt'
}

foreach ($sourcePath in $mappings.Values) {
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Missing reviewed source file: $sourcePath" }
}

$inputArchive = $null
$outputArchive = $null
$expectedEntryCount = 0
try {
    $inputArchive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    $expectedEntryCount = $inputArchive.Entries.Count
    foreach ($name in $mappings.Keys) {
        if (@($inputArchive.Entries | Where-Object FullName -eq $name).Count -ne 1) { throw "Expected exactly one ZIP entry: $name" }
    }
    $outputFile = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew)
    $outputArchive = [IO.Compression.ZipArchive]::new($outputFile, [IO.Compression.ZipArchiveMode]::Create)
    foreach ($entry in $inputArchive.Entries) {
        $destination = $outputArchive.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
        $destination.LastWriteTime = $entry.LastWriteTime
        $destination.ExternalAttributes = $entry.ExternalAttributes
        $sourceStream = $null
        $destinationStream = $null
        try {
            $sourceStream = if ($mappings.ContainsKey($entry.FullName)) {
                [IO.File]::OpenRead($mappings[$entry.FullName])
            } else {
                $entry.Open()
            }
            $destinationStream = $destination.Open()
            $sourceStream.CopyTo($destinationStream)
        } finally {
            if ($destinationStream) { $destinationStream.Dispose() }
            if ($sourceStream) { $sourceStream.Dispose() }
        }
    }
} finally {
    if ($outputArchive) { $outputArchive.Dispose() }
    if ($inputArchive) { $inputArchive.Dispose() }
}

$verification = [IO.Compression.ZipFile]::OpenRead($tempPath)
try {
    if ($verification.Entries.Count -ne $expectedEntryCount) {
        throw 'Archive entry count changed unexpectedly.'
    }
    foreach ($name in $mappings.Keys) {
        $entry = $verification.GetEntry($name)
        $sourceBytes = [IO.File]::ReadAllBytes($mappings[$name])
        $stream = $entry.Open()
        $memory = [IO.MemoryStream]::new()
        try { $stream.CopyTo($memory) } finally { $memory.Dispose(); $stream.Dispose() }
        $archiveBytes = $memory.ToArray()
        if ($sourceBytes.Length -ne $archiveBytes.Length) { throw "ZIP source verification failed: $name" }
        for ($i = 0; $i -lt $sourceBytes.Length; $i++) {
            if ($sourceBytes[$i] -ne $archiveBytes[$i]) { throw "ZIP source verification failed: $name" }
        }
    }
} finally { $verification.Dispose() }

[IO.File]::Replace($tempPath, $archivePath, $backupPath)
