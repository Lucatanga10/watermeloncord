/* =====================================================
   WATERMELONCORD — Discord clone
   Backend: Firebase (Auth + Realtime Database + Storage)
   Vedi firebase-sync.js per la config e i wrapper WMF.*
===================================================== */

// ---------- UTIL ----------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => {
  const d = new Date(ts), today = new Date();
  const pad = n => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `Oggi alle ${hm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hm}`;
};
const defaultAvatar = (name) => {
  const colors = ["#5865f2", "#eb459e", "#f0b232", "#23a55a", "#f23f42", "#ed4245"];
  const c = colors[(name || "").charCodeAt(0) % colors.length] || "#5865f2";
  const letter = (name || "?").charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${c}"/><text x="48" y="60" font-family="Arial" font-size="44" fill="#fff" text-anchor="middle" font-weight="700">${letter}</text></svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
};
const fileToDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

// Ridimensiona un'immagine a maxDim px mantenendo l'aspect ratio.
// Restituisce un data URL compresso (JPEG per foto, PNG per trasparenze/GIF statiche).
// Le GIF animate perdono l'animazione una volta ridimensionate, quindi se sono piccole (<512KB) le lascio così.
async function resizeImage(file, maxDim = 256, quality = 0.85) {
  // Se è una GIF piccola, lascia l'originale (preserva animazione)
  if (file.type === "image/gif" && file.size < 512 * 1024) {
    return await fileToDataURL(file);
  }
  const dataUrl = await fileToDataURL(file);
  return await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
      res(canvas.toDataURL(mime, quality));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

// ---------- ATTACHMENTS ----------
// Gli allegati (foto, video, audio) vengono caricati su Firebase Storage
// e nello stato salviamo solo l'URL pubblico (att.url).

// ---------- SUONO NOTIFICA ----------
// "Dun din" — due note (bassa poi alta) come Discord
function playNotifSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    // "Dun" — nota bassa
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.connect(g1); g1.connect(ctx.destination);
    o1.type = "sine"; o1.frequency.value = 587; // ~D5
    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o1.start(t0); o1.stop(t0 + 0.2);
    // "Din" — nota alta
    const o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o2.connect(g2); g2.connect(ctx.destination);
    o2.type = "sine"; o2.frequency.value = 988; // ~B5
    g2.gain.setValueAtTime(0.0001, t0 + 0.16);
    g2.gain.exponentialRampToValueAtTime(0.25, t0 + 0.18);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    o2.start(t0 + 0.16); o2.stop(t0 + 0.6);
  } catch (e) {}
}

// ---------- STATO (sincronizzato con Firebase RTDB) ----------
let friendsTab = "all";

// currentUserId è per-tab (sessionStorage): ogni tab può loggare un account diverso.
const SESSION_KEY = "wmc_current_user";
function loadCurrentUserId() { return sessionStorage.getItem(SESSION_KEY); }
function saveCurrentUserId(id) {
  if (id) sessionStorage.setItem(SESSION_KEY, id);
  else sessionStorage.removeItem(SESSION_KEY);
}

function freshState() {
  return {
    currentUserId: null,
    users: {},
    groups: {},
    dms: {},
    friendRequests: [],
    friends: [],
    polls: [],
    currentView: { type: "home", subview: "friends" }
  };
}

let state = freshState();
state.currentUserId = loadCurrentUserId();

// Flag che indicano se Firebase ha finito di caricare lo stato iniziale e se
// l'auth state è noto. showApp/showLogin viene deciso quando entrambi sono pronti.
let firebaseStateReady = false;
let firebaseAuthKnown = false;
let firebaseAuthUser = null;

// Debounce delle scritture su RTDB: evita di scrivere ad ogni piccola modifica.
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 150;

function save() {
  // Persist currentUserId nella sessione (per-tab)
  saveCurrentUserId(state.currentUserId);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!window.WMF) return;
  // currentUserId è per-tab (sessionStorage), currentView è per-tab (locale):
  // NON li scriviamo su Firebase per non "trascinare" la navigazione di un
  // utente sugli altri.
  const { currentUserId, currentView, ...shared } = state;
  try {
    await WMF.writeState(shared);
  } catch (e) {
    console.error("Firebase writeState error:", e);
  }
}

// Versione "immediata" di save(): attende la scrittura. Usata in login/register
// per assicurarsi che il profilo sia davvero in RTDB prima di proseguire.
async function saveNow() {
  return flushSave();
}

// Stub no-op: il vecchio codice chiamava questa prima di alcune operazioni
// per allineare lo stato con localStorage. Con Firebase il listener mantiene
// lo stato allineato in tempo reale, quindi non serve più. Lasciato come
// alias per evitare di toccare tutti i call-site.
function reloadStateFromStorage() { /* no-op, gestito da WMF.subscribeState */ }

function hasNewIncomingFor(oldS, newS, myId) {
  if (!myId) return false;
  // Nuova richiesta di amicizia in arrivo
  const oldFR = (oldS.friendRequests || []).filter(r => r.toId === myId && r.status === "pending").length;
  const newFR = (newS.friendRequests || []).filter(r => r.toId === myId && r.status === "pending").length;
  if (newFR > oldFR) return true;
  // Nuovo messaggio in una mia DM
  for (const did in (newS.dms || {})) {
    const nd = newS.dms[did]; const od = oldS.dms?.[did];
    if (!nd.participants || !nd.participants.includes(myId)) continue;
    const oldLen = od?.messages?.length || 0;
    const newLen = nd.messages?.length || 0;
    if (newLen > oldLen) {
      const last = nd.messages[newLen - 1];
      if (last && last.authorId !== myId) return true;
    }
  }
  // Nuovo messaggio in un gruppo di cui faccio parte
  for (const gid in (newS.groups || {})) {
    const g = newS.groups[gid];
    if (!g.members || !g.members.includes(myId)) continue;
    const og = oldS.groups?.[gid];
    for (const ch of g.channels || []) {
      const newLen = g.messages?.[ch.id]?.length || 0;
      const oldLen = og?.messages?.[ch.id]?.length || 0;
      if (newLen > oldLen) {
        const last = g.messages[ch.id][newLen - 1];
        if (last && last.authorId !== myId && !last.system) return true;
      }
    }
  }
  return false;
}

function getCurrentUser() { return state.users[state.currentUserId]; }

// ---------- FIREBASE REALTIME LISTENER ----------
// Appena la pagina carica, sottoscriviamo lo stato condiviso: ogni cambiamento
// su RTDB (da qualsiasi dispositivo) aggiorna il nostro state locale e
// triggera un re-render.
WMF.subscribeState((newShared) => {
  const prev = state;
  // Mantieni currentUserId e currentView, che sono per-tab (locali)
  const keepCurrent = state.currentUserId;
  const keepView = state.currentView;
  if (newShared) {
    state = Object.assign(freshState(), newShared);
  } else {
    state = freshState();
  }
  state.currentUserId = keepCurrent;
  if (keepView) state.currentView = keepView;
  firebaseStateReady = true;
  // Notifica sonora se mi è arrivato qualcosa di nuovo
  if (keepCurrent && hasNewIncomingFor(prev, state, keepCurrent)) playNotifSound();
  tryShowApp();
});

WMF.onAuthChange((user) => {
  firebaseAuthKnown = true;
  firebaseAuthUser = user;
  tryShowApp();
});

// Quando entrambi (stato + auth) sono pronti, decidiamo cosa mostrare.
function tryShowApp() {
  if (!firebaseStateReady || !firebaseAuthKnown) return;
  if (firebaseAuthUser && state.users[firebaseAuthUser.uid]) {
    // Utente autenticato e profilo esistente → apri l'app
    state.currentUserId = firebaseAuthUser.uid;
    saveCurrentUserId(state.currentUserId);
    if ($("app").classList.contains("hidden")) showApp();
    else renderAll();
  } else if (firebaseAuthUser && !state.users[firebaseAuthUser.uid]) {
    // Autenticato ma senza profilo in RTDB → probabilmente registrazione in corso,
    // lasciamo fare al register handler.
  } else {
    // Non autenticato → schermata di login
    state.currentUserId = null;
    if ($("loginScreen").classList.contains("hidden")) showLogin();
    else renderQuickAccounts();
  }
}

// ---------- LOGIN / REGISTER (Firebase Auth) ----------
let loginAvatarData = null; // data URL (preview + upload dopo signUp)

function makeTag(u) {
  return u.name.toLowerCase().replace(/[^a-z0-9]/g, "") + "#" + u.id.slice(-4);
}

// Traduce gli errori di Firebase Auth in messaggi in italiano
function translateAuthError(err) {
  const code = err?.code || "";
  if (code === "auth/wrong-password" || code === "auth/invalid-credential") return "Password errata.";
  if (code === "auth/user-not-found") return "Utente non trovato.";
  if (code === "auth/email-already-in-use") return "Nome utente già in uso. Scegline un altro.";
  if (code === "auth/weak-password") return "La password è troppo debole (minimo 6 caratteri).";
  if (code === "auth/network-request-failed") return "Errore di rete. Controlla la connessione.";
  if (code === "auth/too-many-requests") return "Troppi tentativi. Riprova tra qualche minuto.";
  return err?.message || "Errore sconosciuto.";
}

// Switch tabs login/register
document.querySelectorAll(".login-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".login-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $("loginForm").classList.toggle("hidden", tab !== "login");
    $("registerForm").classList.toggle("hidden", tab !== "register");
    $("loginError").classList.add("hidden");
    $("registerError").classList.add("hidden");
  });
});

function renderQuickAccounts() {
  const wrap = $("quickAccountsWrap");
  const list = $("existingAccountsList");
  if (!wrap || !list) return;
  const accounts = Object.values(state.users || {});
  list.innerHTML = "";
  if (accounts.length === 0) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const u of accounts) {
    const row = el("div", "login-account");
    row.innerHTML = `
      <img src="${u.avatar}" />
      <div class="info">
        <div class="name">${esc(u.name)}</div>
        <div class="tag">${esc(makeTag(u))}</div>
      </div>`;
    row.addEventListener("click", () => {
      $("loginUsername").value = u.name;
      $("loginPassword").focus();
    });
    list.appendChild(row);
  }
}

function showLoginError(msg) {
  const e = $("loginError"); e.textContent = msg; e.classList.remove("hidden");
}
function showRegisterError(msg) {
  const e = $("registerError"); e.textContent = msg; e.classList.remove("hidden");
}

$("loginAvatarInput")?.addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  loginAvatarData = await resizeImage(f, 256, 0.85);
  $("loginAvatarPreview").src = loginAvatarData;
});
$("regUsername")?.addEventListener("input", (e) => {
  if (!loginAvatarData) $("loginAvatarPreview").src = defaultAvatar(e.target.value || "?");
});

