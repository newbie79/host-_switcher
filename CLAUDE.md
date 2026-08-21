# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Chrome Manifest V3 확장 프로그램. 팝업에서 라디오 버튼을 클릭해 등록된 도메인의 요청을 지정한
서버 IP로 라우팅한다. 도메인 여러 개 × 도메인당 서버 여러 개를 등록할 수 있고, 각 도메인은
독립적으로 전환된다. 도메인마다 두 가지 라우팅 방식 중 하나를 고른다(`domain.method`):

- **`redirect`(기본값)**: `declarativeNetRequest`로 요청 URL 자체를 IP로 바꿔치기. 순수 확장
  기능만으로 동작하지만, HTTPS에서는 인증서 CN 불일치 때문에 서브리소스(이미지/CSS/JS)가
  깨질 수 있다.
- **`hosts`**: 실제 OS의 hosts 파일에 `IP 도메인` 항목을 써서 DNS 해석 단계에서만 IP를 바꾼다.
  URL이 도메인 그대로 유지되므로 인증서 문제가 없지만, 확장 API만으로는 파일시스템을 못 건드리기
  때문에 로컬에 별도로 설치하는 **네이티브 메시징 호스트**(`native-host/`)가 필요하다.

빌드/테스트/린트 툴체인은 없다. 팝업/옵션 페이지는 순수 HTML + 바닐라 JS이며 npm 패키지나
번들러를 쓰지 않는다. 단, `hosts` 방식을 쓰려면 `native-host/install.ps1`로 로컬에 1회
네이티브 헬퍼를 설치해야 한다(자세한 내용은 "네이티브 메시징 호스트 (hosts 방식)" 절 참고).
네이티브 헬퍼 자체는 Python으로 작성됐지만(`host_native.py`) PyInstaller로 미리
`host_native.exe`(단일 실행 파일)로 빌드해 리포에 포함시켜뒀다 — **최종 사용자는 Python을
설치할 필요가 없다.** `host_native.py`를 고친 경우에만 재빌드가 필요하다(README의
"native-host 재빌드하기" 절 참고).

## 개발 / 실행

- `chrome://extensions` → 개발자 모드 ON → "압축해제된 확장 프로그램을 로드" → 이 폴더 선택
- 코드 수정 후: 확장 카드의 새로고침 아이콘을 눌러 리로드. popup/options는 다시 열면 새 코드가 뜬다.
- 디버깅: 팝업은 우클릭 → "검사", 옵션 페이지는 일반 페이지처럼 DevTools 사용.
- 동적 규칙 확인:
  `chrome.declarativeNetRequest.getDynamicRules().then(console.log)` (팝업/옵션 페이지 콘솔에서)
- 자동화된 테스트는 없다. 검증은 실제 도메인 접속 후 개발자도구 Network 탭에서
  Remote Address가 대상 IP인지 확인하는 방식.

## 아키텍처

### 스크립트 로딩 모델 (중요)

background service worker가 **없다**. `common.js`가 `popup.html`, `options.html` 양쪽에
`<script src="common.js">` (클래식 스크립트, ES module 아님)로 먼저 로드되고, 그 안의 함수들이
전역으로 노출되어 `popup.js` / `options.js`에서 그대로 호출된다.
→ 공유 로직을 추가할 때는 `common.js`에 최상위 `function`으로 선언한다. `import`/`export`를
도입하면 `<script>` 태그를 `type="module"`로 바꿔야 하고 두 페이지 모두 깨진다.

네트워크 규칙은 declarativeNetRequest **동적 규칙(dynamic rules)** 으로 저장되므로 확장이
실행 중이 아니어도(팝업이 닫혀 있어도, 브라우저를 재시작해도) Chrome이 계속 적용한다.
이 때문에 상시 실행되는 워커가 필요 없다.

### 상태 저장 위치

