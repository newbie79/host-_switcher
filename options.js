let state = { domains: [], nextRuleId: 1 };

async function init() {
  state = await loadConfig();
  render();
}

function render() {
  const container = document.getElementById("domains");
  container.innerHTML = "";

  state.domains.forEach((domain, dIdx) => {
    const card = document.createElement("div");
    card.className = "domain-card";

    const topRow = document.createElement("div");
    topRow.className = "row-top";
    topRow.innerHTML = `
      <div class="field">
        <label>도메인</label>
        <input type="text" class="domain-input" placeholder="예: service.example.com" value="${escapeAttr(domain.domain)}" />
      </div>
      <button class="icon-btn danger remove-domain" title="도메인 삭제">✕</button>
    `;
    card.appendChild(topRow);

    topRow.querySelector(".domain-input").addEventListener("input", (e) => {
      state.domains[dIdx].domain = e.target.value.trim();
    });
    topRow.querySelector(".remove-domain").addEventListener("click", () => {
      state.domains.splice(dIdx, 1);
      render();
    });

    const methodRow = document.createElement("div");
    methodRow.className = "method-row";
    const currentMethod = domainMethod(domain);
    methodRow.innerHTML = `
      <label class="method-option">
        <input type="radio" name="m-${domain.uuid}" value="redirect"
          ${currentMethod === "redirect" ? "checked" : ""} />
        리다이렉트
      </label>
      <label class="method-option">
        <input type="radio" name="m-${domain.uuid}" value="hosts"
          ${currentMethod === "hosts" ? "checked" : ""} />
        hosts 파일 (HTTPS 서브리소스 안전, 프로필별 분리 불가)
      </label>
      <span class="native-status"></span>
    `;
    card.appendChild(methodRow);

    const nativeStatusEl = methodRow.querySelector(".native-status");
    if (currentMethod === "hosts") {
      refreshNativeStatus(nativeStatusEl);
    }

    methodRow.querySelectorAll(`input[name="m-${domain.uuid}"]`).forEach(input => {
      input.addEventListener("change", (e) => {
        state.domains[dIdx].method = e.target.value;
        if (e.target.value === "hosts") {
          refreshNativeStatus(nativeStatusEl);
        } else {
          nativeStatusEl.textContent = "";
        }
      });
    });

    const serversWrap = document.createElement("div");
    serversWrap.className = "servers";
    card.appendChild(serversWrap);

    domain.servers.forEach((server, sIdx) => {
      serversWrap.appendChild(buildServerRow(dIdx, sIdx, server));
    });

    const addServerBtn = document.createElement("button");
    addServerBtn.className = "add-server-btn";
    addServerBtn.textContent = "+ 서버 추가";
    addServerBtn.addEventListener("click", () => {
      state.domains[dIdx].servers.push({ name: `WEB${domain.servers.length + 1}`, ip: "" });
      render();
    });
    card.appendChild(addServerBtn);

    container.appendChild(card);
  });
}

function buildServerRow(dIdx, sIdx, server) {
  const row = document.createElement("div");
  row.className = "server-row";
  row.innerHTML = `
    <div class="field">
      <input type="text" class="server-name" placeholder="이름 (예: WEB1)" value="${escapeAttr(server.name)}" />
    </div>
    <div class="field">
      <input type="text" class="server-ip" placeholder="IP 주소 (예: 10.0.0.11)" value="${escapeAttr(server.ip)}" />
    </div>
    <button class="icon-btn danger remove-server" title="서버 삭제">✕</button>
  `;
  row.querySelector(".server-name").addEventListener("input", (e) => {
    state.domains[dIdx].servers[sIdx].name = e.target.value.trim();
  });
  row.querySelector(".server-ip").addEventListener("input", (e) => {
    state.domains[dIdx].servers[sIdx].ip = e.target.value.trim();
  });
  row.querySelector(".remove-server").addEventListener("click", () => {
    state.domains[dIdx].servers.splice(sIdx, 1);
    render();
  });
  return row;
}

function escapeAttr(str) {
  return (str ?? "").replace(/"/g, "&quot;");
}

async function refreshNativeStatus(el) {
  el.textContent = "확인 중...";
  const result = await pingNativeHost();
  if (result.ok) {
    el.textContent = "네이티브 헬퍼 연결됨";
    el.className = "native-status ok";
  } else {
    el.textContent = `네이티브 헬퍼 연결 안 됨: ${result.error}`;
    el.className = "native-status error";
  }
}

document.getElementById("addDomainBtn").addEventListener("click", () => {
  state.domains.push({
    uuid: uuid(),
    domain: "",
    ruleId: state.nextRuleId,
    method: "redirect",
    servers: [{ name: "WEB1", ip: "" }, { name: "WEB2", ip: "" }]
  });
  state.nextRuleId += 1;
  render();
});

document.getElementById("save").addEventListener("click", async () => {
  // 빈 도메인 이름이나 빈 IP를 가진 서버는 정리
  const cleaned = {
    nextRuleId: state.nextRuleId,
    domains: state.domains
      .filter(d => d.domain)
      .map(d => ({
        ...d,
        servers: d.servers.filter(s => s.ip)
      }))
  };

  await saveConfig(cleaned);
  state = cleaned;

  // 삭제된 도메인의 선택 정보는 정리, 나머지는 유지
  const selections = await loadSelections();
  const validUuids = new Set(cleaned.domains.map(d => d.uuid));
  for (const key of Object.keys(selections)) {
    if (!validUuids.has(key)) delete selections[key];
  }
  await saveSelections(selections);
  const hostsResult = await applyAll(cleaned, selections);

  render();

  const saved = document.getElementById("saved");
  if (hostsResult.ok === false) {
    saved.textContent = `저장됨 (hosts 파일 적용 실패: ${hostsResult.error})`;
    saved.className = "error";
  } else {
    saved.textContent = "저장됨 ✓";
    saved.className = "";
  }
  saved.style.opacity = "1";
  setTimeout(() => (saved.style.opacity = "0"), hostsResult.ok === false ? 4000 : 1500);
});

init();