$("loginBtn").addEventListener("click", async () => {
  const name = $("loginUsername").value.trim();
  const pwd = $("loginPassword").value;
  if (!name || !pwd) { showLoginError("Inserisci nome utente e password."); return; }
  $("loginBtn").disabled = true;
  try {
    const user = await WMF.signIn(name, pwd);
    // Profilo già presente in RTDB? Se no, lo creiamo (può capitare in edge case)
    if (!state.users[user.uid]) {
      state.users[user.uid] = {
        id: user.uid,
        name,
        avatar: defaultAvatar(name),
        banner: "",
        bio: "",
        lastSeen: now()
      };
    } else {
      state.users[user.uid].lastSeen = now();
    }
    state.currentUserId = user.uid;
    await saveNow();
    showApp();
  } catch (err) {
    showLoginError(translateAuthError(err));
  } finally {
    $("loginBtn").disabled = false;
  }
});
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
$("loginUsername").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginPassword").focus(); });

$("registerBtn").addEventListener("click", async () => {
  const name = $("regUsername").value.trim();
  const pwd = $("regPassword").value;
  if (!name) { showRegisterError("Scegli un nome utente."); return; }
  if (!pwd || pwd.length < 6) { showRegisterError("La password deve avere almeno 6 caratteri."); return; }
  // Check nome utente univoco contro lo stato corrente (lettura da RTDB realtime)
  const exists = Object.values(state.users).some(u => u.name && u.name.toLowerCase() === name.toLowerCase());
  if (exists) { showRegisterError("Nome utente già in uso. Scegline un altro."); return; }
  $("registerBtn").disabled = true;
  try {
    const user = await WMF.signUp(name, pwd);
    // Upload avatar su Firebase Storage (se scelto)
    let avatarUrl = defaultAvatar(name);
    if (loginAvatarData) {
      try {
        avatarUrl = await WMF.uploadDataURL(`avatars/${user.uid}/${WMF.randId()}`, loginAvatarData);
      } catch (e) {
        console.error("Avatar upload failed:", e);
      }
    }
    state.users[user.uid] = {
      id: user.uid,
      name,
      avatar: avatarUrl,
      banner: "",
      bio: "",
      lastSeen: now()
    };
    state.currentUserId = user.uid;
    loginAvatarData = null;
    await saveNow();
    showApp();
  } catch (err) {
    showRegisterError(translateAuthError(err));
  } finally {
    $("registerBtn").disabled = false;
  }
});
$("regPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("registerBtn").click(); });
$("regUsername").addEventListener("keydown", (e) => { if (e.key === "Enter") $("regPassword").focus(); });

if ($("loginAvatarPreview")) $("loginAvatarPreview").src = defaultAvatar("?");

function showApp() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  startHeartbeat();
  renderAll();
}

function showLogin() {
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  stopHeartbeat();
  renderQuickAccounts();
}

// Stato iniziale: mostra login. Sarà tryShowApp() a decidere in base
// ai callback di Firebase (auth + state).
showLogin();

// ---------- HEARTBEAT / STATO ONLINE ----------
// Scrive solo users/{uid}/lastSeen per non sovrascrivere tutto lo stato ogni 10s.
let heartbeatInterval = null;
function writeHeartbeat() {
  const uid = state.currentUserId;
  if (!uid) return;
  const me = state.users[uid];
  if (!me) return;
  const t = now();
  me.lastSeen = t;
  WMF.writePath(`users/${uid}/lastSeen`, t).catch(e => console.error("heartbeat error:", e));
}
function startHeartbeat() {
  stopHeartbeat();
  if (!state.currentUserId) return;
  writeHeartbeat();
  heartbeatInterval = setInterval(() => {
    writeHeartbeat();
    // Aggiorna lo stato online nei riquadri visibili
    if (state.currentView.type === "group") renderMembersBar();
    if (state.currentView.type === "home" && state.currentView.subview === "leaderboard") renderLeaderboardPage();
  }, 10000);
}
function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}
function isOnline(u) {
  if (!u || !u.lastSeen) return false;
  return (now() - u.lastSeen) < 30000;
}

// ---------- SELF-DESTRUCT MESSAGGI ----------
let selfDestructSeconds = 0; // 0 = disabilitato

function pruneSelfDestructed(silent = false) {
  const t = now();
  let changed = false;
  for (const did in state.dms) {
    const d = state.dms[did];
    const before = d.messages.length;
    d.messages = d.messages.filter(m => !m.expiresAt || m.expiresAt > t);
    if (d.messages.length !== before) changed = true;
  }
  for (const gid in state.groups) {
    const g = state.groups[gid];
    if (!g.messages) continue;
    for (const cid in g.messages) {
      const before = g.messages[cid].length;
      g.messages[cid] = g.messages[cid].filter(m => !m.expiresAt || m.expiresAt > t);
      if (g.messages[cid].length !== before) changed = true;
    }
  }
  if (changed) {
    save();
    if (!silent && (state.currentView.type === "dm" || state.currentView.type === "group")) renderChat();
  }
}

// Aggiorna ogni secondo i countdown dei messaggi auto-distruttivi
setInterval(() => {
  if (!state.currentUserId) return;
  let needsPrune = false;
  document.querySelectorAll(".message[data-expires]").forEach(elm => {
    const exp = parseInt(elm.dataset.expires);
    const remaining = Math.max(0, Math.ceil((exp - now()) / 1000));
    const t = elm.querySelector(".self-destruct-timer");
    if (t) t.textContent = `⏱ ${remaining}s`;
    if (remaining <= 0) needsPrune = true;
  });
  if (needsPrune) pruneSelfDestructed();
}, 1000);

// ---------- RENDER ----------
function renderAll() {
  if (!state.currentUserId || !state.users[state.currentUserId]) return;
  pruneSelfDestructed(true);
  renderUserPanel();
  renderServers();
  renderMainView();
}

function renderUserPanel() {
  const u = getCurrentUser(); if (!u) return;
  $("userPanelAvatar").src = u.avatar;
  $("userPanelName").textContent = u.name;
  // Status dot del pannello utente (sempre online quando l'app è aperta)
  const dot = document.querySelector("#userPanel .avatar-wrap .status-dot");
  if (dot) { dot.classList.add("online"); dot.classList.remove("offline"); }
  // badge richieste amicizia
  const pending = state.friendRequests.filter(r => r.toId === u.id && r.status === "pending").length;
  const badge = $("friendRequestBadge");
  if (pending > 0) { badge.textContent = pending; badge.classList.remove("hidden"); }
  else { badge.classList.add("hidden"); }
}

function renderServers() {
  const list = $("serversList"); list.innerHTML = "";
  const u = getCurrentUser();
  const myGroups = Object.values(state.groups).filter(g => g.members.includes(u.id));
  for (const g of myGroups) {
    const icon = el("div", "server-icon");
    icon.title = g.name;
    if (g.icon) {
      icon.innerHTML = `<img src="${g.icon}" alt="${esc(g.name)}" />`;
    } else {
      icon.textContent = g.name.slice(0, 2).toUpperCase();
    }
    if (state.currentView.type === "group" && state.currentView.groupId === g.id) icon.classList.add("active");
    icon.addEventListener("click", () => openGroup(g.id));
    list.appendChild(icon);
  }
  // home attiva?
  $("homeBtn").classList.toggle("active", state.currentView.type !== "group");
}

function renderMainView() {
  const v = state.currentView;
  if (v.type === "group") {
    $("homeView").classList.add("hidden");
    $("groupView").classList.remove("hidden");
    $("channelsHeader").textContent = state.groups[v.groupId].name;
    renderGroupChannels();
    renderMembersBar();
    renderChat();
  } else {
    $("groupView").classList.add("hidden");
    $("homeView").classList.remove("hidden");
    $("channelsHeader").textContent = "Messaggi diretti";
    renderDMList();
    $("membersBar").classList.add("hidden");
    if (v.type === "home") {
      if (v.subview === "polls") renderPollsPage();
      else if (v.subview === "leaderboard") renderLeaderboardPage();
      else renderFriendsPage();
    } else {
      renderChat();
    }
  }
}

// ---------- DM LIST ----------
function renderDMList() {
  const box = $("dmList"); box.innerHTML = "";
  const u = getCurrentUser();
  const myDMs = Object.values(state.dms).filter(d => d.participants.includes(u.id));
  // Ordina per ultimo messaggio
  myDMs.sort((a, b) => {
    const la = a.messages[a.messages.length - 1]?.ts || 0;
    const lb = b.messages[b.messages.length - 1]?.ts || 0;
    return lb - la;
  });
  for (const d of myDMs) {
    const otherId = d.participants.find(p => p !== u.id);
    const other = state.users[otherId]; if (!other) continue;
    const row = el("div", "dm-item");
    if (state.currentView.type === "dm" && state.currentView.id === d.id) row.classList.add("active");
    row.innerHTML = `<img src="${other.avatar}" /><span>${esc(other.name)}</span><span class="close-dm">×</span>`;
    row.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("close-dm")) {
        delete state.dms[d.id];
        if (state.currentView.type === "dm" && state.currentView.id === d.id) state.currentView = { type: "home", subview: "friends" };
        save(); renderAll();
      } else {
        openDM(d.id);
      }
    });
    box.appendChild(row);
  }
}

// ---------- GROUP CHANNELS ----------
function renderGroupChannels() {
  const v = state.currentView;
  const g = state.groups[v.groupId];
  $("groupHeader").textContent = g.name;
  const tb = $("textChannelsList"); tb.innerHTML = "";
  const vb = $("voiceChannelsList"); vb.innerHTML = "";
  for (const ch of g.channels) {
    const row = el("div", "channel-item");
    const isActive = v.channelId === ch.id;
    if (isActive && ch.type === "text") row.classList.add("active");
    if (ch.type === "text") {
      row.innerHTML = `<span class="hash">#</span><span>${esc(ch.name)}</span>`;
      row.addEventListener("click", () => { state.currentView = { type: "group", groupId: g.id, channelId: ch.id }; save(); renderAll(); });
      tb.appendChild(row);
    } else {
      row.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3v2a5 5 0 0 1 0 10v2a7 7 0 0 0 0-14zm0 4v2a1 1 0 0 1 0 2v2a3 3 0 0 0 0-6zM3 9v6h4l5 5V4L7 9H3z"/></svg><span>${esc(ch.name)}</span>`;
      row.addEventListener("click", () => joinVoiceChannel(g.id, ch.id));
      vb.appendChild(row);
      // mostra membri connessi
      const connected = (g.voiceState && g.voiceState[ch.id]) || [];
      if (connected.length) {
        const mb = el("div", "voice-members");
        for (const uidx of connected) {
          const uu = state.users[uidx]; if (!uu) continue;
          const vm = el("div", "voice-member");
          const speaking = isUserSpeaking(g.id, ch.id, uidx);
          vm.innerHTML = `<img src="${uu.avatar}" class="${speaking ? 'speaking-ring' : ''}" /><span>${esc(uu.name)}</span>`;
          mb.appendChild(vm);
        }
        vb.appendChild(mb);
      }
    }
  }
}