| 데이터 | 저장소 | 이유 |
|---|---|---|
| `config` (도메인/서버 목록, `nextRuleId`) | `chrome.storage.sync` | 같은 Google 계정의 다른 PC와 동기화 |
| `selections` (도메인별 현재 선택) | `chrome.storage.local` | PC/프로필마다 다른 서버를 보게 하려고 의도적으로 분리 |

`selections`는 `{ [domain.uuid]: serverIndex(number) | "off" }` 형태로, **도메인 uuid로 키를 잡고
서버는 배열 인덱스로 가리킨다.** 즉 `domain.servers` 배열 순서를 바꾸거나 중간 항목을 지우면
기존 선택이 다른 서버를 가리키게 된다. (`options.js`의 저장 로직이 IP가 빈 서버를 걸러내므로
여기서도 인덱스가 밀릴 수 있다 — 서버 목록 편집 로직을 건드릴 때 주의.)

### 규칙 ID 할당

도메인 1개당 규칙 3개를 쓴다: **redirect 규칙 + `Host` 헤더 재설정 규칙(도메인 요청용) +
`Host` 헤더 재설정 규칙(IP 직접 요청용)**. IP로 붙은 뒤에도 서버가 vhost 라우팅을 정상 수행하도록
`Host` 헤더를 원래 도메인으로 되돌리는 것이 핵심이다.

메인 페이지가 IP로 리다이렉트되면 그 문서의 origin이 도메인이 아니라 IP가 되므로, 페이지 안의
상대경로 리소스(이미지/CSS/JS 등)는 브라우저가 domain 문자열을 전혀 거치지 않고 곧장
`http://IP/...`로 요청을 보낸다. 앞의 두 규칙은 `urlFilter`가 도메인 문자열 기준이라 이 요청들을
못 잡기 때문에, IP로 직접 가는 요청을 따로 매칭해 Host를 도메인으로 되돌리는 세 번째 규칙이 필요하다
(안 하면 리다이렉트 직후 로드되는 이미지/리소스가 깨진다).

ID는 `common.js`의 `ruleIds()`에서 `RULE_ID_BASE(1000) + domain.ruleId * RULE_SLOT_SIZE(3)`로
계산한다. `domain.ruleId`는 `config.nextRuleId`에서 발급받고 단조 증가하며 **도메인을 삭제해도
재사용하지 않는다** — 재사용하면 삭제 전 규칙과 ID가 충돌한다. `applyRedirectRules()`는 매번
`getDynamicRules()`로 실제 등록된 규칙 ID를 조회해서 통째로 지운 뒤 새로 추가하므로(공식으로
역산하지 않음), `RULE_SLOT_SIZE`를 늘려도 별도 마이그레이션 없이 다음 `applyRedirectRules()` 호출에서
바로 정리된다.

같은 IP를 서버로 쓰는 도메인이 두 개 이상 동시에 활성화되면, IP 직접 요청용 Host 재설정 규칙이
서로 충돌해 마지막에 적용된 하나의 도메인만 정상 동작할 수 있다(원래 hosts 파일도 동일 IP에 대해
요청 시점의 도메인 정보를 알아야 vhost를 구분하는데, IP로 곧장 들어온 요청은 어느 도메인이 보낸
건지 알 수 없기 때문). 흔한 케이스는 아니라 별도 처리는 하지 않는다.

### 규칙 적용 흐름

`method: "redirect"`인 도메인은 `applyRedirectRules(config, selections)`가 담당한다. 증분 갱신이
아니라 **전체 재구성**이다: 기존 동적 규칙을 전부 제거한 뒤, method가 redirect이고 `"off"`가
아닌 도메인들만 다시 add 한다. `method: "hosts"`인 도메인은 여기서 완전히 제외된다(대신
`applyHostsFile()`이 처리).

