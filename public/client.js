const app = document.querySelector("#app");

const session = {
  code: localStorage.getItem("mm_code") || "",
  playerId: localStorage.getItem("mm_playerId") || "",
};

let gameCatalog = [];
let selectedGameId = localStorage.getItem("mm_gameId") || "greenhouse";
let state = null;
let events = null;
let tick = null;
let localRemainingMs = null;
let lastStateAt = null;

function html(strings, ...values) {
  return strings
    .map((string, index) => `${string}${values[index] ?? ""}`)
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(ms) {
  if (ms === null || ms === undefined) return "--:--";
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function phasePercent() {
  if (!state?.currentPhase || state.remainingMs === null) return 0;
  const total = state.currentPhase.minutes * 60 * 1000;
  const elapsed = Math.min(total, Math.max(0, total - (localRemainingMs ?? state.remainingMs)));
  return Math.round((elapsed / total) * 100);
}

async function loadGames() {
  try {
    const response = await fetch("/api/games");
    const payload = await response.json();
    gameCatalog = payload.games || [];
    if (!gameCatalog.some((game) => game.id === selectedGameId)) {
      selectedGameId = gameCatalog[0]?.id || "greenhouse";
      localStorage.setItem("mm_gameId", selectedGameId);
    }
  } catch {
    gameCatalog = [];
  }
}

function selectedGame() {
  return (
    gameCatalog.find((game) => game.id === selectedGameId) ||
    gameCatalog[0] || {
      id: "greenhouse",
      title: "검은 유리 온실의 밤",
      tagline: "60분 온라인 머더미스터리",
      description: "4-8명이 각자 다른 비밀을 가진 용의자가 되어 범인을 찾아낸다.",
      coverImage: "/assets/greenhouse.svg",
      minPlayers: 4,
      maxPlayers: 8,
      totalRuntimeMinutes: 60,
      difficulty: "보통",
    }
  );
}

async function api(path, body = null, method = "POST") {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청 실패");
  if (payload.playerId) {
    session.playerId = payload.playerId;
    localStorage.setItem("mm_playerId", payload.playerId);
  }
  if (payload.state) {
    setState(payload.state);
  }
  return payload;
}

function setSession(code, playerId) {
  session.code = code;
  session.playerId = playerId;
  localStorage.setItem("mm_code", code);
  localStorage.setItem("mm_playerId", playerId);
}

function clearSession() {
  localStorage.removeItem("mm_code");
  localStorage.removeItem("mm_playerId");
  session.code = "";
  session.playerId = "";
  state = null;
  if (events) events.close();
  events = null;
  render();
}

function setState(nextState) {
  state = nextState;
  session.code = nextState.code;
  selectedGameId = nextState.gameId || nextState.game?.id || selectedGameId;
  localStorage.setItem("mm_code", nextState.code);
  localStorage.setItem("mm_gameId", selectedGameId);
  localRemainingMs = nextState.remainingMs;
  lastStateAt = Date.now();
  render();
  startTicker();
}

function startTicker() {
  clearInterval(tick);
  tick = setInterval(() => {
    if (!state || state.paused || state.remainingMs === null) return;
    localRemainingMs = Math.max(0, state.remainingMs - (Date.now() - lastStateAt));
    const timer = document.querySelector("[data-timer]");
    const bar = document.querySelector("[data-progress]");
    if (timer) timer.textContent = formatTime(localRemainingMs);
    if (bar) bar.style.width = `${phasePercent()}%`;
  }, 500);
}

function connectEvents() {
  if (!session.code || !session.playerId) return;
  if (events) events.close();
  events = new EventSource(`/events/${session.code}?playerId=${session.playerId}`);
  events.addEventListener("state", (event) => {
    setState(JSON.parse(event.data));
  });
  events.onerror = () => {
    events.close();
    events = null;
    setTimeout(connectEvents, 1500);
  };
}

async function restore() {
  await loadGames();
  if (!session.code || !session.playerId) {
    render();
    return;
  }
  try {
    const payload = await api(
      `/api/rooms/${session.code}/state?playerId=${session.playerId}`,
      null,
      "GET",
    );
    setState(payload.state);
    connectEvents();
  } catch {
    clearSession();
  }
}

function render() {
  if (!state) {
    renderGate();
    return;
  }
  if (state.status === "lobby") {
    renderLobby();
    return;
  }
  renderGame();
}

function renderGate(error = "") {
  const game = selectedGame();
  app.innerHTML = html`
    <section class="gate">
      <div class="gate-art">
        <img src="${escapeHtml(game.coverImage)}" alt="${escapeHtml(game.title)} 대표 이미지" />
      </div>
      <div class="gate-copy">
        <p class="eyebrow">${escapeHtml(game.tagline)}</p>
        <h1>${escapeHtml(game.title)}</h1>
        <p class="lead">
          ${escapeHtml(game.description)}
        </p>
        <div class="case-stats" aria-label="게임 정보">
          <span><strong>${game.totalRuntimeMinutes}</strong>분</span>
          <span><strong>${game.minPlayers}-${game.maxPlayers}</strong>명</span>
          <span><strong>${escapeHtml(game.difficulty)}</strong></span>
        </div>
        ${renderGamePicker()}
        <div class="gate-actions">
          <form data-create-room class="panel form-panel">
            <h2>방 만들기</h2>
            <label>
              이름
              <input name="name" autocomplete="name" maxlength="18" placeholder="예: 서연" required />
            </label>
            <button type="submit">새 사건 열기</button>
          </form>
          <form data-join-room class="panel form-panel">
            <h2>방 참가</h2>
            <label>
              방 코드
              <input name="code" maxlength="5" placeholder="ABCDE" required />
            </label>
            <label>
              이름
              <input name="name" autocomplete="name" maxlength="18" placeholder="예: 민준" required />
            </label>
            <button type="submit">입장하기</button>
          </form>
        </div>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      </div>
    </section>
  `;
}

function renderLobby() {
  const canStart = state.isHost && state.players.length >= state.minPlayers;
  app.innerHTML = html`
    <section class="lobby">
      <header class="topbar">
        <div>
          <p class="eyebrow">사건 대기실</p>
          <h1>${escapeHtml(state.scenario.title)}</h1>
        </div>
        <button class="ghost" data-leave>나가기</button>
      </header>
      <div class="lobby-grid">
        <section class="case-panel panel">
          <img src="${escapeHtml(state.game?.coverImage || "/assets/greenhouse.svg")}" alt="${escapeHtml(state.scenario.title)} 대표 이미지" />
          <div>
            <p class="code-label">방 코드</p>
            <p class="room-code">${state.code}</p>
            <p>${escapeHtml(state.scenario.premise)}</p>
            <p class="muted">총 러닝타임 ${state.totalRuntimeMinutes}분 · ${state.minPlayers}-${state.maxPlayers}명</p>
            <p class="case-note">방 코드를 참가자에게 공유하면 같은 사건 기록에 접속합니다.</p>
          </div>
        </section>
        <section class="panel">
          <div class="section-head">
            <h2>참가자</h2>
            <span>${state.players.length}/${state.maxPlayers}</span>
          </div>
          <div class="player-list">
            ${state.players
              .map(
                (player) => html`
                  <article class="player-row">
                    <span class="status-dot ${player.connected ? "on" : ""}"></span>
                    <strong>${escapeHtml(player.name)}</strong>
                    ${player.isHost ? `<span class="tag">HOST</span>` : ""}
                  </article>
                `,
              )
              .join("")}
          </div>
          <div class="host-actions">
            ${
              state.isHost
                ? `<button data-start ${canStart ? "" : "disabled"}>게임 시작</button>`
                : `<p class="muted">호스트가 게임을 시작할 때까지 기다린다.</p>`
            }
            ${
              state.isHost && !canStart
                ? `<p class="error">최소 ${state.minPlayers}명이 필요합니다.</p>`
                : ""
            }
          </div>
        </section>
        <section class="panel phase-preview">
          <h2>60분 진행표</h2>
          ${state.phases
            .map(
              (phase, index) => html`
                <div class="phase-line">
                  <span>${String(index + 1).padStart(2, "0")}</span>
                  <strong>${escapeHtml(phase.label)}</strong>
                  <em>${phase.minutes}분</em>
                </div>
              `,
            )
            .join("")}
        </section>
        <section class="panel phase-preview">
          <h2>플레이 원칙</h2>
          ${renderTextList(state.scenario.rules || [])}
        </section>
      </div>
    </section>
  `;
}

function renderGamePicker() {
  if (!gameCatalog.length) return "";
  return html`
    <section class="game-picker" aria-label="게임 선택">
      <div class="section-head">
        <h2>게임 선택</h2>
        <span>${gameCatalog.length}</span>
      </div>
      <div class="game-options">
        ${gameCatalog
          .map(
            (game) => html`
              <button type="button" class="game-option ${game.id === selectedGameId ? "selected" : ""}" data-game-option="${escapeHtml(game.id)}">
                <img src="${escapeHtml(game.coverImage)}" alt="" />
                <span>
                  <em>${escapeHtml(game.tagline)}</em>
                  <strong>${escapeHtml(game.title)}</strong>
                  <small>${game.totalRuntimeMinutes}분 · ${game.minPlayers}-${game.maxPlayers}명 · ${escapeHtml(game.difficulty)}</small>
                  <b>${escapeHtml(game.description)}</b>
                </span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderTextList(items, className = "note-list") {
  if (!Array.isArray(items) || items.length === 0) return "";
  return html`
    <ul class="${className}">
      ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function renderRoleExtras(role) {
  if (!role) return "";
  return html`
    ${role.timelineClaim ? `<dt>공개 동선</dt><dd>${escapeHtml(role.timelineClaim)}</dd>` : ""}
    ${Array.isArray(role.relationships) && role.relationships.length
      ? `<dt>관계</dt><dd>${renderTextList(role.relationships, "compact-list")}</dd>`
      : ""}
    ${Array.isArray(role.secretTasks) && role.secretTasks.length
      ? `<dt>개인 미션</dt><dd>${renderTextList(role.secretTasks, "compact-list")}</dd>`
      : ""}
    ${Array.isArray(role.pressureQuestions) && role.pressureQuestions.length
      ? `<dt>압박 질문</dt><dd>${renderTextList(role.pressureQuestions, "compact-list")}</dd>`
      : ""}
  `;
}

function renderPhasePrompts(phase) {
  if (!Array.isArray(phase.prompts) || phase.prompts.length === 0) return "";
  return html`
    <div class="phase-prompts">
      <strong>이번 단계 질문</strong>
      ${renderTextList(phase.prompts)}
    </div>
  `;
}

function renderTimelinePanel() {
  const timeline = state?.scenario?.timeline || [];
  if (!timeline.length) return "";
  return html`
    <article class="panel timeline-panel">
      <div class="section-head">
        <h2>공개 타임라인</h2>
        <span>${timeline.length}</span>
      </div>
      <div class="timeline-list">
        ${timeline
          .map(
            (item) => html`
              <p>
                <strong>${escapeHtml(item.time)}</strong>
                <span>${escapeHtml(item.event)}</span>
              </p>
            `,
          )
          .join("")}
      </div>
    </article>
  `;
}

function renderGame() {
  const phase = state.currentPhase;
  const role = state.myRole;
  const reveal = state.reveal;
  app.innerHTML = html`
    <section class="game">
      <header class="topbar gamebar">
        <div>
          <p class="eyebrow">${state.scenario.place}</p>
          <h1>${escapeHtml(state.scenario.title)}</h1>
        </div>
        <div class="timer-block">
          <span>${escapeHtml(phase.label)}</span>
          <strong data-timer>${formatTime(localRemainingMs ?? state.remainingMs)}</strong>
          <div class="progress-track"><div data-progress style="width:${phasePercent()}%"></div></div>
        </div>
      </header>

      <div class="game-grid">
        <aside class="panel dossier">
          <p class="eyebrow">내 역할</p>
          ${
            role
              ? html`
                  <h2>${escapeHtml(role.name)}</h2>
                  <p class="role-type">${escapeHtml(role.archetype)}</p>
                  <dl>
                    <dt>공개 정보</dt>
                    <dd>${escapeHtml(role.publicInfo)}</dd>
                    <dt>비밀</dt>
                    <dd>${escapeHtml(role.privateInfo)}</dd>
                    <dt>목표</dt>
                    <dd>${escapeHtml(role.objective)}</dd>
                    <dt>개인 단서</dt>
                    <dd>${escapeHtml(role.personalClue)}</dd>
                    <dt>초기 주장</dt>
                    <dd>${escapeHtml(role.startLie)}</dd>
                    ${renderRoleExtras(role)}
                  </dl>
                `
              : `<p class="muted">역할 배정 전입니다.</p>`
          }
        </aside>

        <section class="case-board">
          <article class="panel phase-card">
            <div class="section-head">
              <div>
                <p class="eyebrow">현재 단계</p>
                <h2>${escapeHtml(phase.label)}</h2>
              </div>
              <span>${phase.minutes}분</span>
            </div>
            <p>${escapeHtml(phase.instruction)}</p>
            ${renderPhasePrompts(phase)}
            <p class="case-premise">${escapeHtml(state.scenario.premise)}</p>
          </article>

          ${renderTimelinePanel()}

          <article class="panel clues">
            <div class="section-head">
              <h2>공개 단서</h2>
              <span>${state.clues.length}</span>
            </div>
            <div class="clue-grid">
              ${state.clues
                .map(
                  (clue) => html`
                    <article class="clue">
                      <h3>${escapeHtml(clue.title)}</h3>
                      <p>${escapeHtml(clue.body)}</p>
                    </article>
                  `,
                )
                .join("")}
            </div>
          </article>

          <article class="panel chat-panel">
            <div class="section-head">
              <h2>공용 기록</h2>
              <span>${state.messages.length}</span>
            </div>
            <div class="messages" data-messages>
              ${state.messages
                .map(
                  (message) => html`
                    <p class="message ${message.type}">
                      <strong>${escapeHtml(message.author)}</strong>
                      <span>${escapeHtml(message.text)}</span>
                    </p>
                  `,
                )
                .join("")}
            </div>
            <form data-chat class="chat-form">
              <input name="text" maxlength="400" placeholder="질문, 주장, 폭로를 남긴다" autocomplete="off" />
              <button type="submit">전송</button>
            </form>
          </article>
        </section>

        <aside class="side-stack">
          <section class="panel suspects">
            <div class="section-head">
              <h2>${state.solutionChoices?.length ? "플레이어" : "용의자"}</h2>
              <span>${state.players.length}</span>
            </div>
            ${state.players
              .map(
                (player) => html`
                  <article class="suspect ${player.id === state.viewerId ? "self" : ""} ${player.isKiller ? "killer" : ""}">
                    <div>
                      <strong>${escapeHtml(player.roleName || player.name)}</strong>
                      <span>${escapeHtml(player.archetype || "")}</span>
                    </div>
                    ${player.isHost ? `<em>HOST</em>` : ""}
                    ${reveal && player.isKiller ? `<b>범인</b>` : ""}
                    <p>${escapeHtml(player.publicInfo || "공개 정보 대기 중")}</p>
                  </article>
                `,
              )
              .join("")}
          </section>

          ${
            state.solutionChoices?.length
              ? html`
                  <section class="panel suspects">
                    <div class="section-head">
                      <h2>정답 후보</h2>
                      <span>${state.solutionChoices.length}</span>
                    </div>
                    ${state.solutionChoices
                      .map(
                        (choice) => html`
                          <article class="suspect">
                            <div>
                              <strong>${escapeHtml(choice.name)}</strong>
                              <span>${escapeHtml(choice.archetype || "")}</span>
                            </div>
                          </article>
                        `,
                      )
                      .join("")}
                  </section>
                `
              : ""
          }

          <section class="panel vote-panel">
            <div class="section-head">
              <h2>투표</h2>
              <span>${state.votes.filter((vote) => vote.voted).length}/${state.players.length}</span>
            </div>
            ${renderVoteForm()}
            <div class="vote-list">
              ${state.votes
                .map((vote) => {
                  if (!vote.voted) return `<p class="muted">미투표</p>`;
                  if (!vote.visible) return `<p class="muted">투표 완료</p>`;
                  return `<p><strong>${escapeHtml(vote.voterName)}</strong> → ${escapeHtml(vote.targetName || "")}<span>${escapeHtml(vote.reason || "")}</span></p>`;
                })
                .join("")}
            </div>
          </section>

          ${
            reveal
              ? html`
                  <section class="panel truth">
                    <p class="eyebrow">진상</p>
                    <h2>사건의 전말</h2>
                    <p>${escapeHtml(state.scenario.truth)}</p>
                  </section>
                `
              : ""
          }

          ${
            state.isHost
              ? html`
                  <section class="panel host-control">
                    <h2>호스트 컨트롤</h2>
                    <button data-pause>${state.paused ? "타이머 재개" : "타이머 정지"}</button>
                    <button class="secondary" data-advance>다음 단계</button>
                    <button class="ghost" data-leave>나가기</button>
                  </section>
                `
              : html`
                  <section class="panel host-control">
                    <button class="ghost" data-leave>나가기</button>
                  </section>
                `
          }
        </aside>
      </div>
    </section>
  `;

  const messages = document.querySelector("[data-messages]");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function renderVoteForm() {
  const canVote = state.currentPhase.key === "final" || state.currentPhase.key === "reveal";
  if (!canVote) return `<p class="muted">최종 진술/투표 단계에서 열린다.</p>`;
  const targets = state.solutionChoices?.length
    ? state.solutionChoices
    : state.players.map((player) => ({
        id: player.id,
        name: player.roleName || player.name,
        archetype: player.archetype,
      }));
  return html`
    <form data-vote class="vote-form">
      <select name="targetId" required>
        <option value="">${state.solutionChoices?.length ? "정답 선택" : "범인 지목"}</option>
        ${targets
          .map(
            (target) => html`
              <option value="${escapeHtml(target.id)}">${escapeHtml(target.name)}${target.archetype ? ` · ${escapeHtml(target.archetype)}` : ""}</option>
            `,
          )
          .join("")}
      </select>
      <input name="reason" maxlength="160" placeholder="사유" />
      <button type="submit">투표</button>
    </form>
  `;
}

function showError(message) {
  if (!state) {
    renderGate(message);
    return;
  }
  const error = document.createElement("p");
  error.className = "toast";
  error.textContent = message;
  document.body.append(error);
  setTimeout(() => error.remove(), 2800);
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  try {
    if (form.matches("[data-create-room]")) {
      const payload = await api("/api/rooms", { name: data.name, gameId: selectedGameId });
      setSession(payload.state.code, payload.playerId);
      connectEvents();
      return;
    }
    if (form.matches("[data-join-room]")) {
      const code = String(data.code || "").trim().toUpperCase();
      const payload = await api(`/api/rooms/${code}/join`, { name: data.name });
      setSession(payload.state.code, payload.playerId);
      connectEvents();
      return;
    }
    if (form.matches("[data-chat]")) {
      await api(`/api/rooms/${state.code}/message`, {
        playerId: session.playerId,
        text: data.text,
      });
      form.reset();
      return;
    }
    if (form.matches("[data-vote]")) {
      await api(`/api/rooms/${state.code}/vote`, {
        playerId: session.playerId,
        targetId: data.targetId,
        reason: data.reason,
      });
      return;
    }
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  try {
    const gameOption = target.closest("[data-game-option]");
    if (gameOption instanceof HTMLElement) {
      selectedGameId = gameOption.dataset.gameOption || selectedGameId;
      localStorage.setItem("mm_gameId", selectedGameId);
      render();
      return;
    }
    if (target.matches("[data-start]")) {
      await api(`/api/rooms/${state.code}/start`, { playerId: session.playerId });
      return;
    }
    if (target.matches("[data-advance]")) {
      await api(`/api/rooms/${state.code}/advance`, { playerId: session.playerId });
      return;
    }
    if (target.matches("[data-pause]")) {
      await api(`/api/rooms/${state.code}/pause`, { playerId: session.playerId });
      return;
    }
    if (target.matches("[data-leave]")) {
      clearSession();
    }
  } catch (error) {
    showError(error.message);
  }
});

restore();