// ---------- MEMBERS BAR ----------
function renderMembersBar() {
  const v = state.currentView;
  if (v.type !== "group") { $("membersBar").classList.add("hidden"); return; }
  $("membersBar").classList.remove("hidden");
  const g = state.groups[v.groupId];
  $("membersTitle").textContent = `Membri—${g.members.length}`;
  const list = $("membersList"); list.innerHTML = "";

  const onlineMembers = g.members.filter(id => isOnline(state.users[id]));
  const offlineMembers = g.members.filter(id => !isOnline(state.users[id]));

  function buildRow(mid) {
    const m = state.users[mid]; if (!m) return null;
    const row = el("div", "member-item" + (isOnline(m) ? "" : " offline"));
    // Speaking? (se siamo nello stesso voice channel di questo gruppo)
    let speakingClass = "";
    if (currentVoice && currentVoice.groupId === g.id && isUserSpeaking(g.id, currentVoice.channelId, mid)) {
      speakingClass = " speaking-ring";
    }
    row.innerHTML = `
      <div class="avatar-wrap">
        <img src="${m.avatar}" class="${speakingClass.trim()}" />
        <span class="status-dot ${isOnline(m) ? 'online' : 'offline'}"></span>
      </div>
      <div class="member-name">${esc(m.name)}${g.creatorId === mid ? '<span class="member-crown">👑</span>' : ''}</div>`;
    row.addEventListener("click", (ev) => showProfilePopup(m.id, ev));
    return row;
  }

  if (onlineMembers.length) {
    list.appendChild(el("div", "members-group-label", `IN LINEA — ${onlineMembers.length}`));
    onlineMembers.forEach(id => { const r = buildRow(id); if (r) list.appendChild(r); });
  }
  if (offlineMembers.length) {
    list.appendChild(el("div", "members-group-label", `OFFLINE — ${offlineMembers.length}`));
    offlineMembers.forEach(id => { const r = buildRow(id); if (r) list.appendChild(r); });
  }
}

// ---------- CHAT ----------
function renderChat() {
  $("friendsPage").classList.add("hidden");
  $("pollsPage").classList.add("hidden");
  $("leaderboardPage").classList.add("hidden");
  $("messagesList").classList.remove("hidden");
  $("inputArea").classList.remove("hidden");

  const v = state.currentView;
  let messages = [], header = "", showInput = true;
  if (v.type === "dm") {
    const d = state.dms[v.id];
    if (!d) return;
    const otherId = d.participants.find(p => p !== state.currentUserId);
    const other = state.users[otherId];
    header = `@${other?.name || "??"}`;
    messages = d.messages;
  } else if (v.type === "group") {
    const g = state.groups[v.groupId];
    const ch = g.channels.find(c => c.id === v.channelId);
    if (!ch || ch.type !== "text") {
      $("mainHeaderTitle").textContent = g.name;
      $("messagesList").innerHTML = '<div class="friends-empty">Seleziona un canale testuale</div>';
      return;
    }
    header = `# ${ch.name}`;
    messages = (g.messages && g.messages[ch.id]) || [];
  } else {
    $("mainHeaderTitle").textContent = "Home";
    return;
  }
  $("mainHeaderTitle").textContent = header;
  $("mainHeaderActions").innerHTML = v.type === "group"
    ? '<button class="header-action-btn" id="addMemberHeaderBtn">+ Aggiungi membri</button>'
    : "";
  const amb = $("addMemberHeaderBtn");
  if (amb) amb.addEventListener("click", () => openAddMemberModal());

  // Render messaggi
  const box = $("messagesList"); box.innerHTML = "";
  let lastAuthor = null, lastTs = 0;
  for (const m of messages) {
    // Messaggio di sistema (aggiungi/rimuovi membro, ecc.)
    if (m.system) {
      const sysRow = el("div", "system-message");
      const iconSvg = m.action === "add"
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 12H5M11 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      sysRow.innerHTML = `
        <span class="system-icon ${m.action === 'add' ? 'add' : 'remove'}">${iconSvg}</span>
        <span class="system-text">${esc(m.text)}</span>
        <span class="system-time">${fmtTime(m.ts)}</span>`;
      box.appendChild(sysRow);
      lastAuthor = null; lastTs = 0;
      continue;
    }
    const author = state.users[m.authorId] || { name: "?", avatar: defaultAvatar("?") };
    const isReply = !!m.replyTo;
    const grouped = (author.id === lastAuthor) && (m.ts - lastTs < 5 * 60 * 1000) && !isReply;
    const mentionsMe = messageMentionsMe(m.text);
    const sdClass = m.expiresAt ? " self-destruct" : "";
    const row = el("div", "message" + (grouped ? " grouped" : "") + (mentionsMe ? " mentions-me" : "") + sdClass);
    row.dataset.msgId = m.id;
    if (m.expiresAt) row.dataset.expires = m.expiresAt;
    const isCreatorInGroup = v.type === "group" && state.groups[v.groupId].creatorId === author.id;
    const crownClass = isCreatorInGroup ? " crown" : "";

    // Reply reference (riga citazione sopra)
    let replyHtml = "";
    if (isReply) {
      const refMsg = messages.find(mm => mm.id === m.replyTo);
      if (refMsg) {
        const refAuthor = state.users[refMsg.authorId] || { name: "?", avatar: defaultAvatar("?") };
        replyHtml = `<div class="message-reply-ref" data-jump-to="${refMsg.id}">
          <img src="${refAuthor.avatar}" />
          <span class="reply-author">${esc(refAuthor.name)}</span>
          <span class="reply-text">${renderMessageText(refMsg.text || "[allegato]").replace(/<[^>]+>/g, "")}</span>
        </div>`;
      }
    }

    let attachHtml = "";
    if (m.attachments) {
      for (let i = 0; i < m.attachments.length; i++) {
        const att = m.attachments[i];
        const url = att.url || att.data || "";
        if (!url) continue;
        if (att.type.startsWith("image/")) attachHtml += `<div class="message-attachment"><img src="${url}" /></div>`;
        else if (att.type.startsWith("video/")) attachHtml += `<div class="message-attachment"><video controls src="${url}"></video></div>`;
        else if (att.type.startsWith("audio/")) attachHtml += `<div class="voice-message"><audio controls src="${url}"></audio><span class="voice-message-duration">${att.duration || ""}</span></div>`;
      }
    }

    // Reazioni
    let reactionsHtml = "";
    if (m.reactions && Object.keys(m.reactions).length > 0) {
      reactionsHtml = '<div class="reactions">';
      for (const emoji in m.reactions) {
        const users = m.reactions[emoji];
        if (!users.length) continue;
        const mine = users.includes(state.currentUserId);
        reactionsHtml += `<div class="reaction${mine ? " mine" : ""}" data-emoji="${esc(emoji)}"><span>${esc(emoji)}</span><span class="reaction-count">${users.length}</span></div>`;
      }
      reactionsHtml += '</div>';
    }

    const editedHtml = m.edited ? '<span class="message-edited">(modificato)</span>' : '';
    const sdTimerHtml = m.expiresAt
      ? `<span class="self-destruct-timer">⏱ ${Math.max(0, Math.ceil((m.expiresAt - now()) / 1000))}s</span>`
      : '';

    // Sondaggio inline (msg.poll = { question, options })
    let pollInlineHtml = "";
    if (m.poll) pollInlineHtml = renderInlinePoll(m);

    row.innerHTML = `
      ${replyHtml}
      <img class="message-avatar" src="${author.avatar}" />
      <div class="message-body">
        <div class="message-header">
          <span class="message-author${crownClass}">${esc(author.name)}</span>
          <span class="message-time">${fmtTime(m.ts)}</span>
          ${sdTimerHtml}
        </div>
        <div class="message-content">
          ${m.text ? `<div class="message-text">${renderMessageText(m.text)}${editedHtml}</div>` : ""}
          ${pollInlineHtml}
          ${attachHtml}
          ${reactionsHtml}
        </div>
      </div>
      <div class="message-actions">
        <button class="message-action-btn" data-action="quick-react" title="Reazione 👍">👍</button>
        <button class="message-action-btn" data-action="reply" title="Rispondi">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
        </button>
        ${m.authorId === state.currentUserId ? '<button class="message-action-btn" data-action="edit" title="Modifica"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75l11-11-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0L15.13 5.12l3.75 3.75 1.82-1.83z"/></svg></button>' : ''}
        <button class="message-action-btn" data-action="more" title="Altro">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>`;

    row.querySelector(".message-avatar")?.addEventListener("click", (ev) => showProfilePopup(author.id, ev));
    row.querySelector(".message-author")?.addEventListener("click", (ev) => showProfilePopup(author.id, ev));
    // Mentions clickable
    row.querySelectorAll(".mention").forEach(elm => {
      elm.addEventListener("click", (ev) => {
        const name = elm.textContent.replace(/^@/, "");
        const u = Object.values(state.users).find(x => x.name === name);
        if (u) showProfilePopup(u.id, ev);
      });
    });
    // Reaction toggles
    row.querySelectorAll(".reaction").forEach(rEl => {
      rEl.addEventListener("click", () => toggleReaction(m.id, rEl.dataset.emoji));
    });
    // Hover action bar
    row.querySelectorAll(".message-action-btn").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === "quick-react") toggleReaction(m.id, "👍");
        else if (action === "reply") startReply(m.id);
        else if (action === "edit") startEdit(m.id);
        else if (action === "more") openMessageContextMenu(m.id, ev);
      });
    });
    // Click sui poll inline
    row.querySelectorAll(".inline-poll-option").forEach(opt => {
      opt.addEventListener("click", () => voteInlinePoll(m.id, parseInt(opt.dataset.idx)));
    });
    box.appendChild(row);
    lastAuthor = author.id; lastTs = m.ts;
  }
  box.scrollTop = box.scrollHeight;
}