`method: "hosts"`인 도메인은 `applyHostsFile(config, selections)`가 담당한다. redirect와 같은
"전체 재구성" 철학으로, 매번 hosts 방식 도메인 전체의 `{domain, ip}` 목록을 만들어
`chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {action:"apply", entries})`로 네이티브 호스트에
통째로 넘긴다. 네이티브 호스트가 hosts 파일의 마커 블록을 통째로 교체한다(아래 절 참고). 네이티브
호스트가 설치돼 있지 않으면 `chrome.runtime.lastError`가 채워지는데, 이를 `{ok:false, error}`로
정규화해서 반환한다 — 팝업/옵션 페이지가 이 값을 받아 사용자에게 에러를 보여준다.

→ 규칙을 바꾸는 모든 경로(팝업의 라디오 변경, 옵션 페이지의 저장)는 최신 `config`와 `selections`를
넘겨 `applyAll(config, selections)` 하나만 호출하면 된다(내부에서 위 두 함수를 순서대로 호출).
개별 규칙을 직접 add/remove 하거나 hosts 파일을 직접 건드리지 말 것.

### 네이티브 메시징 호스트 (hosts 방식)

`native-host/host_native.py`(빌드 결과물: `host_native.exe`)가 Chrome Native Messaging 표준
프로토콜(stdin/stdout, 4바이트 리틀엔디안 길이 + UTF-8 JSON)을 구현한다. 확장이 요청을 보낼 때마다
Chrome이 이 프로세스를 새로 실행하고 응답 후 종료하므로, 상태를 들고 있지 않고 매번 hosts 파일을
처음부터 읽고 다시 쓴다. `host_manifest.json`의 `path`가 `host_native.exe`를 직접 가리키므로
(중간에 `.bat`/`python` PATH 탐색을 거치지 않는다), 실행 환경의 PATH 우선순위에 따라 엉뚱한
`python.exe`(예: Microsoft Store 앱 실행 별칭)로 풀리는 문제가 없다 — 이건 실제로 겪었던 버그다.

- hosts 파일(`C:\Windows\System32\drivers\etc\hosts`)에서
  `# === HOST_SWITCHER START ===` ~ `# === HOST_SWITCHER END ===` 마커 사이 블록만 통째로
  교체한다(없으면 파일 끝에 추가). 사용자가 직접 관리하는 다른 hosts 항목은 건드리지 않는다.
- **hosts 파일을 그 자리에서 직접 열어(`open(HOSTS_PATH, "w")`) 덮어쓴다 — 임시 파일 +
  `os.replace()` 방식을 쓰지 않는다.** `install.ps1`이 부여하는 권한은 hosts 파일 "자체"에 대한
  것이라, 같은 폴더(`System32\drivers\etc`)에 새 임시 파일을 만드는 건 별도의 폴더 단위 권한이
  필요해서 실패한다(Windows에서 `os.access()`가 실제 ACL을 못 읽는 결함 때문에 Python
  `tempfile.mkstemp()`가 이 권한 거부를 "이름 충돌"로 착각해 최대 1만 번 재시도하며 사실상
  멈춘 것처럼 보였다 — 실제로 겪은 버그). 폴더 권한을 넓히는 대신 파일 자체를 직접 덮어쓰는
  쪽을 선택했다(원자성은 포기하지만 파일이 작아 위험은 낮다).
- `domain`/`ip` 값은 매 요청마다 호스트네임/IPv4 정규식으로 검증한 뒤 한 줄씩만 직렬화한다
  (개행이나 공백이 섞인 값으로 hosts 파일에 임의 라인이 주입되는 것을 막기 위함).
- Windows에서는 stdin/stdout을 반드시 `sys.stdin.buffer` / `sys.stdout.buffer`로 바이너리 모드로
  열어야 한다. 텍스트 모드로 열면 개행이 CRLF로 변환되어 길이 프리픽스 기반 프로토콜이 깨진다.

