<#
.SYNOPSIS
  install.ps1로 등록한 native messaging host 레지스트리 항목을 제거합니다.

.DESCRIPTION
  hosts 파일에 부여한 쓰기 권한(icacls)은 자동으로 되돌리지 않습니다. 필요하면 아래처럼
  관리자 권한 PowerShell에서 직접 제거하세요:
    icacls "$env:WINDIR\System32\drivers\etc\hosts" /remove "$env:USERDOMAIN\$env:USERNAME"
  (단, hosts 파일 자체에 남아있는 HOST_SWITCHER 마커 블록은 이 스크립트가 지우지 않습니다.
   필요하면 hosts 파일을 열어 마커 블록을 직접 삭제하세요.)
#>

$hostName = "com.newbie79.host_switcher"
$regKeyPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path $regKeyPath) {
    Remove-Item -Path $regKeyPath -Force
    Write-Host "레지스트리 항목을 제거했습니다: $regKeyPath" -ForegroundColor Green
} else {
    Write-Host "등록된 항목이 없습니다: $regKeyPath"
}

Write-Host ""
Write-Host "참고: hosts 파일 쓰기 권한(icacls)과 hosts 파일 안의 HOST_SWITCHER 마커 블록은"
Write-Host "이 스크립트가 건드리지 않습니다. 위 스크립트 설명(Get-Help .\uninstall.ps1 -Full)을 참고하세요."