// Menu contestuale del messaggio (3 puntini hover)
function openMessageContextMenu(messageId, ev) {
  const m = findMessage(messageId); if (!m) return;
  const isMine = m.authorId === state.currentUserId;
  const items = [];
  // Reazioni quick
  items.push({
    customHtml: `<div class="reactions-quick">
      ${["👍","✅","😭","❤️","🔥","😂"].map(e => `<button data-emoji="${e}">${e}</button>`).join("")}
      <button data-action="more-emoji" title="Altro">➕</button>
    </div>`,
    handler: (root) => {
      root.querySelectorAll("[data-emoji]").forEach(b => b.addEventListener("click", () => {
        toggleReaction(messageId, b.dataset.emoji); hideContextMenu();
      }));
      root.querySelector('[data-action="more-emoji"]')?.addEventListener("click", () => {
        const e = prompt("Inserisci un emoji:", "🎉");
        if (e) { toggleReaction(messageId, e); hideContextMenu(); }
      });
    }
  });
  if (isMine) items.push({ label: "Modifica il messaggio", icon: pencilIcon(), onClick: () => { startEdit(messageId); hideContextMenu(); } });
  items.push({ label: "Rispondi", icon: replyIcon(), onClick: () => { startReply(messageId); hideContextMenu(); } });
  items.push({ label: "Inoltra", icon: forwardIcon(), onClick: () => { forwardMessage(messageId); hideContextMenu(); } });
  if (m.text) items.push({ label: "Copia il testo", icon: copyIcon(), onClick: () => { navigator.clipboard?.writeText(m.text); hideContextMenu(); } });
  items.push({ label: m.pinned ? "Stacca il messaggio" : "Attacca il messaggio", icon: pinIcon(), onClick: () => { m.pinned = !m.pinned; save(); renderChat(); hideContextMenu(); } });
  items.push({ label: "Segnala come non letto", icon: unreadIcon(), onClick: () => { m.unreadFlag = true; save(); renderChat(); hideContextMenu(); } });
  items.push({ label: "Copia il link del messaggio", icon: linkIcon(), onClick: () => { navigator.clipboard?.writeText(`whatsdisco://message/${messageId}`); hideContextMenu(); } });
  if (m.text) items.push({ label: "Ascolta il messaggio", icon: speakerIcon(), onClick: () => { speakMessage(m.text); hideContextMenu(); } });
  if (isMine) {
    items.push({ divider: true });
    items.push({ label: "Elimina il messaggio", icon: trashIcon(), danger: true, onClick: () => { if (confirm("Eliminare questo messaggio?")) { deleteMessage(messageId); hideContextMenu(); } } });
  }
  items.push({ label: "Copia ID messaggio", icon: idIcon(), onClick: () => { navigator.clipboard?.writeText(messageId); hideContextMenu(); } });
  showContextMenu(items, ev.clientX, ev.clientY);
}

function speakMessage(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "it-IT";
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { alert("Sintesi vocale non disponibile"); }
}

function forwardMessage(messageId) {
  const m = findMessage(messageId); if (!m) return;
  const me = getCurrentUser();
  // Costruisci lista di destinazioni: amici (DM) + miei gruppi
  const friendIds = state.friends.filter(p => p.includes(me.id)).map(p => p.find(x => x !== me.id));
  const friends = friendIds.map(id => state.users[id]).filter(Boolean);
  const myGroups = Object.values(state.groups).filter(g => g.members.includes(me.id));
  const choices = [
    ...friends.map(f => ({ label: `@${f.name}`, action: () => forwardToDM(f.id, m) })),
    ...myGroups.map(g => ({ label: `# ${g.name}`, action: () => forwardToGroup(g.id, m) }))
  ];
  if (!choices.length) { alert("Non hai amici o gruppi a cui inoltrare."); return; }
  const labels = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
  const idx = prompt(`Inoltra a:\n${labels}\n\nInserisci il numero:`);
  const n = parseInt(idx) - 1;
  if (n >= 0 && n < choices.length) { choices[n].action(); alert("Messaggio inoltrato."); }
}
function forwardToDM(otherId, m) {
  const me = getCurrentUser();
  let dm = Object.values(state.dms).find(d => d.participants.includes(me.id) && d.participants.includes(otherId));
  if (!dm) { dm = { id: "dm_" + uid(), participants: [me.id, otherId], messages: [] }; state.dms[dm.id] = dm; }
  dm.messages.push({ id: "m_" + uid(), authorId: me.id, ts: now(), text: m.text, attachments: m.attachments || [], reactions: {}, forwarded: true });
  save();
}
function forwardToGroup(groupId, m) {
  const me = getCurrentUser();
  const g = state.groups[groupId];
  const ch = g.channels.find(c => c.type === "text");
  if (!ch) return;
  if (!g.messages) g.messages = {};
  if (!g.messages[ch.id]) g.messages[ch.id] = [];
  g.messages[ch.id].push({ id: "m_" + uid(), authorId: me.id, ts: now(), text: m.text, attachments: m.attachments || [], reactions: {}, forwarded: true });
  save();
}

// Icone SVG inline
function svgI(p) { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${p}</svg>`; }
function pencilIcon() { return svgI('<path d="M3 17.25V21h3.75l11-11-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0L15.13 5.12l3.75 3.75 1.82-1.83z"/>'); }
function replyIcon() { return svgI('<path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/>'); }
function forwardIcon() { return svgI('<path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/>'); }
function copyIcon() { return svgI('<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/>'); }
function pinIcon() { return svgI('<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>'); }
function unreadIcon() { return svgI('<circle cx="12" cy="12" r="6"/>'); }
function linkIcon() { return svgI('<path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4a5 5 0 0 0 0-10z"/>'); }
function speakerIcon() { return svgI('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4-1 7-4.66 7-8.77S18 4.23 14 3.23z"/>'); }
function trashIcon() { return svgI('<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>'); }
function idIcon() { return svgI('<path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-9 11H6v-1.5h5V15zm0-3H6v-1.5h5V12zm0-3H6V7.5h5V9zm6.55 6L13 11.5l1-1 1.55 1.55L18.5 9l1 1L15.55 15z"/>'); }

// ---------- FRIENDS PAGE ----------
function renderFriendsPage() {
  $("messagesList").classList.add("hidden");
  $("inputArea").classList.add("hidden");
  $("recordingBar").classList.add("hidden");
  $("friendsPage").classList.remove("hidden");
  $("mainHeaderTitle").innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg> Amici';
  $("mainHeaderActions").innerHTML = "";

  const u = getCurrentUser();
  const pending = state.friendRequests.filter(r => r.status === "pending" && (r.toId === u.id || r.fromId === u.id));
  $("pendingCount").textContent = pending.length;
  $("pendingCount").classList.toggle("hidden", pending.length === 0);

  const content = $("friendsTabContent"); content.innerHTML = "";
  if (friendsTab === "all") {
    const myFriends = state.friends
      .filter(p => p.includes(u.id))
      .map(p => state.users[p.find(x => x !== u.id)])
      .filter(Boolean);
    if (myFriends.length === 0) {
      content.innerHTML = '<div class="friends-empty">Non hai ancora amici. Usa la tab "Aggiungi amico" per iniziare!</div>';
    } else {
      for (const f of myFriends) {
        const row = el("div", "friend-row");
        row.innerHTML = `
          <img src="${f.avatar}" />
          <div class="info"><div class="name">${esc(f.name)}</div><div class="status">${esc(f.bio || "")}</div></div>
          <div class="actions">
            <button title="Messaggio" class="msg-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6l-4 4V6a2 2 0 0 1 2-2z"/></svg></button>
          </div>`;
        row.querySelector("img").addEventListener("click", (ev) => showProfilePopup(f.id, ev));
        row.querySelector(".name").addEventListener("click", (ev) => showProfilePopup(f.id, ev));
        row.querySelector(".msg-btn").addEventListener("click", () => openDMWithUser(f.id));
        content.appendChild(row);
      }
    }
  } else if (friendsTab === "pending") {
    if (pending.length === 0) {
      content.innerHTML = '<div class="friends-empty">Nessuna richiesta in sospeso</div>';
    } else {
      for (const r of pending) {
        const isIncoming = r.toId === u.id;
        const other = state.users[isIncoming ? r.fromId : r.toId];
        if (!other) continue;
        const row = el("div", "friend-row");
        row.innerHTML = `
          <img src="${other.avatar}" />
          <div class="info"><div class="name">${esc(other.name)}</div><div class="status">${isIncoming ? "Richiesta in arrivo" : "Richiesta inviata"}</div></div>
          <div class="actions">
            ${isIncoming
              ? `<button class="accept" title="Accetta"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.6L4 14l5 5 11-11-1.4-1.4z"/></svg></button>
                 <button class="reject" title="Rifiuta"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>`
              : `<button class="reject" title="Annulla"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>`}
          </div>`;
        const acc = row.querySelector(".accept"), rej = row.querySelector(".reject");
        if (acc) acc.addEventListener("click", () => acceptFriendRequest(r.id));
        if (rej) rej.addEventListener("click", () => rejectFriendRequest(r.id));
        content.appendChild(row);
      }
    }
  } else if (friendsTab === "add") {
    content.innerHTML = `
      <div style="padding: 8px 0;">
        <div style="font-weight:600;margin-bottom:6px;">AGGIUNGI AMICO</div>
        <div style="color:var(--text-secondary);font-size:14px;margin-bottom:8px;">Scrivi il nome utente di una persona per inviargli una richiesta di amicizia.</div>
        <div class="add-friend-form">
          <input type="text" id="addFriendInput" placeholder="Nome utente" />
          <button id="addFriendBtn">Invia richiesta di amicizia</button>
        </div>
        <div id="addFriendResult" style="margin-top:12px;font-size:13px;"></div>
        <div style="margin-top:24px;font-weight:600;">SUGGERIMENTI</div>
        <div id="suggestions"></div>
      </div>`;
    $("addFriendBtn").addEventListener("click", sendFriendRequestByName);
    $("addFriendInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendFriendRequestByName(); });
    // suggerimenti: utenti che non sono amici e non sono me
    const sg = $("suggestions");
    const myFriendIds = new Set(state.friends.filter(p => p.includes(u.id)).map(p => p.find(x => x !== u.id)));
    for (const uu of Object.values(state.users)) {
      if (uu.id === u.id || myFriendIds.has(uu.id)) continue;
      const row = el("div", "friend-row");
      row.innerHTML = `
        <img src="${uu.avatar}" />
        <div class="info"><div class="name">${esc(uu.name)}</div><div class="status">${esc(uu.bio || "")}</div></div>
        <div class="actions"><button class="accept" title="Invia richiesta"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg></button></div>`;
      row.querySelector("img").addEventListener("click", (ev) => showProfilePopup(uu.id, ev));
      row.querySelector(".name").addEventListener("click", (ev) => showProfilePopup(uu.id, ev));
      row.querySelector("button").addEventListener("click", () => sendFriendRequest(uu.id));
      sg.appendChild(row);
    }
  }
}

// ---------- EVENTI TAB AMICI ----------
document.querySelectorAll(".friends-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".friends-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    friendsTab = btn.dataset.tab;
    renderFriendsPage();
  });
});

// ---------- FRIENDS LOGIC ----------
function sendFriendRequestByName() {
  const raw = $("addFriendInput").value.trim();
  if (!raw) return;
  // Riallinea con localStorage (se l'amico ha appena creato l'account in un'altra tab)
  reloadStateFromStorage();
  // Strip eventuale tag #1234 alla fine
  const name = raw.replace(/#[0-9a-f]{4}$/i, "").trim().toLowerCase();
  const u = getCurrentUser();
  const target = Object.values(state.users).find(x => {
    if (!x.name || x.id === u.id) return false;
    return x.name.toLowerCase() === name || x.name.toLowerCase().trim() === name;
  });
  const res = $("addFriendResult");
  if (!target) {
    res.innerHTML = `<span style="color:var(--danger)">Nessun utente trovato con il nome "${esc(raw)}". Controlla che lo abbia scritto giusto e che si sia registrato (anche su un'altra tab dello stesso browser).</span>`;
    return;
  }
  const ok = sendFriendRequest(target.id);
  res.innerHTML = ok ? `<span style="color:var(--green)">Richiesta inviata a ${esc(target.name)}!</span>` : `<span style="color:var(--gold)">Richiesta già esistente o sei già amico.</span>`;
  $("addFriendInput").value = "";
  renderFriendsPage();
}
function sendFriendRequest(toId) {
  const u = getCurrentUser();
  if (toId === u.id) return false;
  // già amici?
  const already = state.friends.some(p => p.includes(u.id) && p.includes(toId));
  if (already) return false;
  // richiesta già in sospeso?
  const existing = state.friendRequests.find(r => r.status === "pending" && ((r.fromId === u.id && r.toId === toId) || (r.fromId === toId && r.toId === u.id)));
  if (existing) return false;
  state.friendRequests.push({ id: "fr_" + uid(), fromId: u.id, toId, status: "pending", ts: now() });
  save();
  playNotifSound();
  renderAll();
  return true;
}
function acceptFriendRequest(reqId) {
  const r = state.friendRequests.find(x => x.id === reqId); if (!r) return;
  r.status = "accepted";
  state.friends.push([r.fromId, r.toId]);
  save(); playNotifSound();
  // crea subito DM visibile
  openDMWithUser(r.fromId === state.currentUserId ? r.toId : r.fromId, false);
  renderAll();
}
function rejectFriendRequest(reqId) {
  const r = state.friendRequests.find(x => x.id === reqId); if (!r) return;
  r.status = "rejected";
  save(); renderAll();
}