`host_native.py`를 고치면 `host_native.exe`를 재빌드해야 반영된다(README의 "native-host
재빌드하기" 절 — PyInstaller 필요). 재빌드 자체는 Claude가 대신 실행해도 되는 일반 빌드
작업이다.

설치(`native-host/install.ps1`, **사용자가 관리자 권한 PowerShell에서 직접 실행**)가 하는 일:

1. `icacls`로 hosts 파일에 현재 로그인 계정의 쓰기 권한을 부여(최초 1회만 관리자 권한 필요, 이후엔
   네이티브 호스트가 권한 상승 없이 hosts 파일을 계속 수정할 수 있다).
2. `host_manifest.template.json`을 실제 절대경로(`host_native.exe`)/확장 ID로 채워
   `host_manifest.json` 생성.
3. `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.newbie79.host_switcher` 레지스트리 키에
   그 매니페스트 경로를 등록해 Chrome이 이 native messaging host를 찾을 수 있게 함.

이 설치 스크립트는 시스템 파일 권한/레지스트리를 바꾸는 작업이라 Claude가 대신 실행하지 않는다.
(반대로 `host_manifest.json`의 내용을 고치는 것 자체는 일반 파일 편집이라 문제없다 — 레지스트리는
그 파일의 "경로"만 가리키므로, 경로가 안 바뀌는 한 재등록 없이 내용만 바꿔도 다음 호출부터
반영된다.)

### UI 두 페이지의 상태 취급 차이

- `popup.js`: 저장소가 곧 진실. 라디오 변경 → `setSelection()`으로 즉시 저장 → `applyAll()`.
  "저장" 버튼이 없다. hosts 방식 도메인에서 네이티브 호스트 호출이 실패하면 상태 텍스트에
  에러를 보여준다. hosts 방식 도메인을 "off"가 아닌 다른 서버로 전환 성공하면
  `chrome://net-internals/#dns` 탭을 자동으로 연다 — Chrome은 hosts 파일이 바뀌어도 자체 DNS
  캐시(브라우저 전체 공유, 탭 단위 아님)를 잠깐 더 쓰기 때문에, 그 화면에서 "Clear host cache"를
  눌러야 새 탭에서도 확실하게 새 IP로 붙는다(확장은 `chrome://` 페이지를 스크립트로 조작할 수
  없어서 클릭 자체는 자동화 불가 — 탭을 열어주는 것까지만).
- `options.js`: 모듈 전역 `state`에 편집 중인 config를 들고 있다가 **"저장" 클릭 시에만** 반영한다.
  저장 시 (1) 도메인명 빈 것과 IP 빈 서버를 제거, (2) 삭제된 도메인의 `selections` 엔트리 정리,
  (3) `applyAll()` 재적용을 순서대로 수행한다. 도메인 카드마다 리다이렉트/hosts 방식을 고르는
  라디오가 있고, hosts를 고르면 `pingNativeHost()`로 네이티브 헬퍼 연결 상태를 배지로 보여준다.
  모든 편집 액션은 `state`를 바꾸고 `render()`로 DOM을 통째로 다시 그린다(핸들러가 `dIdx`/`sIdx`를
  클로저로 잡고 있어 부분 갱신은 인덱스가 어긋난다).

## 알려진 제약

- `method: "redirect"`인 HTTPS 도메인을 IP로 리다이렉트하면 인증서 CN 불일치 경고
  (`NET::ERR_CERT_COMMON_NAME_INVALID`)가 뜬다. 메인 페이지는 "고급 → 계속 진행"으로 우회할 수
  있지만, 서브리소스(이미지/CSS/JS)는 브라우저가 클릭스루 자체를 제공하지 않아 그냥 실패한다.
  이 문제가 있는 도메인은 `method: "hosts"`로 바꾸는 게 근본적인 해결책이다.
- `method: "hosts"`는 OS 전역 hosts 파일을 쓰기 때문에, `config`(storage.sync)로 여러 PC에 동기화된
  같은 도메인이라도 **PC/프로필별로 다른 서버를 보게 하는 기존 기능이 적용되지 않는다** — 그 PC에서
  마지막에 적용한 매핑이 시스템 전체에 적용된다. `redirect` 방식 도메인은 기존대로
  `selections`(storage.local) 기준 프로필별 분리가 유지된다.
- `manifest.json`에 아이콘이 정의되어 있지 않다(툴바에 기본 아이콘 표시).
