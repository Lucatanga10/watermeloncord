/* =====================================================
   WHATSDISCO — Discord clone (frontend only)
   Stato salvato in localStorage
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

// ---------- INDEXEDDB (per allegati grandi: foto/video/audio in chat) ----------
const DB_NAME = "whatsdisco_db";
const DB_STORE = "attachments";
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
}
async function idbPut(key, blob) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(blob, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
const urlCache = {};
async function getAttachmentURL(attId) {
  if (urlCache[attId]) return urlCache[attId];
  const blob = await idbGet(attId);
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  urlCache[attId] = url;
  return url;
}

// ---------- SUONO NOTIFICA ----------
// Genera un "ding" al volo via WebAudio e lo riproduce
function playNotifSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

// ---------- STATO ----------
const STORE_KEY = "whatsdisco_state_v1";
let friendsTab = "all";
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return freshState();
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error("Errore salvataggio:", e);
    alert("Spazio di archiviazione pieno. Prova a usare immagini più piccole per avatar/icone, oppure apri le impostazioni del profilo e clicca 'Resetta dati' se vuoi ripartire da zero.");
  }
}

function freshState() {
  return {
    currentUserId: null,
    users: {},     // tutti gli account creati su questo browser (o in futuro su server)
    groups: {},    // { id, name, icon, creatorId, members: [ids], channels: [{id,name,type}], messages: { channelId: [msgs] }, voiceState: { channelId: [userIds] } }
    dms: {},       // { dmId: { id, participants: [a,b], messages: [] } }
    friendRequests: [], // { id, fromId, toId, status, ts }
    friends: [],   // [ [a,b], ... ]
    currentView: { type: "home", subview: "friends" } // or {type:"dm", id}, {type:"group", groupId, channelId}
  };
}

// Migrazione: rimuovi vecchi utenti "sim" se presenti nel vecchio stato
function migrateState() {
  if (!state.users) return;
  const simIds = Object.values(state.users).filter(u => u.sim).map(u => u.id);
  if (simIds.length === 0) return;
  for (const id of simIds) delete state.users[id];
  state.friendRequests = (state.friendRequests || []).filter(r => !simIds.includes(r.fromId) && !simIds.includes(r.toId));
  state.friends = (state.friends || []).filter(p => !simIds.includes(p[0]) && !simIds.includes(p[1]));
  for (const gid in state.groups) {
    const g = state.groups[gid];
    g.members = g.members.filter(m => !simIds.includes(m));
    if (g.voiceState) {
      for (const ch in g.voiceState) g.voiceState[ch] = g.voiceState[ch].filter(m => !simIds.includes(m));
    }
  }
  for (const did in state.dms) {
    const d = state.dms[did];
    if (d.participants.some(p => simIds.includes(p))) delete state.dms[did];
  }
  save();
}
migrateState();

function getCurrentUser() { return state.users[state.currentUserId]; }

// ---------- LOGIN / MULTI-ACCOUNT ----------
let loginAvatarData = null;

function renderLoginAccounts() {
  const list = $("existingAccountsList");
  const accounts = Object.values(state.users || {});
  list.innerHTML = "";
  if (accounts.length === 0) {
    $("existingAccountsWrap").classList.add("hidden");
    showCreateForm(true);
    return;
  }
  $("existingAccountsWrap").classList.remove("hidden");
  for (const u of accounts) {
    const row = el("div", "login-account");
    row.innerHTML = `
      <img src="${u.avatar}" />
      <div class="info">
        <div class="name">${esc(u.name)}</div>
        <div class="tag">${esc(makeTag(u))}</div>
      </div>
      <button class="delete-account" title="Elimina account">×</button>`;
    row.addEventListener("click", (ev) => {
      if (ev.target.closest(".delete-account")) {
        if (confirm(`Eliminare l'account "${u.name}"? Tutti i suoi messaggi verranno persi.`)) {
          deleteAccount(u.id);
        }
        return;
      }
      state.currentUserId = u.id;
      save();
      showApp();
    });
    list.appendChild(row);
  }
}

function makeTag(u) {
  return u.name.toLowerCase().replace(/[^a-z0-9]/g, "") + "#" + u.id.slice(-4);
}

function deleteAccount(userId) {
  delete state.users[userId];
  state.friendRequests = state.friendRequests.filter(r => r.fromId !== userId && r.toId !== userId);
  state.friends = state.friends.filter(p => !p.includes(userId));
  for (const gid in state.groups) {
    const g = state.groups[gid];
    g.members = g.members.filter(m => m !== userId);
    if (g.members.length === 0) delete state.groups[gid];
    else if (g.creatorId === userId) g.creatorId = g.members[0]; // passa la corona
  }
  for (const did in state.dms) {
    if (state.dms[did].participants.includes(userId)) delete state.dms[did];
  }
  save();
  renderLoginAccounts();
}

function showCreateForm(show) {
  $("createAccountForm").classList.toggle("hidden", !show);
  $("existingAccountsWrap").classList.toggle("hidden", show && Object.keys(state.users).length === 0);
  if (show) {
    $("backToAccountsBtn").classList.toggle("hidden", Object.keys(state.users).length === 0);
    $("loginNameInput").value = "";
    loginAvatarData = null;
    $("loginAvatarPreview").src = defaultAvatar("?");
  }
}

$("showCreateFormBtn").addEventListener("click", () => showCreateForm(true));
$("backToAccountsBtn").addEventListener("click", () => showCreateForm(false));

$("loginAvatarInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  loginAvatarData = await resizeImage(f, 256, 0.85);
  $("loginAvatarPreview").src = loginAvatarData;
});
$("loginNameInput").addEventListener("input", (e) => {
  if (!loginAvatarData) $("loginAvatarPreview").src = defaultAvatar(e.target.value || "?");
});
$("loginSubmit").addEventListener("click", () => {
  const name = $("loginNameInput").value.trim();
  if (!name) { $("loginNameInput").focus(); return; }
  const id = "u_" + uid();
  state.users[id] = {
    id, name,
    avatar: loginAvatarData || defaultAvatar(name),
    bio: ""
  };
  state.currentUserId = id;
  save();
  showApp();
});
$("loginAvatarPreview").src = defaultAvatar("?");

function showApp() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderAll();
}

function showLogin() {
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  renderLoginAccounts();
}

if (state.currentUserId && state.users[state.currentUserId]) {
  showApp();
} else {
  renderLoginAccounts();
}

// ---------- RENDER ----------
function renderAll() {
  renderUserPanel();
  renderServers();
  renderMainView();
}

function renderUserPanel() {
  const u = getCurrentUser(); if (!u) return;
  $("userPanelAvatar").src = u.avatar;
  $("userPanelName").textContent = u.name;
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
    if (v.type === "home" && v.subview === "friends") renderFriendsPage();
    else renderChat();
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
          vm.innerHTML = `<img src="${uu.avatar}" /><span>${esc(uu.name)}</span>`;
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
  for (const mid of g.members) {
    const m = state.users[mid]; if (!m) continue;
    const row = el("div", "member-item");
    row.innerHTML = `<img src="${m.avatar}" /><div class="member-name">${esc(m.name)}${g.creatorId === mid ? '<span class="member-crown">👑</span>' : ''}</div>`;
    row.addEventListener("click", (ev) => showProfilePopup(m.id, ev));
    list.appendChild(row);
  }
}

// ---------- CHAT ----------
function renderChat() {
  $("friendsPage").classList.add("hidden");
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
    const grouped = (author.id === lastAuthor) && (m.ts - lastTs < 5 * 60 * 1000);
    const row = el("div", "message" + (grouped ? " grouped" : ""));
    const isCreatorInGroup = v.type === "group" && state.groups[v.groupId].creatorId === author.id;
    const crownClass = isCreatorInGroup ? " crown" : "";
    let attachHtml = "";
    if (m.attachments) {
      for (let i = 0; i < m.attachments.length; i++) {
        const att = m.attachments[i];
        // Compatibilità: vecchi messaggi hanno att.data (data URL), nuovi hanno att.attachmentId (IDB)
        const srcAttr = att.data ? `src="${att.data}"` : `data-att-id="${att.attachmentId}"`;
        if (att.type.startsWith("image/")) attachHtml += `<div class="message-attachment"><img ${srcAttr} /></div>`;
        else if (att.type.startsWith("video/")) attachHtml += `<div class="message-attachment"><video controls ${srcAttr}></video></div>`;
        else if (att.type.startsWith("audio/")) attachHtml += `<div class="voice-message"><audio controls ${srcAttr}></audio><span class="voice-message-duration">${att.duration || ""}</span></div>`;
      }
    }
    row.innerHTML = `
      <img class="message-avatar" src="${author.avatar}" />
      <div class="message-body">
        <div class="message-header">
          <span class="message-author${crownClass}">${esc(author.name)}</span>
          <span class="message-time">${fmtTime(m.ts)}</span>
        </div>
        <div class="message-content">
          ${m.text ? `<div class="message-text">${esc(m.text)}</div>` : ""}
          ${attachHtml}
        </div>
      </div>`;
    row.querySelector(".message-avatar")?.addEventListener("click", (ev) => showProfilePopup(author.id, ev));
    row.querySelector(".message-author")?.addEventListener("click", (ev) => showProfilePopup(author.id, ev));
    // Carica gli allegati da IndexedDB (asincrono)
    row.querySelectorAll("[data-att-id]").forEach(async (elm) => {
      const url = await getAttachmentURL(elm.dataset.attId);
      if (url) elm.src = url;
    });
    box.appendChild(row);
    lastAuthor = author.id; lastTs = m.ts;
  }
  box.scrollTop = box.scrollHeight;
}

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
  const name = $("addFriendInput").value.trim();
  if (!name) return;
  const u = getCurrentUser();
  const target = Object.values(state.users).find(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== u.id);
  const res = $("addFriendResult");
  if (!target) { res.innerHTML = `<span style="color:var(--danger)">Nessun utente trovato con quel nome.</span>`; return; }
  const ok = sendFriendRequest(target.id);
  res.innerHTML = ok ? `<span style="color:var(--green)">Richiesta inviata a ${esc(target.name)}!</span>` : `<span style="color:var(--gold)">Richiesta già esistente o sei già amico.</span>`;
  $("addFriendInput").value = "";
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

$("addServerBtn").addEventListener("click", () => {
  $("newGroupName").value = "";
  $("newGroupIcon").src = defaultAvatar("?");
  newGroupIconData = null;
  openModal("createGroupModal");
});
let newGroupIconData = null;
$("newGroupIconInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  newGroupIconData = await resizeImage(f, 256, 0.85);
  $("newGroupIcon").src = newGroupIconData;
});
$("createGroupSubmit").addEventListener("click", () => {
  const name = $("newGroupName").value.trim();
  if (!name) return;
  const u = getCurrentUser();
  const id = "g_" + uid();
  const textCh = { id: "ch_" + uid(), name: "generale", type: "text" };
  const voiceCh = { id: "ch_" + uid(), name: "Generale", type: "voice" };
  state.groups[id] = {
    id, name, icon: newGroupIconData,
    creatorId: u.id,
    members: [u.id],
    channels: [textCh, voiceCh],
    messages: { [textCh.id]: [] },
    voiceState: { [voiceCh.id]: [] }
  };
  save();
  closeModal("createGroupModal");
  openGroup(id);
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
$("editProfileBtn").addEventListener("click", () => {
  const u = getCurrentUser();
  $("profileEditAvatar").src = u.avatar;
  $("profileEditName").value = u.name;
  $("profileEditBio").value = u.bio || "";
  profileEditAvatarData = null;
  openModal("profileModal");
});
$("userPanelAvatar").addEventListener("click", () => $("editProfileBtn").click());
$("logoutBtn").addEventListener("click", () => {
  state.currentUserId = null;
  // Lascia leaveVoiceChannel se attivo
  if (currentVoice) leaveVoiceChannel();
  save();
  showLogin();
});
$("profileEditAvatarInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  profileEditAvatarData = await resizeImage(f, 256, 0.85);
  $("profileEditAvatar").src = profileEditAvatarData;
});
$("profileEditSave").addEventListener("click", () => {
  const u = getCurrentUser();
  u.name = $("profileEditName").value.trim() || u.name;
  u.bio = $("profileEditBio").value;
  if (profileEditAvatarData) u.avatar = profileEditAvatarData;
  save();
  closeModal("profileModal");
  renderAll();
});
$("resetDataBtn").addEventListener("click", async () => {
  if (!confirm("Sei sicuro? Cancellerà tutti i tuoi dati (profilo, amici, gruppi, messaggi).")) return;
  try {
    localStorage.removeItem(STORE_KEY);
    // Svuota anche IndexedDB
    const db = await openDB();
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
  } catch (e) {}
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
function sendMessage(text, attachments = []) {
  const u = getCurrentUser();
  const v = state.currentView;
  const msg = { id: "m_" + uid(), authorId: u.id, ts: now(), text, attachments };
  if (v.type === "dm") {
    state.dms[v.id].messages.push(msg);
  } else if (v.type === "group") {
    const g = state.groups[v.groupId];
    if (!g.messages) g.messages = {};
    if (!g.messages[v.channelId]) g.messages[v.channelId] = [];
    g.messages[v.channelId].push(msg);
  }
  save(); renderChat();
}

$("messageInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    sendMessage(text, []);
    e.target.value = "";
  }
});

// Allegati foto/video (salvati in IndexedDB per non saturare localStorage)
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files); if (!files.length) return;
  const attachments = [];
  for (const f of files) {
    const attachmentId = "att_" + uid();
    try {
      await idbPut(attachmentId, f);
      attachments.push({ type: f.type, attachmentId, name: f.name });
    } catch (err) {
      alert("Errore salvataggio allegato: " + err.message);
    }
  }
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
      const attachmentId = "att_" + uid();
      try { await idbPut(attachmentId, blob); } catch (err) { alert("Errore salvataggio audio: " + err.message); return; }
      const secs = Math.floor((now() - recordStartTime) / 1000);
      const dur = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
      sendMessage("", [{ type: "audio/webm", attachmentId, duration: dur }]);
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
let currentVoice = null; // { groupId, channelId, stream }
async function joinVoiceChannel(groupId, channelId) {
  await leaveVoiceChannel();
  const g = state.groups[groupId];
  if (!g.voiceState) g.voiceState = {};
  if (!g.voiceState[channelId]) g.voiceState[channelId] = [];
  if (!g.voiceState[channelId].includes(state.currentUserId)) g.voiceState[channelId].push(state.currentUserId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    currentVoice = { groupId, channelId, stream };
  } catch (e) {
    currentVoice = { groupId, channelId, stream: null };
  }
  const ch = g.channels.find(c => c.id === channelId);
  $("voiceConnectedName").textContent = `${g.name} / ${ch.name}`;
  $("voiceConnectedBar").classList.remove("hidden");
  save(); renderAll();
}
async function leaveVoiceChannel() {
  if (!currentVoice) return;
  const g = state.groups[currentVoice.groupId];
  if (g && g.voiceState && g.voiceState[currentVoice.channelId]) {
    g.voiceState[currentVoice.channelId] = g.voiceState[currentVoice.channelId].filter(x => x !== state.currentUserId);
  }
  if (currentVoice.stream) currentVoice.stream.getTracks().forEach(t => t.stop());
  currentVoice = null;
  $("voiceConnectedBar").classList.add("hidden");
  save(); renderAll();
}
$("voiceDisconnectBtn").addEventListener("click", leaveVoiceChannel);

// ---------- PROFILE POPUP ----------
let profilePopupUserId = null;
function showProfilePopup(userId, ev) {
  const u = state.users[userId]; if (!u) return;
  const me = getCurrentUser();
  profilePopupUserId = userId;
  const pop = $("profilePopup");
  $("profilePopupAvatar").src = u.avatar;
  $("profilePopupName").textContent = u.name;
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
  for (const it of items) {
    if (it.divider) { menu.appendChild(el("div", "menu-divider")); continue; }
    if (it.isLabel) { menu.appendChild(el("div", "submenu-label", it.label)); continue; }
    const item = el("div", "menu-item" + (it.danger ? " danger" : ""));
    item.innerHTML = (it.icon || "") + `<span>${esc(it.label)}</span>`;
    item.addEventListener("click", it.onClick);
    menu.appendChild(item);
  }
  menu.classList.remove("hidden");
  const w = 220, h = items.length * 36 + 20;
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

// ---------- INIT FINALE ----------
renderAll();