// ---------- DM ----------
function openDMWithUser(otherId, switchView = true) {
  const u = getCurrentUser();
  let dm = Object.values(state.dms).find(d => d.participants.includes(u.id) && d.participants.includes(otherId));
  if (!dm) {
    dm = { id: "dm_" + uid(), participants: [u.id, otherId], messages: [] };
    state.dms[dm.id] = dm;
  }
  save();
  if (switchView) openDM(dm.id);
  else renderAll();
}
function openDM(dmId) {
  state.currentView = { type: "dm", id: dmId };
  save(); renderAll();
}

// ---------- GROUPS ----------
function openGroup(groupId) {
  const g = state.groups[groupId];
  const firstText = g.channels.find(c => c.type === "text");
  state.currentView = { type: "group", groupId, channelId: firstText?.id };
  save(); renderAll();
}

let newGroupType = "server";
$("addServerBtn").addEventListener("click", () => {
  $("newGroupName").value = "";
  $("newGroupIcon").src = defaultAvatar("?");
  newGroupIconData = null;
  newGroupType = "server";
  document.querySelectorAll(".type-toggle .type-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.type === "server");
  });
  openModal("createGroupModal");
});
document.querySelectorAll(".type-toggle .type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".type-toggle .type-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    newGroupType = btn.dataset.type;
  });
});
let newGroupIconData = null;
$("newGroupIconInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  newGroupIconData = await resizeImage(f, 256, 0.85);
  $("newGroupIcon").src = newGroupIconData;
});
$("createGroupSubmit").addEventListener("click", async () => {
  const name = $("newGroupName").value.trim();
  if (!name) return;
  const u = getCurrentUser();
  if (!u) return;
  const btn = $("createGroupSubmit");
  btn.disabled = true;
  try {
    const id = "g_" + uid();
    // Upload icona su Storage (se scelta)
    let iconUrl = "";
    if (newGroupIconData) {
      try {
        iconUrl = await WMF.uploadDataURL(`group-icons/${id}/${WMF.randId()}`, newGroupIconData);
      } catch (e) {
        console.error("Group icon upload failed:", e);
      }
    }
    const textCh = { id: "ch_" + uid(), name: "generale", type: "text" };
    const channels = [textCh];
    let voiceState = {};
    // Solo i server hanno canali vocali e secondari; i GC sono "chat veloce"
    if (newGroupType === "server") {
      const voiceCh = { id: "ch_" + uid(), name: "Generale", type: "voice" };
      channels.push(voiceCh);
      voiceState[voiceCh.id] = [];
    }
    state.groups[id] = {
      id, name, icon: iconUrl,
      type: newGroupType,
      creatorId: u.id,
      members: [u.id],
      channels,
      messages: { [textCh.id]: [] },
      voiceState
    };
    newGroupIconData = null;
    save();
    closeModal("createGroupModal");
    openGroup(id);
  } finally {
    btn.disabled = false;
  }
});

function openAddMemberModal() {
  const v = state.currentView;
  if (v.type !== "group") return;
  const g = state.groups[v.groupId];
  const u = getCurrentUser();
  const box = $("addMemberList"); box.innerHTML = "";
  // Solo il creatore può aggiungere membri
  if (g.creatorId !== u.id) {
    box.innerHTML = '<div class="friends-empty">Solo chi ha creato il gruppo può aggiungere membri.</div>';
    openModal("addMemberModal");
    return;
  }
  const myFriends = state.friends
    .filter(p => p.includes(u.id))
    .map(p => state.users[p.find(x => x !== u.id)])
    .filter(Boolean);
  if (myFriends.length === 0) {
    box.innerHTML = '<div class="friends-empty">Non hai amici da aggiungere. Aggiungi prima qualcuno come amico!</div>';
  }
  for (const f of myFriends) {
    const row = el("div", "add-member-row");
    const already = g.members.includes(f.id);
    row.innerHTML = `<img src="${f.avatar}" /><span class="name">${esc(f.name)}</span><button class="${already ? 'added' : ''}">${already ? 'Aggiunto' : 'Aggiungi'}</button>`;
    if (!already) {
      row.querySelector("button").addEventListener("click", () => {
        g.members.push(f.id);
        // Messaggio di sistema in tutti i canali testo del gruppo
        pushSystemMessage(g, {
          action: "add",
          actorId: u.id,
          targetId: f.id,
          text: `${u.name} ha aggiunto ${f.name} al gruppo.`
        });
        save(); renderAll(); openAddMemberModal();
      });
    }
    box.appendChild(row);
  }
  openModal("addMemberModal");
}

// Inserisce un messaggio di sistema nel canale testo principale del gruppo
function pushSystemMessage(group, { action, actorId, targetId, text }) {
  const textCh = group.channels.find(c => c.type === "text");
  if (!textCh) return;
  if (!group.messages) group.messages = {};
  if (!group.messages[textCh.id]) group.messages[textCh.id] = [];
  group.messages[textCh.id].push({
    id: "m_" + uid(),
    system: true,
    action,
    actorId,
    targetId,
    text,
    ts: now()
  });
}

// ---------- PROFILE EDIT ----------
let profileEditAvatarData = null;
let profileEditBannerData = null;
$("editProfileBtn").addEventListener("click", () => {
  const u = getCurrentUser();
  $("profileEditAvatar").src = u.avatar;
  $("profileEditBanner").src = u.banner || "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#5865f2"/></svg>');
  $("profileEditName").value = u.name;
  $("profileEditBio").value = u.bio || "";
  profileEditAvatarData = null;
  profileEditBannerData = null;
  openModal("profileModal");
});
$("userPanelAvatar").addEventListener("click", () => $("editProfileBtn").click());
$("logoutBtn").addEventListener("click", async () => {
  if (currentVoice) await leaveVoiceChannel();
  stopHeartbeat();
  state.currentUserId = null;
  saveCurrentUserId(null);
  try { await WMF.signOut(); } catch (e) {}
  showLogin();
});
$("profileEditAvatarInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  // Le GIF animate piccole vengono preservate da resizeImage
  profileEditAvatarData = await resizeImage(f, 256, 0.85);
  $("profileEditAvatar").src = profileEditAvatarData;
});
$("profileEditBannerInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  // Banner: 800px max larghezza, le GIF piccole restano animate
  if (f.type === "image/gif" && f.size < 1024 * 1024) {
    profileEditBannerData = await fileToDataURL(f);
  } else {
    profileEditBannerData = await resizeImage(f, 800, 0.82);
  }
  $("profileEditBanner").src = profileEditBannerData;
});
$("profileEditSave").addEventListener("click", async () => {
  const u = getCurrentUser();
  if (!u) return;
  const btn = $("profileEditSave");
  btn.disabled = true;
  try {
    u.name = $("profileEditName").value.trim() || u.name;
    u.bio = $("profileEditBio").value;
    // Upload avatar su Storage se cambiato
    if (profileEditAvatarData) {
      try {
        u.avatar = await WMF.uploadDataURL(`avatars/${u.id}/${WMF.randId()}`, profileEditAvatarData);
      } catch (e) {
        console.error("Avatar upload failed:", e);
        alert("Errore upload avatar: " + (e.message || e));
      }
    }
    // Upload banner su Storage se cambiato
    if (profileEditBannerData) {
      try {
        u.banner = await WMF.uploadDataURL(`banners/${u.id}/${WMF.randId()}`, profileEditBannerData);
      } catch (e) {
        console.error("Banner upload failed:", e);
        alert("Errore upload banner: " + (e.message || e));
      }
    }
    profileEditAvatarData = null;
    profileEditBannerData = null;
    save();
    closeModal("profileModal");
    renderAll();
  } finally {
    btn.disabled = false;
  }
});
$("resetDataBtn").addEventListener("click", async () => {
  if (!confirm("Sei sicuro? Cancellerà TUTTI i dati di TUTTI gli utenti (profili, amici, gruppi, messaggi). L'operazione è irreversibile.")) return;
  try {
    await WMF.wipeState();
    try { await WMF.signOut(); } catch (e) {}
    saveCurrentUserId(null);
  } catch (e) {
    alert("Errore durante il reset: " + (e.message || e));
  }
  location.reload();
});

// ---------- MODALI ----------
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); }));

// ---------- NAV ----------
$("homeBtn").addEventListener("click", () => { state.currentView = { type: "home", subview: "friends" }; save(); renderAll(); });
$("friendsBtn").addEventListener("click", () => { state.currentView = { type: "home", subview: "friends" }; save(); renderAll(); });

// ---------- MESSAGGI ----------
// stato editor
let replyingTo = null; // { messageId, authorName, snippet }
let editingMessageId = null;

function sendMessage(text, attachments = [], extra = {}) {
  const u = getCurrentUser();
  const v = state.currentView;
  const msg = {
    id: "m_" + uid(),
    authorId: u.id,
    ts: now(),
    text,
    attachments,
    reactions: {},
    replyTo: replyingTo?.messageId || null,
    expiresAt: selfDestructSeconds > 0 ? now() + selfDestructSeconds * 1000 : null,
    ...extra
  };
  if (v.type === "dm") {
    state.dms[v.id].messages.push(msg);
  } else if (v.type === "group") {
    const g = state.groups[v.groupId];
    if (!g.messages) g.messages = {};
    if (!g.messages[v.channelId]) g.messages[v.channelId] = [];
    g.messages[v.channelId].push(msg);
  }
  clearReply();
  save(); renderChat();
}

