(function () {
  "use strict";

  const SUPABASE_CONFIG = Object.freeze({
    url: "https://kbsjriixpqddgvwshucn.supabase.co",
    anonKey: "sb_publishable_aB4iqbsLVcOL_j8-IwbqtQ_43cqrxfy"
  });
  const TOURNAMENT = "brasileirao";
  const FIRST_RANKING_ROUND = 19;
  const TIME_ZONE = "America/Sao_Paulo";
  const DEFAULT_PARTICIPANTS = Object.freeze([
    "Leo B.", "Leo C.", "Gabriel", "Gustavo", "Otávio", "Vitão", "Thyago", "Luiz R."
  ]);
  const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO", "FINISHED", "AWARDED"]);
  const LIVE_STATUSES = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
  const RANKING_MODES = Object.freeze([
    { id: "points", title: "Classificação", context: "por pontos", metric: "points", label: "pontos", pointValue: 1 },
    { id: "exact", title: "Cravadas", context: "por placares exatos", metric: "exact", label: "cravadas", pointValue: 3 },
    { id: "inverted", title: "Invertidas", context: "por placares ao contrário", metric: "inverted", label: "invertidas", pointValue: -2 },
    { id: "correct", title: "Acertos", context: "por vencedores ou empates corretos", metric: "correct", label: "acertos", pointValue: 1 },
    { id: "miss", title: "Erros", context: "por palpites zerados", metric: "miss", label: "erros", pointValue: 0 }
  ]);

  const TEAM_LOGOS = Object.freeze({
    "Atlético-MG": "assets/brasileirao/atletico-mg.png",
    "Athletico-PR": "assets/brasileirao/athletico-pr.png",
    "Bahia": "assets/brasileirao/bahia.png",
    "Botafogo": "assets/brasileirao/botafogo.png",
    "Bragantino": "assets/brasileirao/bragantino.png",
    "Chapecoense": "assets/brasileirao/chapecoense.png",
    "Corinthians": "assets/brasileirao/corinthians.png",
    "Coritiba": "assets/brasileirao/coritiba.png",
    "Cruzeiro": "assets/brasileirao/cruzeiro.png",
    "EC Vitória": "assets/brasileirao/ec-vitoria.png",
    "Flamengo": "assets/brasileirao/flamengo.png",
    "Fluminense": "assets/brasileirao/fluminense.png",
    "Grêmio": "assets/brasileirao/gremio.png",
    "Internacional": "assets/brasileirao/internacional.png",
    "Mirassol": "assets/brasileirao/mirassol.png",
    "Palmeiras": "assets/brasileirao/palmeiras.png",
    "Remo": "assets/brasileirao/remo.png",
    "Santos": "assets/brasileirao/santos.png",
    "São Paulo": "assets/brasileirao/sao-paulo.png",
    "Vasco da Gama": "assets/brasileirao/vasco-da-gama.png"
  });

  const TEAM_ALIASES = Object.freeze({
    atleticomg: "Atlético-MG", atleticomineiro: "Atlético-MG", camineiro: "Atlético-MG",
    caparanaense: "Athletico-PR", clubeathleticoparanaense: "Athletico-PR", clubathleticoparanaense: "Athletico-PR", athleticoparanaense: "Athletico-PR", athleticopr: "Athletico-PR",
    bahiaba: "Bahia", ecbahia: "Bahia", bahiasaf: "Bahia",
    botafogofr: "Botafogo", botafogo: "Botafogo",
    chapecoense: "Chapecoense", chapecoenseaf: "Chapecoense", afchapecoense: "Chapecoense", associacaochapecoensedefutebol: "Chapecoense",
    corinthians: "Corinthians", corinthianspaulista: "Corinthians", sccorinthians: "Corinthians", sportclubcorinthianspaulista: "Corinthians",
    coritibafbc: "Coritiba", coritiba: "Coritiba", coritibasaf: "Coritiba",
    cruzeiroec: "Cruzeiro", cruzeiro: "Cruzeiro",
    crflamengo: "Flamengo", flamengo: "Flamengo",
    fluminensefc: "Fluminense", fluminense: "Fluminense",
    gremiofbpa: "Grêmio", gremio: "Grêmio",
    internacional: "Internacional", scinternacional: "Internacional",
    mirassolfc: "Mirassol", mirassol: "Mirassol",
    palmeiras: "Palmeiras", sepalmeiras: "Palmeiras",
    redbullbragantino: "Bragantino", redbullbragantinosaf: "Bragantino", rbbragantino: "Bragantino", bragantino: "Bragantino",
    remopa: "Remo", clubedoremo: "Remo", remo: "Remo",
    santosfc: "Santos", santos: "Santos",
    saopaulofc: "São Paulo", saopaulo: "São Paulo",
    vasco: "Vasco da Gama", vascodagama: "Vasco da Gama", crvascodagama: "Vasco da Gama",
    vitoria: "EC Vitória", ecvitoria: "EC Vitória", ecvitoriasaf: "EC Vitória"
  });

  const state = {
    client: null,
    user: null,
    profile: null,
    data: null,
    scope: "all",
    rankingMode: "points",
    focusRound: null,
    loading: false,
    channel: null,
    pollTimer: null,
    toastTimer: null,
    activePlayerIndex: null,
    modalReturnFocus: null
  };

  const dom = {};
  const byId = id => document.getElementById(id);

  function cacheDom() {
    [
      "accessScreen", "accessLoader", "loginForm", "loginEmail", "loginPassword", "loginError", "loginButton",
      "deniedState", "accessErrorState", "accessErrorText", "switchAccountButton", "retryAccessButton",
      "appShell", "connectionState", "connectionLabel", "refreshButton", "adminMenuButton", "adminMenuPanel",
      "signOutButton", "clubRibbon", "metricPosition", "metricRound", "metricRoundDetail", "metricPoints",
      "metricExact", "rankingTitle", "rankingContext", "rankingMetricHead", "rankingList",
      "playerDialog", "playerDialogBackdrop", "playerDialogClose", "playerDialogPosition", "playerDialogAvatar",
      "playerDialogName", "playerDialogStats", "playerDialogEfficiency", "playerDialogEfficiencyBar",
      "playerDialogGames", "playerDialogRecent", "toast"
    ].forEach(id => { dom[id] = byId(id); });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "—";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function participantName(index, profiles = []) {
    if (DEFAULT_PARTICIPANTS[index]) return DEFAULT_PARTICIPANTS[index];
    const profile = profiles.find(row => Number(row.participant_index) === Number(index));
    return profile && profile.participant_name ? profile.participant_name : `Participante ${Number(index) + 1}`;
  }

  function humanError(error) {
    const message = String(error && (error.message || error.error_description) || error || "");
    if (/invalid login credentials/i.test(message)) return "E-mail ou senha incorretos.";
    if (/email not confirmed/i.test(message)) return "Confirme seu e-mail antes de entrar.";
    if (/failed to fetch|network/i.test(message)) return "Não foi possível falar com o servidor. Verifique sua conexão.";
    if (/brasileirao_predictions/i.test(message)) return "A tabela de palpites do Brasileirão não está disponível para esta conta.";
    return message || "Não foi possível concluir a operação.";
  }

  function setAccessView(view, errorText = "") {
    dom.accessLoader.hidden = view !== "loading";
    dom.loginForm.hidden = view !== "login";
    dom.deniedState.hidden = view !== "denied";
    dom.accessErrorState.hidden = view !== "error";
    if (view === "error" && errorText) dom.accessErrorText.textContent = errorText;
    dom.accessScreen.hidden = view === "authorized";
    dom.appShell.hidden = view !== "authorized";
    if (view === "login") requestAnimationFrame(() => dom.loginEmail.focus());
  }

  function setConnection(kind, label) {
    dom.connectionState.classList.toggle("loading", kind === "loading");
    dom.connectionState.classList.toggle("error", kind === "error");
    dom.connectionLabel.textContent = label;
  }

  async function ensureClient() {
    if (state.client) return state.client;
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("A biblioteca de conexão não carregou.");
    }
    state.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    state.client.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") window.setTimeout(resetToLogin, 0);
    });
    return state.client;
  }

  async function bootstrapAccess() {
    setAccessView("loading");
    try {
      const client = await ensureClient();
      const { data, error } = await client.auth.getUser();
      if (error || !data || !data.user) {
        state.user = null;
        state.profile = null;
        setAccessView("login");
        return;
      }
      state.user = data.user;
      const response = await client
        .from("profiles")
        .select("id,participant_index,participant_name,role")
        .eq("id", data.user.id)
        .maybeSingle();
      if (response.error) throw response.error;
      state.profile = response.data || null;
      if (!state.profile || state.profile.role !== "admin") {
        setAccessView("denied");
        return;
      }
      openDashboard();
    } catch (error) {
      setAccessView("error", humanError(error));
    }
  }

  function resetToLogin() {
    clearLiveUpdates();
    closePlayerDialog(false);
    state.user = null;
    state.profile = null;
    state.data = null;
    setAccessView("login");
  }

  async function handleLogin(event) {
    event.preventDefault();
    dom.loginError.hidden = true;
    dom.loginButton.disabled = true;
    dom.loginButton.textContent = "Confirmando…";
    try {
      const client = await ensureClient();
      const { error } = await client.auth.signInWithPassword({
        email: dom.loginEmail.value.trim(),
        password: dom.loginPassword.value
      });
      if (error) throw error;
      dom.loginPassword.value = "";
      await bootstrapAccess();
    } catch (error) {
      dom.loginError.textContent = humanError(error);
      dom.loginError.hidden = false;
    } finally {
      dom.loginButton.disabled = false;
      dom.loginButton.textContent = "Entrar como administrador";
    }
  }

  async function signOut() {
    closeAdminMenu();
    if (state.client) await state.client.auth.signOut();
    resetToLogin();
  }

  function openDashboard() {
    setAccessView("authorized");
    document.querySelectorAll('a[href="bolao2026.html"]').forEach(link => {
      link.addEventListener("click", () => {
        try { localStorage.setItem("bolaoActiveComp", "brasileirao"); } catch (_) {}
      });
    });
    renderClubRibbon();
    loadDashboard();
    setupLiveUpdates();
  }

  function renderClubRibbon() {
    const logos = Object.entries(TEAM_LOGOS).map(([team, src]) =>
      `<img src="${escapeHtml(src)}" alt="${escapeHtml(team)}" title="${escapeHtml(team)}">`
    ).join("");
    dom.clubRibbon.innerHTML = `<div class="club-ribbon-group">${logos}</div><div class="club-ribbon-group" aria-hidden="true">${logos}</div>`;
  }

  function canonicalTeam(name) {
    const raw = String(name || "").trim();
    const compact = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (TEAM_ALIASES[compact]) return TEAM_ALIASES[compact];
    const cleaned = raw
      .replace(/\b(SAF|SAD|FBC|FC|EC|SC|AC|CR|SE|SA|PA|SP|PR|MG|RJ|BA|RS|CE)\b\.?/gi, "")
      .replace(/\s*[-/]\s*(PA|SP|PR|MG|RJ|BA|RS|CE)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const key = cleaned.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return TEAM_ALIASES[key] || cleaned || raw;
  }

  function parseRound(label) {
    const match = String(label || "").match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function tagLateFixtures(fixtures) {
    const returnLeg = fixtures.filter(fixture => fixture.round != null && fixture.round >= FIRST_RANKING_ROUND && fixture.ts);
    const returnStart = returnLeg.length ? Math.min(...returnLeg.map(fixture => fixture.ts)) : null;
    const roundStart = {};
    returnLeg.forEach(fixture => {
      if (roundStart[fixture.round] == null || fixture.ts < roundStart[fixture.round]) roundStart[fixture.round] = fixture.ts;
    });
    const rounds = Object.keys(roundStart).map(Number).sort((a, b) => a - b);
    fixtures.forEach(fixture => {
      fixture.late = Boolean(returnStart != null && fixture.round != null && fixture.round < FIRST_RANKING_ROUND && fixture.ts >= returnStart);
      if (!fixture.late) {
        fixture.slot = fixture.round;
        return;
      }
      let slot = FIRST_RANKING_ROUND;
      rounds.forEach(round => { if (roundStart[round] <= fixture.ts) slot = round; });
      fixture.slot = slot;
    });
  }

  async function loadDashboard(options = {}) {
    if (!state.client || !state.profile || state.loading) return;
    state.loading = true;
    dom.refreshButton.classList.add("loading");
    setConnection("loading", "Sincronizando");
    try {
      const [profiles, mapRows, liveRows, predictions, results] = await Promise.all([
        state.client.from("profiles").select("id,participant_index,participant_name,role").order("participant_index", { ascending: true }),
        state.client.from("api_fixture_map").select("game_id,api_fixture_id,kickoff_utc,home_team,away_team,round_label").eq("tournament", TOURNAMENT).order("kickoff_utc", { ascending: true }),
        state.client.from("live_scores").select("game_id,status_short,elapsed,goals_home,goals_away,last_synced_at"),
        state.client.from("brasileirao_predictions").select("participant_index,game_id,s1,s2"),
        state.client.from("results").select("game_id,s1,s2")
      ]);
      const failed = [profiles, mapRows, liveRows, predictions, results].find(response => response.error);
      if (failed) throw failed.error;

      const refreshedProfile = (profiles.data || []).find(row => row.id === state.user.id) || null;
      if (!refreshedProfile || refreshedProfile.role !== "admin") {
        state.profile = refreshedProfile;
        state.data = null;
        clearLiveUpdates();
        setAccessView("denied");
        return;
      }
      state.profile = refreshedProfile;

      const liveById = new Map((liveRows.data || []).map(row => [String(row.game_id), row]));
      const resultById = new Map((results.data || []).map(row => [String(row.game_id), { s1: Number(row.s1), s2: Number(row.s2) }]));
      const predictionByKey = new Map((predictions.data || []).map(row => [
        `${Number(row.participant_index)}_${row.game_id}`,
        { s1: Number(row.s1), s2: Number(row.s2) }
      ]));
      const fixtures = (mapRows.data || []).map(row => ({
        id: String(row.game_id),
        kickoff: row.kickoff_utc,
        ts: row.kickoff_utc ? new Date(row.kickoff_utc).getTime() : 0,
        home: canonicalTeam(row.home_team),
        away: canonicalTeam(row.away_team),
        round: parseRound(row.round_label),
        live: liveById.get(String(row.game_id)) || null
      })).sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id));
      tagLateFixtures(fixtures);
      const rankingFixtures = fixtures.filter(fixture => fixture.round == null || fixture.round >= FIRST_RANKING_ROUND || fixture.late);
      const syncedDates = (liveRows.data || []).map(row => Date.parse(row.last_synced_at || "")).filter(Number.isFinite);

      state.data = {
        profiles: profiles.data || [],
        fixtures: rankingFixtures,
        predictions: predictionByKey,
        results: resultById,
        lastUpdated: syncedDates.length ? new Date(Math.max(...syncedDates)) : new Date()
      };
      state.focusRound = findFocusRound(rankingFixtures);
      renderRankingPage();
      setConnection("ok", `Atualizado ${formatTime(state.data.lastUpdated)}`);
      if (options.notify) showToast("Ranking atualizado.");
    } catch (error) {
      setConnection("error", "Falha ao atualizar");
      showToast(humanError(error));
      if (!state.data) renderUnavailable();
    } finally {
      state.loading = false;
      dom.refreshButton.classList.remove("loading");
    }
  }

  function fixtureResult(fixture) {
    if (!state.data) return null;
    const official = state.data.results.get(fixture.id);
    if (official && Number.isFinite(official.s1) && Number.isFinite(official.s2)) {
      return { s1: official.s1, s2: official.s2, final: true, live: false };
    }
    const live = fixture.live;
    if (!live || live.goals_home == null || live.goals_away == null) return null;
    const status = String(live.status_short || "").trim().toUpperCase();
    if (FINAL_STATUSES.has(status)) return { s1: Number(live.goals_home), s2: Number(live.goals_away), final: true, live: false };
    if (LIVE_STATUSES.has(status)) return { s1: Number(live.goals_home), s2: Number(live.goals_away), final: false, live: true };
    return null;
  }

  function predictionFor(participantIndex, fixtureId) {
    return state.data && state.data.predictions.get(`${participantIndex}_${fixtureId}`) || null;
  }

  function scoreDetails(prediction, result) {
    if (!prediction || !result || !Number.isFinite(prediction.s1) || !Number.isFinite(prediction.s2)) return null;
    if (prediction.s1 === result.s1 && prediction.s2 === result.s2) return { points: 3, kind: "exact" };
    if (prediction.s1 !== prediction.s2 && prediction.s1 === result.s2 && prediction.s2 === result.s1) return { points: -2, kind: "inverted" };
    const predictedWinner = prediction.s1 > prediction.s2 ? 1 : prediction.s1 < prediction.s2 ? 2 : 0;
    const realWinner = result.s1 > result.s2 ? 1 : result.s1 < result.s2 ? 2 : 0;
    if (predictedWinner === realWinner) return { points: 1, kind: "correct" };
    return { points: 0, kind: "miss" };
  }

  function participantIndexes() {
    const indexes = new Set(DEFAULT_PARTICIPANTS.map((_, index) => index));
    (state.data && state.data.profiles || []).forEach(profile => {
      const index = Number(profile.participant_index);
      if (Number.isInteger(index) && index >= 0) indexes.add(index);
    });
    return [...indexes].sort((a, b) => a - b);
  }

  function computeStats(participantIndex, fixtures) {
    const outcomes = [];
    let points = 0;
    let exact = 0;
    let correct = 0;
    let miss = 0;
    let inverted = 0;
    let played = 0;
    fixtures.slice().sort((a, b) => a.ts - b.ts).forEach(fixture => {
      const result = fixtureResult(fixture);
      const prediction = predictionFor(participantIndex, fixture.id);
      const detail = scoreDetails(prediction, result);
      if (!detail) return;
      played += 1;
      points += detail.points;
      if (detail.kind === "exact") exact += 1;
      if (detail.kind === "correct") correct += 1;
      if (detail.kind === "miss") miss += 1;
      if (detail.kind === "inverted") inverted += 1;
      outcomes.push({ ...detail, fixture, prediction, result });
    });
    return {
      points, exact, correct, miss, inverted, played,
      efficiency: played ? Math.max(0, Math.round((points / (played * 3)) * 100)) : 0,
      recent: outcomes.slice(-5).reverse()
    };
  }

  function activeRankingMode() {
    return RANKING_MODES.find(mode => mode.id === state.rankingMode) || RANKING_MODES[0];
  }

  function rankingFor(fixtures, mode = activeRankingMode()) {
    const metric = mode.metric;
    return participantIndexes().map(index => ({
      index,
      name: participantName(index, state.data.profiles),
      ...computeStats(index, fixtures)
    })).sort((a, b) => {
      if (metric !== "points" && b[metric] !== a[metric]) return b[metric] - a[metric];
      if (b.points !== a.points) return b.points - a.points;
      if (b.exact !== a.exact) return b.exact - a.exact;
      if (a.inverted !== b.inverted) return a.inverted - b.inverted;
      if (b.correct !== a.correct) return b.correct - a.correct;
      if (a.miss !== b.miss) return a.miss - b.miss;
      return a.name.localeCompare(b.name, "pt-BR");
    });
  }

  function rankingCategoryPoints(row, mode) {
    return mode.id === "points" ? row.points : row[mode.metric] * mode.pointValue;
  }

  function groupByRound(fixtures) {
    const groups = new Map();
    fixtures.forEach(fixture => {
      const round = fixture.slot != null ? fixture.slot : fixture.round;
      if (round == null) return;
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(fixture);
    });
    return groups;
  }

  function findFocusRound(fixtures) {
    const groups = groupByRound(fixtures);
    const rounds = [...groups.keys()].sort((a, b) => a - b);
    const liveRound = rounds.find(round => groups.get(round).some(fixture => fixtureResult(fixture)?.live));
    if (liveRound != null) return liveRound;
    const incompleteRound = rounds.find(round => groups.get(round).some(fixture => !fixtureResult(fixture)?.final));
    if (incompleteRound != null) return incompleteRound;
    const scoredRounds = rounds.filter(round => groups.get(round).some(fixtureResult));
    return scoredRounds.length ? scoredRounds[scoredRounds.length - 1] : (rounds[0] ?? null);
  }

  function scopeFixtures() {
    if (!state.data) return [];
    if (state.scope === "round") {
      return state.data.fixtures.filter(fixture => (fixture.slot != null ? fixture.slot : fixture.round) === state.focusRound);
    }
    if (state.scope === "live") return state.data.fixtures.filter(fixture => fixtureResult(fixture)?.live);
    return state.data.fixtures;
  }

  function previousPositions(mode = activeRankingMode()) {
    if (!state.data || state.focusRound == null || state.scope !== "all") return new Map();
    const previousFixtures = state.data.fixtures.filter(fixture => {
      const round = fixture.slot != null ? fixture.slot : fixture.round;
      return round != null && round < state.focusRound;
    });
    if (!previousFixtures.some(fixtureResult)) return new Map();
    return new Map(rankingFor(previousFixtures, mode).map((row, index) => [row.index, index + 1]));
  }

  function renderRankingPage() {
    const fixtures = scopeFixtures();
    const mode = activeRankingMode();
    const ranking = rankingFor(fixtures, mode);
    const previous = previousPositions(mode);
    renderSummary();
    const context = {
      all: "Classificação geral do returno",
      round: state.focusRound == null ? "Rodada atual" : `Pontuação da rodada ${state.focusRound}`,
      live: fixtures.length ? "Pontuação provisória dos jogos ao vivo" : "Nenhum jogo ao vivo agora"
    };
    dom.rankingTitle.textContent = mode.title;
    if (dom.rankingMetricHead) dom.rankingMetricHead.textContent = "Pontos";
    dom.rankingContext.textContent = `${context[state.scope]} · ${mode.context}`;

    if (state.scope === "live" && !fixtures.length) {
      dom.rankingList.innerHTML = '<li class="ranking-empty">Nenhum jogo está ao vivo agora.</li>';
      closePlayerDialog(false);
      return;
    }

    dom.rankingList.innerHTML = ranking.map((row, index) => {
      const oldPosition = previous.get(row.index);
      const movement = oldPosition == null ? 0 : oldPosition - (index + 1);
      const movementClass = movement > 0 ? "up" : movement < 0 ? "down" : "same";
      const movementText = movement > 0 ? `↑${movement}` : movement < 0 ? `↓${Math.abs(movement)}` : "—";
      const form = row.recent.length
        ? row.recent.map(item => `<span class="form-chip ${item.kind}" title="${escapeHtml(resultLabel(item.kind))}">${item.points > 0 ? "+" : ""}${item.points}</span>`).join("")
        : '<span class="form-chip">—</span>';
      const categoryCount = row[mode.metric];
      const categoryPoints = rankingCategoryPoints(row, mode);
      const categoryBadge = mode.id === "points" ? "" : `<span class="rank-focus-chip ${mode.id}">${categoryCount} ${escapeHtml(mode.label)}</span>`;
      return `
        <li>
          <button class="ranking-row" type="button" data-player-index="${row.index}" style="animation-delay:${Math.min(index * 35, 240)}ms" aria-label="Abrir perfil de ${escapeHtml(row.name)}">
            <div class="rank-position">${index + 1}<span class="rank-change ${movementClass}">${movementText}</span></div>
            <div class="rank-participant">
              <span class="participant-avatar">${escapeHtml(initials(row.name))}</span>
              <div class="rank-name"><strong>${escapeHtml(row.name)}</strong><span>Ver perfil</span></div>
            </div>
            <div class="recent-form" aria-label="Forma recente">${form}</div>
            <div class="rank-scorebox"><div class="rank-points ${mode.id}"><b>${categoryPoints}</b><span>pontos</span></div>${categoryBadge}</div>
          </button>
        </li>`;
    }).join("");

    if (!dom.playerDialog.hidden && state.activePlayerIndex != null) openPlayerDialog(state.activePlayerIndex, null, false);
  }

  function renderSummary() {
    const allRanking = rankingFor(state.data.fixtures, RANKING_MODES[0]);
    const participantIndex = Number(state.profile.participant_index);
    const position = allRanking.findIndex(row => row.index === participantIndex);
    const player = position >= 0 ? allRanking[position] : null;
    dom.metricPosition.textContent = position >= 0 ? `${position + 1}º` : "—";
    dom.metricRound.textContent = state.focusRound == null ? "—" : String(state.focusRound);
    dom.metricRoundDetail.textContent = state.focusRound == null ? "returno" : "rodada atual do bolão";
    dom.metricPoints.textContent = player ? String(player.points) : "—";
    dom.metricExact.textContent = player ? String(player.exact) : "—";
  }

  function openPlayerDialog(index, source = null, moveFocus = true) {
    if (!state.data) return;
    const ranking = rankingFor(scopeFixtures(), activeRankingMode());
    const rowIndex = ranking.findIndex(row => row.index === Number(index));
    if (rowIndex < 0) return;
    const row = ranking[rowIndex];
    state.activePlayerIndex = row.index;
    if (source) state.modalReturnFocus = source;

    dom.playerDialogPosition.textContent = `${rowIndex + 1}º`;
    dom.playerDialogAvatar.textContent = initials(row.name);
    dom.playerDialogName.textContent = row.name;
    dom.playerDialogStats.innerHTML = [
      [row.points, "Pontos"],
      [row.exact, "Cravadas"],
      [row.correct, "Certos"],
      [row.inverted, "Invertidos"],
      [row.played, "Jogos"]
    ].map(([value, label]) => `<div class="player-stat"><b>${value}</b><span>${label}</span></div>`).join("");
    dom.playerDialogEfficiency.textContent = `${row.efficiency}%`;
    dom.playerDialogEfficiencyBar.style.width = `${Math.min(100, row.efficiency)}%`;
    dom.playerDialogGames.textContent = `${row.played} ${row.played === 1 ? "jogo" : "jogos"}`;
    dom.playerDialogRecent.innerHTML = row.recent.length
      ? row.recent.map(playerGameHtml).join("")
      : '<div class="player-game-empty">Nenhum jogo pontuado neste recorte.</div>';
    dom.playerDialog.hidden = false;
    document.body.classList.add("dialog-open");
    if (moveFocus) requestAnimationFrame(() => dom.playerDialogClose.focus());
  }

  function playerGameHtml(item) {
    const homeLogo = TEAM_LOGOS[item.fixture.home];
    const awayLogo = TEAM_LOGOS[item.fixture.away];
    return `
      <div class="player-game">
        <div class="player-game-teams">
          ${homeLogo ? `<img src="${escapeHtml(homeLogo)}" alt="">` : ""}
          ${awayLogo ? `<img src="${escapeHtml(awayLogo)}" alt="">` : ""}
          <span>${escapeHtml(item.fixture.home)} ${item.result.s1}–${item.result.s2} ${escapeHtml(item.fixture.away)}</span>
        </div>
        <div class="player-game-score">
          <span class="form-chip ${item.kind}">${item.points > 0 ? "+" : ""}${item.points}</span>
          <b>${item.prediction.s1}–${item.prediction.s2}</b>
        </div>
      </div>`;
  }

  function closePlayerDialog(restoreFocus = true) {
    if (!dom.playerDialog || dom.playerDialog.hidden) return;
    dom.playerDialog.hidden = true;
    document.body.classList.remove("dialog-open");
    state.activePlayerIndex = null;
    if (restoreFocus && state.modalReturnFocus?.isConnected) state.modalReturnFocus.focus();
    state.modalReturnFocus = null;
  }

  function resultLabel(kind) {
    return { exact: "Cravada", correct: "Acerto", miss: "Erro", inverted: "Placar invertido" }[kind] || "Sem pontuação";
  }

  function renderUnavailable() {
    dom.rankingContext.textContent = "Ranking temporariamente indisponível";
    dom.rankingList.innerHTML = '<li class="ranking-empty">Não foi possível carregar a classificação agora. Tente atualizar.</li>';
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TIME_ZONE }).format(date);
  }

  function setScope(scope) {
    if (!state.data || !["all", "round", "live"].includes(scope)) return;
    state.scope = scope;
    document.querySelectorAll("[data-scope]").forEach(button => {
      const active = button.dataset.scope === scope;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    closePlayerDialog(false);
    renderRankingPage();
  }

  function setRankingMode(mode) {
    if (!state.data || !RANKING_MODES.some(item => item.id === mode)) return;
    state.rankingMode = mode;
    document.querySelectorAll("[data-ranking-mode]").forEach(button => {
      const active = button.dataset.rankingMode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    closePlayerDialog(false);
    renderRankingPage();
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 3200);
  }

  function toggleAdminMenu() {
    const open = dom.adminMenuPanel.hidden;
    dom.adminMenuPanel.hidden = !open;
    dom.adminMenuButton.setAttribute("aria-expanded", String(open));
  }

  function closeAdminMenu() {
    dom.adminMenuPanel.hidden = true;
    dom.adminMenuButton.setAttribute("aria-expanded", "false");
  }

  function setupLiveUpdates() {
    clearLiveUpdates();
    if (!state.client) return;
    let refreshTimer = null;
    const queueRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => loadDashboard(), 600);
    };
    state.channel = state.client
      .channel("admin-brasileirao-participant-ranking-compact")
      .on("postgres_changes", { event: "*", schema: "public", table: "live_scores" }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "results" }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "brasileirao_predictions" }, queueRefresh)
      .subscribe();
    state.pollTimer = window.setInterval(() => {
      if (!document.hidden) loadDashboard();
    }, 30000);
  }

  function clearLiveUpdates() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
    if (state.channel && state.client) state.client.removeChannel(state.channel);
    state.channel = null;
  }

  function bindEvents() {
    dom.loginForm.addEventListener("submit", handleLogin);
    dom.retryAccessButton.addEventListener("click", bootstrapAccess);
    dom.switchAccountButton.addEventListener("click", signOut);
    dom.signOutButton.addEventListener("click", signOut);
    dom.refreshButton.addEventListener("click", () => loadDashboard({ notify: true }));
    dom.adminMenuButton.addEventListener("click", toggleAdminMenu);
    dom.rankingList.addEventListener("click", event => {
      const button = event.target.closest("[data-player-index]");
      if (button) openPlayerDialog(Number(button.dataset.playerIndex), button);
    });
    dom.playerDialogClose.addEventListener("click", () => closePlayerDialog());
    dom.playerDialogBackdrop.addEventListener("click", () => closePlayerDialog());
    document.querySelectorAll("[data-scope]").forEach(button => button.addEventListener("click", () => setScope(button.dataset.scope)));
    document.querySelectorAll("[data-ranking-mode]").forEach(button => button.addEventListener("click", () => setRankingMode(button.dataset.rankingMode)));
    document.addEventListener("click", event => {
      if (!event.target.closest(".admin-menu")) closeAdminMenu();
    });
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (!dom.playerDialog.hidden) closePlayerDialog(); else closeAdminMenu();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.profile && state.data) loadDashboard();
    });
    window.addEventListener("beforeunload", clearLiveUpdates);
  }

  function init() {
    cacheDom();
    bindEvents();
    bootstrapAccess();
  }

  init();
})();
