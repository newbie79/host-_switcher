async function render() {
  const config = await loadConfig();
  const selections = await loadSelections();

  const list = document.getElementById("list");
  const empty = document.getElementById("empty");
  list.innerHTML = "";

  if (config.domains.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  config.domains.forEach(domain => {
    const currentSel = selections[domain.uuid] ?? "off";

    const block = document.createElement("div");
    block.className = "domain-block";

    const title = document.createElement("div");
    title.className = "domain-name";
    title.textContent = domain.domain;
    block.appendChild(title);

    domain.servers.forEach((server, idx) => {
      const row = document.createElement("label");
      row.className = "option";
      row.innerHTML = `
        <input type="radio" name="d-${domain.uuid}" value="${idx}"
          ${String(currentSel) === String(idx) ? "checked" : ""} />
        <span class="name">${escapeHtml(server.name)}</span>
        <span class="ip">${escapeHtml(server.ip)}</span>
      `;
      block.appendChild(row);
    });

    const offRow = document.createElement("label");
    offRow.className = "option";
    offRow.innerHTML = `
      <input type="radio" name="d-${domain.uuid}" value="off"
        ${currentSel === "off" ? "checked" : ""} />
      <span class="name">IP 미선택</span>
    `;
    block.appendChild(offRow);

    const status = document.createElement("div");
    updateStatusEl(status, domain, currentSel);
    block.appendChild(status);

    block.querySelectorAll(`input[name="d-${domain.uuid}"]`).forEach(input => {
      input.addEventListener("change", async (e) => {
        const value = e.target.value === "off" ? "off" : Number(e.target.value);
        const newSelections = await setSelection(domain.uuid, value);
        const hostsResult = await applyAll(config, newSelections);
        updateStatusEl(status, domain, value, hostsResult);

        // hosts 방식에서 다른 서버로 전환 성공 시, Chrome 자체 DNS 캐시가 남아있으면
        // 새 탭에서도 예전 IP로 붙을 수 있어서 캐시 비우는 화면을 바로 띄워준다.
        if (domainMethod(domain) === "hosts" && value !== "off" && hostsResult.ok !== false) {
          chrome.tabs.create({ url: "chrome://net-internals/#dns" });
        }
      });
    });

    list.appendChild(block);
  });
}

function updateStatusEl(el, domain, sel, hostsResult) {
  const isHosts = domainMethod(domain) === "hosts";

  if (sel === "off") {
    el.className = "status off";
    el.textContent = "IP 미선택 (실제 DNS 사용)";
    return;
  }

  if (isHosts && hostsResult && hostsResult.ok === false) {
    el.className = "status off";
    el.textContent = `hosts 파일 적용 실패: ${hostsResult.error}`;
    return;
  }

  const server = domain.servers[sel];
  const via = isHosts ? "hosts 파일" : "리다이렉트";
  el.className = "status on";
  el.textContent = `${server.name} (${server.ip}) 로 라우팅 중 (${via})`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

document.getElementById("optionsLink").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

render();