function getCurrentMessages() {
  const v = state.currentView;
  if (v.type === "dm") return state.dms[v.id]?.messages || [];
  if (v.type === "group") return state.groups[v.groupId]?.messages?.[v.channelId] || [];
  return [];
}
function findMessage(messageId) {
  return getCurrentMessages().find(m => m.id === messageId);
}
function deleteMessage(messageId) {
  const v = state.currentView;
  if (v.type === "dm") {
    const d = state.dms[v.id];
    d.messages = d.messages.filter(m => m.id !== messageId);
  } else if (v.type === "group") {
    const g = state.groups[v.groupId];
    g.messages[v.channelId] = (g.messages[v.channelId] || []).filter(m => m.id !== messageId);
  }
  save(); renderChat();
}
function toggleReaction(messageId, emoji) {
  const m = findMessage(messageId); if (!m) return;
  const myId = state.currentUserId;
  if (!m.reactions) m.reactions = {};
  const arr = m.reactions[emoji] || [];
  if (arr.includes(myId)) {
    m.reactions[emoji] = arr.filter(x => x !== myId);
    if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
  } else {
    m.reactions[emoji] = [...arr, myId];
  }
  save(); renderChat();
}
function startReply(messageId) {
  const m = findMessage(messageId); if (!m) return;
  const author = state.users[m.authorId];
  replyingTo = { messageId, authorName: author?.name || "??", snippet: (m.text || "[allegato]").slice(0, 80) };
  $("replyPreviewName").textContent = replyingTo.authorName;
  $("replyPreview").classList.remove("hidden");
  $("messageInput").focus();
}
function clearReply() {
  replyingTo = null;
  $("replyPreview").classList.add("hidden");
}
function startEdit(messageId) {
  const m = findMessage(messageId); if (!m) return;
  if (m.authorId !== state.currentUserId) return;
  editingMessageId = messageId;
  $("messageInput").value = m.text || "";
  $("editPreview").classList.remove("hidden");
  $("messageInput").focus();
}
function clearEdit() {
  editingMessageId = null;
  $("editPreview").classList.add("hidden");
  $("messageInput").value = "";
}
function applyEdit(newText) {
  const m = findMessage(editingMessageId); if (!m) return;
  m.text = newText;
  m.edited = true;
  clearEdit();
  save(); renderChat();
}
$("cancelReplyBtn").addEventListener("click", clearReply);
$("cancelEditBtn").addEventListener("click", clearEdit);

// Render testo con menzioni e mantieni l'escaping HTML
function renderMessageText(text) {
  if (!text) return "";
  const me = getCurrentUser();
  // Trova nomi di tutti gli utenti, ordinati per lunghezza decrescente
  const allNames = Object.values(state.users).map(u => u.name).sort((a, b) => b.length - a.length);
  let out = esc(text);
  // Sostituisci @nome con span. Lavora sulla stringa già escapata.
  for (const name of allNames) {
    const escName = esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("@" + escName + "(?![\\w])", "g");
    const isMe = name === me?.name;
    out = out.replace(re, `<span class="mention${isMe ? " self" : ""}">@${esc(name)}</span>`);
  }
  return out;
}
function messageMentionsMe(text) {
  const me = getCurrentUser(); if (!me || !text) return false;
  return new RegExp("@" + esc(me.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w])").test(text);
}

// ---------- @MENTION AUTOCOMPLETE ----------
let mentionState = null; // { startIdx, query, candidates, activeIdx }

function getMentionCandidates() {
  // Restituisce la lista di utenti menzionabili nel contesto attuale
  const v = state.currentView;
  const me = getCurrentUser();
  if (v.type === "group") {
    const g = state.groups[v.groupId];
    return g.members.map(id => state.users[id]).filter(u => u && u.id !== me.id);
  }
  if (v.type === "dm") {
    const d = state.dms[v.id];
    const otherId = d.participants.find(p => p !== me.id);
    return [state.users[otherId]].filter(Boolean);
  }
  return [];
}

function updateMentionPopup() {
  const input = $("messageInput");
  const text = input.value;
  const caret = input.selectionStart;
  // Trova l'ultimo @ prima del caret, senza spazi dopo
  let i = caret - 1;
  let at = -1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") { at = i; break; }
    if (ch === " " || ch === "\n") break;
    i--;
  }
  if (at === -1) { hideMentionPopup(); return; }
  const query = text.slice(at + 1, caret).toLowerCase();
  const candidates = getMentionCandidates().filter(u => u.name.toLowerCase().includes(query)).slice(0, 8);
  if (!candidates.length) { hideMentionPopup(); return; }
  mentionState = { startIdx: at, query, candidates, activeIdx: 0 };
  renderMentionPopup();
}

function renderMentionPopup() {
  const pop = $("mentionPopup");
  pop.innerHTML = '<div class="mention-popup-header">MEMBRI</div>';
  mentionState.candidates.forEach((u, i) => {
    const item = el("div", "mention-item" + (i === mentionState.activeIdx ? " active" : ""));
    item.innerHTML = `<img src="${u.avatar}" /><span>${esc(u.name)}</span><span class="tag">${esc(makeTag(u))}</span>`;
    item.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickMention(i); });
    pop.appendChild(item);
  });
  pop.classList.remove("hidden");
}

function hideMentionPopup() {
  $("mentionPopup").classList.add("hidden");
  mentionState = null;
}

function pickMention(idx) {
  if (!mentionState) return;
  const u = mentionState.candidates[idx]; if (!u) return;
  const input = $("messageInput");
  const text = input.value;
  const before = text.slice(0, mentionState.startIdx);
  const after = text.slice(input.selectionStart);
  const inserted = `@${u.name} `;
  input.value = before + inserted + after;
  const newCaret = before.length + inserted.length;
  input.setSelectionRange(newCaret, newCaret);
  hideMentionPopup();
  input.focus();
}

$("messageInput").addEventListener("input", () => updateMentionPopup());
$("messageInput").addEventListener("click", () => updateMentionPopup());

$("messageInput").addEventListener("keydown", (e) => {
  // Mention navigation
  if (mentionState && !$("mentionPopup").classList.contains("hidden")) {
    if (e.key === "ArrowDown") { e.preventDefault(); mentionState.activeIdx = (mentionState.activeIdx + 1) % mentionState.candidates.length; renderMentionPopup(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); mentionState.activeIdx = (mentionState.activeIdx - 1 + mentionState.candidates.length) % mentionState.candidates.length; renderMentionPopup(); return; }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pickMention(mentionState.activeIdx); return; }
    if (e.key === "Escape") { e.preventDefault(); hideMentionPopup(); return; }
  }
  // Annulla edit con ESC
  if (e.key === "Escape") {
    if (editingMessageId) { e.preventDefault(); clearEdit(); return; }
    if (replyingTo) { e.preventDefault(); clearReply(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    if (editingMessageId) { applyEdit(text); return; }
    sendMessage(text, []);
    e.target.value = "";
  }
});

// Allegati foto/video (caricati su Firebase Storage)
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files); if (!files.length) return;
  const me = getCurrentUser(); if (!me) return;
  const attachBtn = $("attachBtn");
  attachBtn.disabled = true;
  const attachments = [];
  for (const f of files) {
    try {
      const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `attachments/${me.id}/${WMF.randId()}_${safeName}`;
      const url = await WMF.uploadFile(path, f);
      attachments.push({ type: f.type, url, name: f.name, storagePath: path });
    } catch (err) {
      console.error("Attachment upload failed:", err);
      alert("Errore caricamento allegato: " + (err.message || err));
    }
  }
  attachBtn.disabled = false;
  if (attachments.length) sendMessage("", attachments);
  e.target.value = "";
});

// ---------- VOICE MESSAGES (fino a 20 min) ----------
let mediaRecorder = null, recordedChunks = [], recordStartTime = 0, recordTimerInterval = null;
const MAX_REC_MS = 20 * 60 * 1000;

$("recordBtn").addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordTimerInterval);
      $("recordingBar").classList.add("hidden");
      $("inputArea").classList.remove("hidden");
      if (recordedChunks.length === 0 || cancelRecording) { cancelRecording = false; return; }
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      const me = getCurrentUser(); if (!me) return;
      let url;
      try {
        const path = `attachments/${me.id}/${WMF.randId()}.webm`;
        url = await WMF.uploadFile(path, blob);
      } catch (err) {
        alert("Errore upload audio: " + (err.message || err));
        return;
      }
      const secs = Math.floor((now() - recordStartTime) / 1000);
      const dur = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      sendMessage("", [{ type: "audio/webm", url, duration: dur }]);
    };
    mediaRecorder.start();
    recordStartTime = now();
    $("recordingBar").classList.remove("hidden");
    $("inputArea").classList.add("hidden");
    recordTimerInterval = setInterval(() => {
      const elapsed = now() - recordStartTime;
      const secs = Math.floor(elapsed / 1000);
      $("recordingTime").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      if (elapsed >= MAX_REC_MS) mediaRecorder.stop();
    }, 200);
  } catch (err) {
    alert("Impossibile accedere al microfono: " + err.message);
  }
});
let cancelRecording = false;
$("stopRecordBtn").addEventListener("click", () => { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); });
$("cancelRecordBtn").addEventListener("click", () => { cancelRecording = true; recordedChunks = []; if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); });

// ---------- VOICE CHANNELS ----------
let currentVoice = null; // { groupId, channelId, stream, audioContext, analyser }
let speakingDetectorInterval = null;

