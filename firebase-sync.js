/* =====================================================
   WATERMELONCORD — Firebase sync layer
   Espone l'oggetto globale WMF con tutti i wrapper
   che app.js usa per parlare con Firebase.
===================================================== */

(function () {
  // ----- CONFIG -----
  const firebaseConfig = {
    apiKey: "AIzaSyC4tZaldfRFj18ij1DAswjmLlTazjZVPqE",
    authDomain: "watermeloncord.firebaseapp.com",
    databaseURL: "https://watermeloncord-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "watermeloncord",
    storageBucket: "watermeloncord.firebasestorage.app",
    messagingSenderId: "1091544104182",
    appId: "1:1091544104182:web:cf763cff6d22ed507940d7",
    measurementId: "G-VYF26XR6Q8"
  };

  // ----- INIT -----
  firebase.initializeApp(firebaseConfig);
  const fbAuth = firebase.auth();
  const fbDB = firebase.database();
  const fbStorage = firebase.storage();

  // Persistenza per-tab (ogni tab può avere un account diverso, come il comportamento attuale)
  try { fbAuth.setPersistence(firebase.auth.Auth.Persistence.SESSION); } catch (e) {}

  // ----- USERNAME -> EMAIL (sintetica) -----
  // Firebase Auth richiede un'email. Convertiamo lo username in esadecimale:
  // due username uguali (case insensitive) producono la stessa email, due
  // diversi producono email diverse. Niente collisioni.
  function usernameToEmail(username) {
    const normalized = String(username || "").toLowerCase().trim();
    const bytes = new TextEncoder().encode(normalized);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
    return hex + "@wmc.local";
  }

  // ----- AUTH WRAPPERS -----
  async function signUp(username, password) {
    const email = usernameToEmail(username);
    const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
    return cred.user; // { uid, email, ... }
  }
  async function signIn(username, password) {
    const email = usernameToEmail(username);
    const cred = await fbAuth.signInWithEmailAndPassword(email, password);
    return cred.user;
  }
  async function signOut() {
    return fbAuth.signOut();
  }
  function onAuthChange(callback) {
    return fbAuth.onAuthStateChanged(callback);
  }
  function currentUid() {
    return fbAuth.currentUser ? fbAuth.currentUser.uid : null;
  }

  // ----- RTDB STATE SYNC -----
  // La chiave "state" in RTDB contiene lo stato condiviso:
  // { users, groups, dms, friendRequests, friends, polls }
  // (NON contiene currentUserId, che è per-tab.)
  const STATE_PATH = "state";

  // Subscribe ai cambiamenti sullo stato condiviso. callback(val) viene
  // invocata ogni volta che lo stato cambia sul server (e la prima volta
  // che il listener viene attaccato). val è l'oggetto stato o null se vuoto.
  function subscribeState(callback) {
    const ref = fbDB.ref(STATE_PATH);
    const handler = (snap) => callback(snap.val() || null);
    ref.on("value", handler);
    return () => ref.off("value", handler);
  }

  // Scrive l'INTERO stato condiviso su Firebase (sovrascrive).
  // Usato in modo debounced da app.js per evitare troppe scritture.
  async function writeState(sharedState) {
    // Rimuovi chiavi undefined che Firebase rifiuterebbe
    const cleaned = JSON.parse(JSON.stringify(sharedState || {}));
    return fbDB.ref(STATE_PATH).set(cleaned);
  }

  // Aggiorna solo un sotto-path specifico (es. users/{uid}/lastSeen).
  // Più efficiente di writeState quando vogliamo scrivere un singolo campo.
  async function writePath(subPath, value) {
    return fbDB.ref(STATE_PATH + "/" + subPath).set(value);
  }

  // Rimuove un sotto-path.
  async function removePath(subPath) {
    return fbDB.ref(STATE_PATH + "/" + subPath).remove();
  }

  // Cancella tutto lo stato condiviso (per il pulsante "Resetta dati").
  async function wipeState() {
    return fbDB.ref(STATE_PATH).remove();
  }

  // ----- STORAGE HELPERS -----
  // Carica un File o Blob in Storage e ritorna l'URL pubblico.
  async function uploadFile(path, fileOrBlob) {
    const ref = fbStorage.ref(path);
    const snap = await ref.put(fileOrBlob);
    return await snap.ref.getDownloadURL();
  }

  // Carica un data URL (es. base64 dalle immagini ridimensionate a canvas).
  async function uploadDataURL(path, dataURL) {
    const ref = fbStorage.ref(path);
    const snap = await ref.putString(dataURL, "data_url");
    return await snap.ref.getDownloadURL();
  }

  // Elimina un file in Storage (best-effort, ignora errori).
  async function deleteFile(path) {
    try { await fbStorage.ref(path).delete(); } catch (e) {}
  }

  // Piccolo generatore di ID random (usato per nominare i file in Storage)
  function randId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  // ----- EXPORT GLOBALE -----
  window.WMF = {
    // auth
    signUp, signIn, signOut, onAuthChange, currentUid,
    usernameToEmail,
    // state sync
    subscribeState, writeState, writePath, removePath, wipeState,
    // storage
    uploadFile, uploadDataURL, deleteFile,
    // util
    randId,
    // raw handles (per debug)
    _auth: fbAuth, _db: fbDB, _storage: fbStorage
  };
})();
