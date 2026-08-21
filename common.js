// ===== 데이터 구조 =====
// config.domains: [
//   { uuid, domain: "a.example.com", ruleId: 1, method: "redirect" | "hosts",
//     servers: [{ name: "WEB1", ip: "10.0.0.11" }, ...] },
//   ...
// ]
// config.nextRuleId: 다음에 새 도메인에 부여할 ruleId (계속 증가, 재사용 안 함)
// method 없는 기존 도메인은 "redirect"로 취급(하위호환).
//
// selections: { [domain.uuid]: serverIndex(number) | "off" }

const RULE_ID_BASE = 1000;
const RULE_SLOT_SIZE = 3; // 도메인 1개당 규칙 3개(redirect + Host 헤더 + IP직접요청 Host 헤더) 예약

const NATIVE_HOST_NAME = "com.newbie79.host_switcher";

const ALL_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image",
  "font", "object", "xmlhttprequest", "ping", "csp_report",
  "media", "websocket", "webtransport", "webbundle", "other"
];

function defaultConfig() {
  return { domains: [], nextRuleId: 1 };
}

async function loadConfig() {
  const { config } = await chrome.storage.sync.get("config");
  if (!config || !Array.isArray(config.domains)) return defaultConfig();
  return config;
}

async function saveConfig(config) {
  await chrome.storage.sync.set({ config });
}

async function loadSelections() {
  const { selections } = await chrome.storage.local.get("selections");
  return selections || {};
}

async function saveSelections(selections) {
  await chrome.storage.local.set({ selections });
}

async function setSelection(domainUuid, value) {
  const selections = await loadSelections();
  selections[domainUuid] = value;
  await saveSelections(selections);
  return selections;
}

function ruleIds(domain) {
  const base = RULE_ID_BASE + domain.ruleId * RULE_SLOT_SIZE;
  return { redirectId: base, headerId: base + 1, ipHeaderId: base + 2 };
}

function domainMethod(domain) {
  return domain.method === "hosts" ? "hosts" : "redirect";
}

// 현재 config + selections 기준으로 declarativeNetRequest 동적 규칙 전체를 재구성.
// method === "hosts"인 도메인은 여기서 다루지 않는다(네이티브 호스트가 hosts 파일로 처리).
async function applyRedirectRules(config, selections) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const addRules = [];

  for (const domain of config.domains) {
    if (domainMethod(domain) !== "redirect") continue;
    const sel = selections[domain.uuid];
    if (sel === undefined || sel === "off") continue;
    const server = domain.servers[sel];
    if (!server || !server.ip || !domain.domain) continue;

    const { redirectId, headerId, ipHeaderId } = ruleIds(domain);

    addRules.push({
      id: redirectId,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { transform: { host: server.ip } }
      },
      condition: {
        urlFilter: `||${domain.domain}^`,
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });

    addRules.push({
      id: headerId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Host", operation: "set", value: domain.domain }
        ]
      },
      condition: {
        urlFilter: `||${domain.domain}^`,
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });

    // 메인 페이지가 IP로 리다이렉트되고 나면 상대경로 이미지/스크립트 등은
    // 브라우저가 domain이 아니라 IP를 origin 삼아 직접 IP로 요청을 보낸다.
    // 이 요청들은 위 두 규칙의 urlFilter(도메인 문자열)에 걸리지 않으므로
    // Host 헤더가 IP로 나가 서버의 vhost 라우팅이 깨진다. IP로 직접 가는
    // 요청도 별도로 잡아 Host를 도메인으로 되돌려준다.
    addRules.push({
      id: ipHeaderId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Host", operation: "set", value: domain.domain }
        ]
      },
      condition: {
        urlFilter: `||${server.ip}^`,
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

// method === "hosts"이며 선택이 "off"가 아닌 도메인들을 네이티브 메시징 호스트에
// 통째로 전달해 hosts 파일 마커 블록을 재구성한다. 네이티브 호스트가 설치돼 있지
// 않으면 chrome.runtime.lastError가 채워지므로 {ok:false, error} 형태로 정규화해서 반환한다.
async function applyHostsFile(config, selections) {
  const entries = [];
  for (const domain of config.domains) {
    if (domainMethod(domain) !== "hosts") continue;
    const sel = selections[domain.uuid];
    if (sel === undefined || sel === "off") continue;
    const server = domain.servers[sel];
    if (!server || !server.ip || !domain.domain) continue;
    entries.push({ domain: domain.domain, ip: server.ip });
  }

  if (entries.length === 0 && !config.domains.some(d => domainMethod(d) === "hosts")) {
    // hosts 방식 도메인이 아예 없으면 네이티브 호스트를 호출할 필요가 없다.
    return { ok: true, skipped: true };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: "apply", entries },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "네이티브 호스트로부터 응답이 없습니다." });
        }
      }
    );
  });
}

// 네이티브 헬퍼(install.ps1로 등록한 native messaging host)가 연결 가능한 상태인지 확인.
async function pingNativeHost() {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: "ping" },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: "네이티브 호스트로부터 응답이 없습니다." });
        }
      }
    );
  });
}

// 리다이렉트 방식 규칙 + hosts 파일 방식을 함께 적용. hosts 파일 결과를 반환해서
// 팝업/옵션 페이지가 네이티브 호스트 오류를 사용자에게 보여줄 수 있게 한다.
async function applyAll(config, selections) {
  await applyRedirectRules(config, selections);
  return applyHostsFile(config, selections);
}

function uuid() {
  return (crypto.randomUUID ? crypto.randomUUID() :
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    }));
}