async function joinVoiceChannel(groupId, channelId) {
  await leaveVoiceChannel();
  const g = state.groups[groupId];
  if (!g.voiceState) g.voiceState = {};
  if (!g.voiceState[channelId]) g.voiceState[channelId] = [];
  if (!g.voiceState[channelId].includes(state.currentUserId)) g.voiceState[channelId].push(state.currentUserId);
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {}
  currentVoice = { groupId, channelId, stream, audioContext: null, analyser: null };
  // Setup speaking detection con AnalyserNode
  if (stream) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 256;
      src.connect(an);
      currentVoice.audioContext = ac;
      currentVoice.analyser = an;
      const data = new Uint8Array(an.fftSize);
      let lastSavedSpeaking = 0;
      let lastSpeakingState = false;
      speakingDetectorInterval = setInterval(() => {
        an.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) {
          const val = (data[i] - 128) / 128;
          sumSq += val * val;
        }
        const rms = Math.sqrt(sumSq / data.length);
        const speaking = rms > 0.04;
        const t = now();
        // Salva nello stato condiviso ogni ~700ms se sto parlando, o quando cambia stato
        if ((speaking && t - lastSavedSpeaking > 700) || (speaking !== lastSpeakingState)) {
          const gg = state.groups[groupId];
          if (gg) {
            if (!gg.voiceSpeaking) gg.voiceSpeaking = {};
            if (!gg.voiceSpeaking[channelId]) gg.voiceSpeaking[channelId] = {};
            if (speaking) {
              gg.voiceSpeaking[channelId][state.currentUserId] = t;
              lastSavedSpeaking = t;
            } else if (lastSpeakingState) {
              delete gg.voiceSpeaking[channelId][state.currentUserId];
            }
            save();
            // Aggiorna ring solo se necessario
            if (state.currentView.type === "group" && state.currentView.groupId === groupId) {
              renderGroupChannels();
              renderMembersBar();
            }
          }
          lastSpeakingState = speaking;
        }
      }, 200);
    } catch (e) {}
  }
  const ch = g.channels.find(c => c.id === channelId);
  $("voiceConnectedName").textContent = `${g.name} / ${ch.name}`;
  $("voiceConnectedBar").classList.remove("hidden");
  save(); renderAll();
}
async function leaveVoiceChannel() {
  if (!currentVoice) return;
  if (speakingDetectorInterval) { clearInterval(speakingDetectorInterval); speakingDetectorInterval = null; }
  const g = state.groups[currentVoice.groupId];
  if (g && g.voiceState && g.voiceState[currentVoice.channelId]) {
    g.voiceState[currentVoice.channelId] = g.voiceState[currentVoice.channelId].filter(x => x !== state.currentUserId);
  }
  if (g && g.voiceSpeaking && g.voiceSpeaking[currentVoice.channelId]) {
    delete g.voiceSpeaking[currentVoice.channelId][state.currentUserId];
  }
  if (currentVoice.stream) currentVoice.stream.getTracks().forEach(t => t.stop());
  if (currentVoice.audioContext) try { await currentVoice.audioContext.close(); } catch (e) {}
  currentVoice = null;
  $("voiceConnectedBar").classList.add("hidden");
  save(); renderAll();
}
function isUserSpeaking(groupId, channelId, userId) {
  const g = state.groups[groupId];
  if (!g || !g.voiceSpeaking || !g.voiceSpeaking[channelId]) return false;
  const lastTs = g.voiceSpeaking[channelId][userId];
  return lastTs && (now() - lastTs < 1500);
}
$("voiceDisconnectBtn").addEventListener("click", leaveVoiceChannel);

// ---------- PROFILE POPUP ----------
let profilePopupUserId = null;
function showProfilePopup(userId, ev) {
  const u = state.users[userId]; if (!u) return;
  const me = getCurrentUser();
  profilePopupUserId = userId;
  const pop = $("profilePopup");
  // Banner del popup
  const bannerEl = pop.querySelector(".profile-popup-banner");
  if (bannerEl) {
    if (u.banner) {
      bannerEl.style.backgroundImage = `url(${u.banner})`;
      bannerEl.style.background = `url(${u.banner}) center/cover no-repeat`;
    } else {
      bannerEl.style.backgroundImage = "";
      bannerEl.style.background = "var(--accent)";
    }
  }
  $("profilePopupAvatar").src = u.avatar;
  $("profilePopupName").innerHTML = `${esc(u.name)} <span class="profile-online-pill ${isOnline(u) ? 'online' : 'offline'}">${isOnline(u) ? 'in linea' : 'offline'}</span>`;
  $("profilePopupTag").textContent = makeTag(u);
  $("profilePopupBio").textContent = u.bio || "Nessuna bio";

  const mutualGroups = Object.values(state.groups).filter(g => g.members.includes(u.id) && g.members.includes(me.id)).length;
  const mutualFriendIds = new Set(state.friends.filter(p => p.includes(me.id)).map(p => p.find(x => x !== me.id)));
  const otherFriendIds = new Set(state.friends.filter(p => p.includes(u.id)).map(p => p.find(x => x !== u.id)));
  const mutual = [...mutualFriendIds].filter(id => otherFriendIds.has(id)).length;
  $("profilePopupMutual").textContent = `${mutual} amici in comune • ${mutualGroups} gruppi in comune`;

  // Friend toggle button (banner)
  const friendBtn = $("profileFriendToggleBtn");
  const isMe = u.id === me.id;
  const isFriend = state.friends.some(p => p.includes(me.id) && p.includes(u.id));
  const pendingOut = state.friendRequests.some(r => r.status === "pending" && r.fromId === me.id && r.toId === u.id);
  const pendingIn = state.friendRequests.some(r => r.status === "pending" && r.fromId === u.id && r.toId === me.id);
  friendBtn.classList.remove("is-friend", "pending");
  friendBtn.style.display = isMe ? "none" : "";
  if (isMe) {
    // niente
  } else if (isFriend) {
    friendBtn.classList.add("is-friend");
    friendBtn.title = "Amico — clicca per rimuovere";
    friendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.6L4 14l5 5 11-11-1.4-1.4z"/></svg>';
  } else if (pendingOut) {
    friendBtn.classList.add("pending");
    friendBtn.title = "Richiesta inviata";
    friendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
  } else if (pendingIn) {
    friendBtn.classList.add("pending");
    friendBtn.title = "Richiesta in arrivo — clicca per accettare";
    friendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2l-3.5-3.6L4 14l5 5 11-11-1.4-1.4z"/></svg>';
  } else {
    friendBtn.title = "Aggiungi amico";
    friendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
  }

  // Bottoni azione (sotto le info)
  const acts = $("profilePopupActions"); acts.innerHTML = "";
  if (isMe) {
    const b = el("button", "secondary", "Modifica profilo");
    b.addEventListener("click", () => { hideProfilePopup(); $("editProfileBtn").click(); });
    acts.appendChild(b);
  } else {
    const msgBtn = el("button", "", "Invia messaggio");
    msgBtn.addEventListener("click", () => { hideProfilePopup(); openDMWithUser(u.id); });
    acts.appendChild(msgBtn);
  }

  pop.classList.remove("hidden");
  const x = Math.min(ev.clientX + 10, window.innerWidth - 320);
  const y = Math.min(ev.clientY - 20, window.innerHeight - 460);
  pop.style.left = Math.max(8, x) + "px";
  pop.style.top = Math.max(8, y) + "px";
  ev.stopPropagation();
}
function hideProfilePopup() { $("profilePopup").classList.add("hidden"); profilePopupUserId = null; }

// Friend toggle button click
$("profileFriendToggleBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const u = state.users[profilePopupUserId]; if (!u) return;
  const me = getCurrentUser();
  const isFriend = state.friends.some(p => p.includes(me.id) && p.includes(u.id));
  const pendingOut = state.friendRequests.find(r => r.status === "pending" && r.fromId === me.id && r.toId === u.id);
  const pendingIn = state.friendRequests.find(r => r.status === "pending" && r.fromId === u.id && r.toId === me.id);
  if (isFriend) {
    if (confirm(`Rimuovere ${u.name} dagli amici?`)) {
      state.friends = state.friends.filter(p => !(p.includes(me.id) && p.includes(u.id)));
      save(); renderAll(); hideProfilePopup();
    }
  } else if (pendingOut) {
    pendingOut.status = "cancelled";
    save(); renderAll(); hideProfilePopup();
  } else if (pendingIn) {
    acceptFriendRequest(pendingIn.id); hideProfilePopup();
  } else {
    sendFriendRequest(u.id);
    showProfilePopup(u.id, { clientX: parseInt($("profilePopup").style.left) - 10, clientY: parseInt($("profilePopup").style.top) + 20, stopPropagation: () => {} });
  }
});

// 3 puntini -> menu contestuale
$("profileMoreBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const u = state.users[profilePopupUserId]; if (!u) return;
  const me = getCurrentUser();
  const isFriend = state.friends.some(p => p.includes(me.id) && p.includes(u.id));
  const isMe = u.id === me.id;
  const items = [];
  if (!isMe) {
    items.push({ label: "Invia messaggio", onClick: () => { hideProfilePopup(); openDMWithUser(u.id); } });
    // Sottomenu "Invita al server" — mostra i gruppi creati da me
    const myGroups = Object.values(state.groups).filter(g => g.creatorId === me.id && !g.members.includes(u.id));
    if (myGroups.length > 0) {
      items.push({ label: "INVITA AL SERVER", isLabel: true });
      for (const g of myGroups) {
        items.push({
          label: g.name,
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
          onClick: () => {
            g.members.push(u.id);
            pushSystemMessage(g, { action: "add", actorId: me.id, targetId: u.id, text: `${me.name} ha aggiunto ${u.name} al gruppo.` });
            save(); renderAll(); hideContextMenu(); hideProfilePopup();
          }
        });
      }
    }
    items.push({ divider: true });
    if (isFriend) {
      items.push({ label: "Rimuovi amico", danger: true, onClick: () => {
        if (confirm(`Rimuovere ${u.name} dagli amici?`)) {
          state.friends = state.friends.filter(p => !(p.includes(me.id) && p.includes(u.id)));
          save(); renderAll(); hideContextMenu(); hideProfilePopup();
        }
      }});
    }
  }
  items.push({ label: "Copia ID utente", onClick: () => {
    navigator.clipboard?.writeText(u.id);
    hideContextMenu();
  }});
  items.push({ label: "Copia nome utente", onClick: () => {
    navigator.clipboard?.writeText(u.name);
    hideContextMenu();
  }});
  showContextMenu(items, e.clientX, e.clientY);
});

function showContextMenu(items, x, y) {
  const menu = $("contextMenu");
  menu.innerHTML = "";
  const handlers = [];
  for (const it of items) {
    if (it.customHtml) {
      const wrap = document.createElement("div");
      wrap.innerHTML = it.customHtml;
      while (wrap.firstChild) menu.appendChild(wrap.firstChild);
      if (it.handler) handlers.push(it.handler);
      continue;
    }
    if (it.divider) { menu.appendChild(el("div", "menu-divider")); continue; }
    if (it.isLabel) { menu.appendChild(el("div", "submenu-label", it.label)); continue; }
    const item = el("div", "menu-item" + (it.danger ? " danger" : ""));
    item.innerHTML = (it.icon || "") + `<span>${esc(it.label)}</span>`;
    item.addEventListener("click", it.onClick);
    menu.appendChild(item);
  }
  // Esegui handlers dei custom items dopo l'inserimento
  for (const h of handlers) h(menu);
  menu.classList.remove("hidden");
  // Calcola altezza approssimativa
  const w = 240;
  const h = menu.offsetHeight || items.length * 36 + 20;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}
function hideContextMenu() { $("contextMenu").classList.add("hidden"); }

document.addEventListener("click", (e) => {
  const pop = $("profilePopup");
  const menu = $("contextMenu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) hideContextMenu();
  if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !menu.contains(e.target)) hideProfilePopup();
});

// ---------- POLLS ----------
$("pollsBtn")?.addEventListener("click", () => {
  state.currentView = { type: "home", subview: "polls" };
  save(); renderAll();
});

