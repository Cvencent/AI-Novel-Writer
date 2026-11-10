# This helper is deliberately shipped as an extraResource instead of relying on
# Node's path APIs. It opens every component below the supplied root directory
# handle with OBJ_DONT_REPARSE, so a junction/symlink replacement cannot redirect
# a later read, mkdir, list, or atomic replacement outside that root.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# The C# security core lives in windows-safe-file-system.core.cs (one source; the native exe compiles it too).
# Deliberately not inlined here: two copies drift, and drift means the two backends can validate paths differently.
$nativeSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'windows-safe-file-system.core.cs')

function Write-HelperResponse([object]$response) {
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
}

# 单个请求的处理体：成功或失败都写一行 JSON 响应，绝不把异常抛出函数（serve 模式要活下去）。
function Invoke-HelperRequest([string]$inputLine) {
try {
  if ($null -eq $inputLine -or $inputLine.Length -gt 100000000) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_REQUEST_TOO_LARGE')
  }
  $request = $inputLine | ConvertFrom-Json -ErrorAction Stop
  if (($null -eq $request) -or ($request.PSObject.Properties.Name -notcontains 'operation') -or ($request.PSObject.Properties.Name -notcontains 'rootPath') -or ($request.PSObject.Properties.Name -notcontains 'relativePath') -or ($request.PSObject.Properties.Name -notcontains 'rootIdentity')) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_PATH')
  }
  if ($request.rootPath -isnot [string] -or $request.relativePath -isnot [string]) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_PATH')
  }
  if ($null -eq $request.rootIdentity -or ($request.rootIdentity.PSObject.Properties.Name -notcontains 'volumeSerialNumber') -or ($request.rootIdentity.PSObject.Properties.Name -notcontains 'fileIndex') -or $request.rootIdentity.volumeSerialNumber -isnot [string] -or $request.rootIdentity.fileIndex -isnot [string]) {
    throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_PATH')
  }
  $rootIdentity = [AiNovelSecureFs.SecureHandleFileSystem]::ParseRootIdentity(
    $request.rootIdentity.volumeSerialNumber,
    $request.rootIdentity.fileIndex)

  switch ([string]$request.operation) {
    'read' {
      if (($request.PSObject.Properties.Name -notcontains 'maxBytes') -or $request.maxBytes -isnot [int] -or $request.maxBytes -lt 0 -or $request.maxBytes -gt 67108864) {
        throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_OPERATION')
      }
      $contentBase64 = [AiNovelSecureFs.SecureHandleFileSystem]::ReadTextBase64($request.rootPath, $rootIdentity, $request.relativePath, [int]$request.maxBytes)
      Write-HelperResponse ([pscustomobject]@{ ok = $true; contentBase64 = $contentBase64 })
      break
    }
    'write' {
      if ($request.PSObject.Properties.Name -notcontains 'contentBase64' -or $request.contentBase64 -isnot [string]) {
        throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_TEXT')
      }
      $mustAlreadyExist = $false
      if ($request.PSObject.Properties.Name -contains 'mustAlreadyExist') {
        if ($request.mustAlreadyExist -isnot [bool]) {
          throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_OPERATION')
        }
        $mustAlreadyExist = [bool]$request.mustAlreadyExist
      }
      $content = [Convert]::FromBase64String([string]$request.contentBase64)
      $session = $null
      try {
        $session = [AiNovelSecureFs.SecureHandleFileSystem]::BeginAtomicWrite($request.rootPath, $rootIdentity, $request.relativePath, $content, $mustAlreadyExist)
        Write-HelperResponse ([pscustomobject]@{ ok = $true; phase = 'ready' })
        $commandLine = [Console]::In.ReadLine()
        if ($null -eq $commandLine -or $commandLine.Length -gt 4096) {
          throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_CANCELLED')
        }
        $command = $commandLine | ConvertFrom-Json -ErrorAction Stop
        if ($command.command -ne 'commit') {
          Write-HelperResponse ([pscustomobject]@{ ok = $false; code = 'SECURE_FS_CANCELLED' })
          break
        }
        $session.Commit($mustAlreadyExist)
        Write-HelperResponse ([pscustomobject]@{ ok = $true })
      } finally {
        if ($null -ne $session) { $session.Dispose() }
      }
      break
    }
    'mkdir' {
      [AiNovelSecureFs.SecureHandleFileSystem]::MakeDirectory($request.rootPath, $rootIdentity, $request.relativePath)
      Write-HelperResponse ([pscustomobject]@{ ok = $true })
      break
    }
    'exists' {
      $exists = [AiNovelSecureFs.SecureHandleFileSystem]::Exists($request.rootPath, $rootIdentity, $request.relativePath)
      Write-HelperResponse ([pscustomobject]@{ ok = $true; exists = $exists })
      break
    }
    'list' {
      $entries = @(
        [AiNovelSecureFs.SecureHandleFileSystem]::ListDirectory($request.rootPath, $rootIdentity, $request.relativePath) |
          ForEach-Object { [pscustomobject]@{ name = $_.Name; isDirectory = $_.IsDirectory } }
      )
      Write-HelperResponse ([pscustomobject]@{ ok = $true; entries = $entries })
      break
    }
    default {
      throw [AiNovelSecureFs.SecureFsException]::new('SECURE_FS_INVALID_OPERATION')
    }
  }
} catch {
  $code = 'SECURE_FS_HELPER_FAILED'
  if ($_.Exception -is [AiNovelSecureFs.SecureFsException]) {
    $code = $_.Exception.Code
  } elseif ($_.Exception.InnerException -is [AiNovelSecureFs.SecureFsException]) {
    $code = $_.Exception.InnerException.Code
  } elseif ($_.Exception.Message -match '^SECURE_FS_[A-Z0-9_]+$') {
    $code = $_.Exception.Message
  }
  Write-HelperResponse ([pscustomobject]@{ ok = $false; code = $code })
}
}

# 编译一次 C# 内联源码。一次性模式与常驻模式都要先过这一步（实测 210ms），
# 常驻模式把这一次成本摊到全部后续请求上（每次从 ~500ms 降到个位数毫秒）。
try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop | Out-Null
  $compiled = $true
} catch {
  $compiled = $false
}

if (-not $compiled) {
  Write-HelperResponse ([pscustomobject]@{ ok = $false; code = 'SECURE_FS_HELPER_FAILED' })
  exit 1
}

$serveMode = $false
foreach ($argument in $args) { if ($argument -eq '--serve') { $serveMode = $true } }

if ($serveMode) {
  # 常驻模式：stdin 每行一个请求（NDJSON），逐行响应。EOF 即退出。
  # 安全语义与一次性模式完全一致——同一个 C# 实现、同一套 OBJ_DONT_REPARSE 校验，
  # 只是不再每次重新起进程 + 重新编译。
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Length -eq 0) { continue }
    Invoke-HelperRequest $line
    [Console]::Out.Flush()
  }
} else {
  Invoke-HelperRequest ([Console]::In.ReadLine())
}
