<#
.SYNOPSIS
  Host Switcher 확장의 "hosts 파일" 방식을 쓰기 위한 1회성 로컬 설치 스크립트.

.DESCRIPTION
  1) hosts 파일(C:\Windows\System32\drivers\etc\hosts)에 현재 로그인 계정의 쓰기 권한을 부여합니다.
     (이 작업 자체는 관리자 권한이 필요합니다. 이후로는 이 계정으로 관리자 권한 없이 hosts 파일을 쓸 수 있습니다.)
  2) host_manifest.template.json을 채워 host_manifest.json을 생성합니다.
  3) Chrome이 이 native messaging host를 찾을 수 있도록 레지스트리에 등록합니다.

.PARAMETER ExtensionId
  chrome://extensions 에서 "개발자 모드" 켠 뒤 보이는 이 확장의 ID (32자리).

.EXAMPLE
  # 관리자 권한 PowerShell에서:
  .\install.ps1 -ExtensionId "abcdefghijklmnopabcdefghijklmnop"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "관리자 권한 PowerShell에서 실행해주세요 (hosts 파일 권한 변경에 필요합니다)."
    exit 1
}

$hostsPath = "$env:WINDIR\System32\drivers\etc\hosts"
if (-not (Test-Path $hostsPath)) {
    Write-Error "hosts 파일을 찾을 수 없습니다: $hostsPath"
    exit 1
}

$currentUser = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "1) hosts 파일 쓰기 권한을 '$currentUser' 계정에 부여합니다..."
icacls $hostsPath /grant "${currentUser}:(M)" | Out-Null
Write-Host "   완료. 이후로는 관리자 권한 없이 hosts 파일을 수정할 수 있습니다."

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runHostBat = Join-Path $scriptDir "run_host.bat"
$manifestTemplatePath = Join-Path $scriptDir "host_manifest.template.json"
$manifestOutPath = Join-Path $scriptDir "host_manifest.json"

Write-Host "2) native messaging host manifest를 생성합니다: $manifestOutPath"
$template = Get-Content $manifestTemplatePath -Raw
# JSON 문자열 안에 넣을 경로이므로 백슬래시 1개를 JSON 이스케이프(백슬래시 2개)로 바꾼다.
# -replace의 패턴 '\\'는 정규식이라 백슬래시 1개를 매치하지만, 치환 문자열 '\\'는 리터럴이라
# 그대로 백슬래시 2개가 출력된다(치환 문자열에는 백슬래시 이스케이프 규칙이 없음, $만 특수).
$escapedBatPath = $runHostBat -replace '\\', '\\'
$manifestContent = $template `
    -replace '__RUN_HOST_BAT_PATH__', $escapedBatPath `
    -replace '__EXTENSION_ID__', $ExtensionId
# Windows PowerShell 5.1에는 -Encoding utf8NoBOM이 없어서(7+ 전용) .NET API로 BOM 없이 직접 쓴다.
# (BOM이 붙으면 Chrome이 이 JSON manifest를 못 읽을 수 있다.)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestOutPath, $manifestContent, $utf8NoBom)

Write-Host "3) 레지스트리에 native messaging host를 등록합니다..."
$hostName = "com.newbie79.host_switcher"
$regKeyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $regKeyPath -Force | Out-Null
Set-ItemProperty -Path $regKeyPath -Name "(default)" -Value $manifestOutPath

Write-Host ""
Write-Host "설치 완료." -ForegroundColor Green
Write-Host "chrome://extensions 에서 Host Switcher 확장을 새로고침한 뒤,"
Write-Host "옵션 페이지에서 도메인을 'hosts 파일' 방식으로 선택하면 바로 사용할 수 있습니다."