function renderPollsPage() {
  $("messagesList").classList.add("hidden");
  $("inputArea").classList.add("hidden");
  $("recordingBar").classList.add("hidden");
  $("friendsPage").classList.add("hidden");
  $("leaderboardPage").classList.add("hidden");
  $("pollsPage").classList.remove("hidden");
  $("mainHeaderTitle").innerHTML = "📊 Sondaggi";
  $("mainHeaderActions").innerHTML = '<button class="header-action-btn" id="newPollBtn">+ Nuovo sondaggio</button>';
  $("newPollBtn").addEventListener("click", openCreatePollModal);

  const page = $("pollsPage"); page.innerHTML = "";
  const polls = (state.polls || []).slice().reverse();
  if (polls.length === 0) {
    page.innerHTML = '<div class="friends-empty">Nessun sondaggio ancora. Creane uno cliccando "+ Nuovo sondaggio"!</div>';
    return;
  }
  for (const p of polls) page.appendChild(buildPollCard(p));
}

function buildPollCard(p) {
  const card = el("div", "poll-card");
  const totalVotes = p.options.reduce((s, o) => s + (o.voters?.length || 0), 0);
  const me = state.currentUserId;
  const myVote = p.options.findIndex(o => o.voters?.includes(me));
  const creator = state.users[p.creatorId];
  card.innerHTML = `
    <div class="poll-header">
      <img src="${creator?.avatar || defaultAvatar('?')}" />
      <div>
        <div class="poll-author">${esc(creator?.name || '??')}</div>
        <div class="poll-time">${fmtTime(p.ts)}</div>
      </div>
      ${p.creatorId === me ? '<button class="poll-delete-btn" title="Elimina">×</button>' : ''}
    </div>
    <div class="poll-question">${esc(p.question)}</div>
    <div class="poll-options"></div>
    <div class="poll-footer">${totalVotes} ${totalVotes === 1 ? 'voto' : 'voti'} totali</div>`;
  const opts = card.querySelector(".poll-options");
  p.options.forEach((opt, i) => {
    const votes = opt.voters?.length || 0;
    const pct = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
    const row = el("div", "poll-option" + (i === myVote ? " voted mine" : ""));
    row.innerHTML = `
      <div class="bar" style="width:${pct}%"></div>
      <span class="label">${esc(opt.text)}</span>
      <span class="count">${votes} (${pct}%)</span>`;
    row.addEventListener("click", () => votePoll(p.id, i));
    opts.appendChild(row);
  });
  card.querySelector(".poll-delete-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (confirm("Eliminare questo sondaggio?")) {
      state.polls = (state.polls || []).filter(x => x.id !== p.id);
      save(); renderPollsPage();
    }
  });
  return card;
}

function votePoll(pollId, optionIdx) {
  const p = (state.polls || []).find(x => x.id === pollId); if (!p) return;
  const me = state.currentUserId;
  const wasMyVote = p.options[optionIdx].voters?.includes(me);
  // Rimuovi il mio voto da tutte le opzioni
  for (const o of p.options) o.voters = (o.voters || []).filter(v => v !== me);
  // Re-inserisci il voto solo se non era lo stesso (toggle off)
  if (!wasMyVote) p.options[optionIdx].voters.push(me);
  save(); renderPollsPage();
}

let pollOptions = ["", ""];
function openCreatePollModal() {
  $("pollQuestion").value = "";
  pollOptions = ["", ""];
  renderPollOptionInputs();
  openModal("createPollModal");
}
function renderPollOptionInputs() {
  const wrap = $("pollOptionsWrap");
  wrap.innerHTML = "";
  pollOptions.forEach((o, i) => {
    const row = el("div", "poll-option-input");
    row.innerHTML = `<input type="text" placeholder="Opzione ${i + 1}" value="${esc(o)}" maxlength="80" /><button class="poll-opt-remove" title="Rimuovi">×</button>`;
    const inp = row.querySelector("input");
    inp.addEventListener("input", (e) => { pollOptions[i] = e.target.value; });
    row.querySelector(".poll-opt-remove").addEventListener("click", () => {
      if (pollOptions.length <= 2) return;
      pollOptions.splice(i, 1);
      renderPollOptionInputs();
    });
    wrap.appendChild(row);
  });
}
$("addPollOptionBtn")?.addEventListener("click", () => {
  if (pollOptions.length >= 8) return;
  pollOptions.push("");
  renderPollOptionInputs();
});
$("createPollSubmit")?.addEventListener("click", () => {
  const q = $("pollQuestion").value.trim();
  const validOpts = pollOptions.map(s => s.trim()).filter(Boolean);
  if (!q) { alert("Scrivi una domanda."); return; }
  if (validOpts.length < 2) { alert("Servono almeno 2 opzioni."); return; }
  if (!state.polls) state.polls = [];
  state.polls.push({
    id: "poll_" + uid(),
    creatorId: state.currentUserId,
    question: q,
    options: validOpts.map(t => ({ text: t, voters: [] })),
    ts: now()
  });
  save();
  closeModal("createPollModal");
  state.currentView = { type: "home", subview: "polls" };
  renderAll();
});

// Sondaggio inline (creato dal pulsante 📊 nell'input chat)
$("pollBtn")?.addEventListener("click", () => {
  // Crea un sondaggio inline come messaggio nella chat corrente
  const v = state.currentView;
  if (v.type !== "dm" && v.type !== "group") {
    // fallback al modale dei sondaggi globali
    openCreatePollModal();
    return;
  }
  const q = prompt("Domanda del sondaggio:");
  if (!q || !q.trim()) return;
  const optsRaw = prompt("Opzioni separate da virgola (es. Sì, No, Forse):");
  if (!optsRaw) return;
  const opts = optsRaw.split(",").map(s => s.trim()).filter(Boolean);
  if (opts.length < 2) { alert("Servono almeno 2 opzioni."); return; }
  sendMessage("", [], { poll: { question: q.trim(), options: opts.map(t => ({ text: t, voters: [] })) } });
});

function renderInlinePoll(m) {
  const totalVotes = m.poll.options.reduce((s, o) => s + (o.voters?.length || 0), 0);
  const me = state.currentUserId;
  let html = `<div class="inline-poll"><div class="inline-poll-q">📊 ${esc(m.poll.question)}</div>`;
  m.poll.options.forEach((opt, i) => {
    const votes = opt.voters?.length || 0;
    const pct = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
    const voted = opt.voters?.includes(me);
    html += `<div class="inline-poll-option${voted ? ' voted' : ''}" data-idx="${i}">
      <div class="inline-poll-bar" style="width:${pct}%"></div>
      <span>${esc(opt.text)}</span>
      <span class="inline-poll-count">${votes} (${pct}%)</span>
    </div>`;
  });
  html += `<div class="inline-poll-footer">${totalVotes} ${totalVotes === 1 ? 'voto' : 'voti'}</div></div>`;
  return html;
}

function voteInlinePoll(messageId, optIdx) {
  const m = findMessage(messageId);
  if (!m || !m.poll) return;
  const me = state.currentUserId;
  const wasMyVote = m.poll.options[optIdx].voters?.includes(me);
  for (const o of m.poll.options) o.voters = (o.voters || []).filter(v => v !== me);
  if (!wasMyVote) m.poll.options[optIdx].voters.push(me);
  save(); renderChat();
}

// ---------- LEADERBOARD ----------
$("leaderboardBtn")?.addEventListener("click", () => {
  state.currentView = { type: "home", subview: "leaderboard" };
  save(); renderAll();
});

function renderLeaderboardPage() {
  $("messagesList").classList.add("hidden");
  $("inputArea").classList.add("hidden");
  $("recordingBar").classList.add("hidden");
  $("friendsPage").classList.add("hidden");
  $("pollsPage").classList.add("hidden");
  $("leaderboardPage").classList.remove("hidden");
  $("mainHeaderTitle").innerHTML = "🏆 Classifica utenti più attivi";
  $("mainHeaderActions").innerHTML = "";

  // Conta i messaggi di tutti gli utenti (escludendo i system message)
  const counts = {};
  for (const did in state.dms) {
    for (const m of state.dms[did].messages || []) {
      if (m.system) continue;
      counts[m.authorId] = (counts[m.authorId] || 0) + 1;
    }
  }
  for (const gid in state.groups) {
    const g = state.groups[gid];
    if (!g.messages) continue;
    for (const cid in g.messages) {
      for (const m of g.messages[cid]) {
        if (m.system) continue;
        counts[m.authorId] = (counts[m.authorId] || 0) + 1;
      }
    }
  }
  const ranked = Object.keys(counts)
    .map(id => ({ user: state.users[id], count: counts[id] }))
    .filter(x => x.user)
    .sort((a, b) => b.count - a.count);

  const page = $("leaderboardPage"); page.innerHTML = "";
  if (ranked.length === 0) {
    page.innerHTML = '<div class="friends-empty">Nessun messaggio ancora. Inizia a chattare per scalare la classifica!</div>';
    return;
  }
  ranked.forEach((r, i) => {
    const row = el("div", "leaderboard-row" + (i < 3 ? " top-" + (i + 1) : ""));
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    row.innerHTML = `
      <div class="leaderboard-rank">${medal}</div>
      <img class="leaderboard-avatar" src="${r.user.avatar}" />
      <div class="leaderboard-info">
        <div class="leaderboard-name">${esc(r.user.name)}${isOnline(r.user) ? ' <span class="leaderboard-dot online"></span>' : ''}</div>
        <div class="leaderboard-bio">${esc(r.user.bio || '')}</div>
      </div>
      <div class="leaderboard-count">${r.count}<span> msg</span></div>`;
    row.addEventListener("click", (ev) => showProfilePopup(r.user.id, ev));
    page.appendChild(row);
  });
}

// ---------- SELF-DESTRUCT TOGGLE ----------
$("selfDestructBtn")?.addEventListener("click", () => {
  if (selfDestructSeconds > 0) {
    selfDestructSeconds = 0;
    $("selfDestructBar").classList.add("hidden");
    $("selfDestructBtn").classList.remove("active");
  } else {
    selfDestructSeconds = parseInt($("selfDestructDuration").value) || 20;
    $("selfDestructBar").classList.remove("hidden");
    $("selfDestructBtn").classList.add("active");
  }
});
$("selfDestructDuration")?.addEventListener("change", (e) => {
  if (selfDestructSeconds > 0) selfDestructSeconds = parseInt(e.target.value) || 20;
});

// ---------- MOBILE MENU ----------
$("mobileMenuBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.body.classList.toggle("menu-open");
});
// Chiudi il menu mobile cliccando fuori dalle sidebar
document.addEventListener("click", (e) => {
  if (!document.body.classList.contains("menu-open")) return;
  if (e.target.closest(".servers-bar") || e.target.closest(".channels-bar") || e.target.closest("#mobileMenuBtn")) return;
  document.body.classList.remove("menu-open");
});
// Chiudi il menu mobile quando l'utente seleziona qualcosa
document.querySelectorAll(".servers-bar, .channels-bar").forEach(elm => {
  elm.addEventListener("click", (e) => {
    if (window.innerWidth > 768) return;
    if (e.target.closest(".server-icon, .channel-item, .dm-item, .friends-btn")) {
      setTimeout(() => document.body.classList.remove("menu-open"), 100);
    }
  });
});

// ---------- INIT FINALE ----------
renderAll();
