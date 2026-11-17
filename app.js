import { firebaseConfig } from "./firebase-config.js";

// ---- Réglages -------------------------------------------------------------
const FIREBASE_VERSION = "13.4.0";
const MAX_HISTORY = 20;          // nombre de messages renvoyés au modèle
const MAX_Q = 2000, MAX_A = 8000; // doivent rester alignés sur firestore.rules
const DEFAULT_SYSTEM = "Tu es un assistant pédagogique clair et concis. Tu réponds en français.";
const STORE_KEY = "agentdemo.v1";

const PROVIDERS = {
  groq:      { label: "Groq",            format: "openai",    base: "https://api.groq.com/openai/v1", def: "llama-3.3-70b-versatile",
               fallbacks: ["llama-3.1-8b-instant"], help: ["https://console.groq.com/keys", "console.groq.com > API Keys"] },
  openai:    { label: "ChatGPT (OpenAI)", format: "openai",   base: "https://api.openai.com/v1", def: "gpt-4o-mini",
               fallbacks: ["gpt-4.1-mini", "gpt-4o"], help: ["https://platform.openai.com/api-keys", "platform.openai.com > API keys"] },
  anthropic: { label: "Claude (Anthropic)", format: "anthropic", base: "https://api.anthropic.com/v1", def: "claude-haiku-5-5",
               fallbacks: ["claude-haiku-4-5", "claude-3-5-haiku-latest"], help: ["https://console.anthropic.com/settings/keys", "console.anthropic.com > API Keys"] },
  gemini:    { label: "Gemini (Google)", format: "gemini",    base: "https://generativelanguage.googleapis.com/v1beta", def: "gemini-2.0-flash",
               fallbacks: ["gemini-2.5-flash", "gemini-1.5-flash"], help: ["https://aistudio.google.com/apikey", "aistudio.google.com > Get API key"] },
  custom:    { label: "Autre (compatible OpenAI)", format: "openai", base: "", def: "", fallbacks: [], help: null }
};

// ---- Etat -----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = { provider: "groq", key: "", baseUrl: "", model: "", resolved: "", history: [], busy: false, system: DEFAULT_SYSTEM };

// ---- Utilitaires ----------------------------------------------------------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function storage(persistent) { try { return persistent ? localStorage : sessionStorage; } catch { return null; } }
function saveSession(persistent) {
  const data = JSON.stringify({ provider: state.provider, key: state.key, baseUrl: state.baseUrl, model: state.model, system: state.system });
  for (const p of [true, false]) { try { storage(p)?.removeItem(STORE_KEY); } catch {} }
  try { storage(persistent)?.setItem(STORE_KEY, data); } catch {}
}
function loadSession() {
  for (const p of [true, false]) {
    try { const raw = storage(p)?.getItem(STORE_KEY); if (raw) return { ...JSON.parse(raw), persistent: p }; } catch {}
  }
  return null;
}
function forgetSession() { for (const p of [true, false]) { try { storage(p)?.removeItem(STORE_KEY); } catch {} } }

function validBase(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch { return false; }
}
function cleanBase(url) { return url.trim().replace(/\/+$/, ""); }

function httpMessage(status, detail) {
  if (status === 401 || status === 403) return `Clé refusée (${status})`;
  if (status === 404) return "Adresse ou modèle introuvable (404)";
  if (status === 429) return "Trop de requêtes (429)";
  return `Erreur du fournisseur (${status})` + (detail ? ` : ${detail}` : "");
}

async function http(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError(0, "Impossible de joindre le fournisseur (réseau ou CORS : ouvrez la console, F12)"); }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j?.error?.message || j?.message || ""; } catch {}
    const e = new ApiError(res.status, httpMessage(res.status, detail.slice(0, 200)));
    e.detail = detail;
    throw e;
  }
  return res.json();
}

// ---- Appels aux fournisseurs ---------------------------------------------
function baseOf(p) { return state.provider === "custom" ? cleanBase(state.baseUrl) : PROVIDERS[p].base; }

async function callModel(model, messages) {
  const P = PROVIDERS[state.provider], base = baseOf(state.provider);
  if (P.format === "openai") {
    const j = await http(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: state.system }, ...messages] })
    });
    return j?.choices?.[0]?.message?.content ?? "";
  }
  if (P.format === "anthropic") {
    const j = await http(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": state.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model, max_tokens: 1024, system: state.system, messages })
    });
    return (j?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  // gemini
  const j = await http(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": state.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: state.system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }))
    })
  });
  return (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

async function listModels() {
  const P = PROVIDERS[state.provider], base = baseOf(state.provider);
  let names = [];
  if (P.format === "openai") {
    const j = await http(`${base}/models`, { headers: { Authorization: `Bearer ${state.key}` } });
    names = (j.data || []).map((m) => m.id);
    names = names.filter((n) => !/whisper|embed|tts|guard|moderation|dall-e|image|audio|realtime|transcribe|rerank/i.test(n));
  } else if (P.format === "anthropic") {
    const j = await http(`${base}/models`, { headers: { "x-api-key": state.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } });
    names = (j.data || []).map((m) => m.id);
  } else {
    const j = await http(`${base}/models?pageSize=100`, { headers: { "x-goog-api-key": state.key } });
    names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /gemini/i.test(n) && !/embed|tts|image|vision|live|audio|thinking-exp/i.test(n));
  }
  // préférence : petits modèles rapides en premier
  const score = (n) => (/mini|flash|haiku|instant|small|8b/i.test(n) ? 0 : 1) + (/preview|exp|latest/i.test(n) ? 0.5 : 0);
  return names.sort((a, b) => score(a) - score(b));
}

function isModelProblem(e) {
  return e instanceof ApiError && (e.status === 404 || (e.status === 400 && /model/i.test(e.detail || "")));
}

// Modèle saisi : respecté tel quel. Vide : défaut, puis replis, puis découverte via la liste.
async function ask(messages) {
  if (state.model) return callModel(state.model, messages);
  const P = PROVIDERS[state.provider];
  const first = [state.resolved, P.def, ...P.fallbacks].filter(Boolean);
  const tried = new Set();
  let lastErr = null;
  for (const m of first) {
    if (tried.has(m)) continue;
    tried.add(m);
    try { const out = await callModel(m, messages); state.resolved = m; return out; }
    catch (e) { if (!isModelProblem(e)) throw e; lastErr = e; }
  }
  let names = [];
  try { names = await listModels(); } catch (e) { throw lastErr || e; }
  for (const m of names.filter((n) => !tried.has(n)).slice(0, 4)) {
    tried.add(m);
    try { const out = await callModel(m, messages); state.resolved = m; return out; }
    catch (e) { if (!isModelProblem(e)) throw e; lastErr = e; }
  }
  throw lastErr || new ApiError(404, "Aucun modèle utilisable trouvé : renseignez le champ Modèle");
}

// ---- Firestore (facultatif) ----------------------------------------------
const fsConfigured = !/EXEMPLE|votre-projet/i.test(`${firebaseConfig.apiKey} ${firebaseConfig.projectId}`);
let fsPromise = null;
function fsLoad() {
  if (!fsPromise) {
    const root = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    fsPromise = Promise.all([import(`${root}/firebase-app.js`), import(`${root}/firebase-firestore.js`)])
      .then(([app, fs]) => ({ fs, db: fs.getFirestore(app.initializeApp(firebaseConfig)) }));
    fsPromise.catch(() => { fsPromise = null; });
  }
  return fsPromise;
}
async function fsSave(question, answer) {
  const { fs, db } = await fsLoad();
  await fs.addDoc(fs.collection(db, "conversations"), {
    question: question.slice(0, MAX_Q), answer: answer.slice(0, MAX_A), createdAt: fs.serverTimestamp()
  });
}
async function fsRefresh() {
  const ul = $("history");
  try {
    const { fs, db } = await fsLoad();
    const snap = await fs.getDocs(fs.query(fs.collection(db, "conversations"), fs.orderBy("createdAt", "desc"), fs.limit(10)));
    ul.replaceChildren();
    snap.forEach((d) => {
      const x = d.data(), li = document.createElement("li");
      const q = document.createElement("strong"); q.textContent = x.question;
      const a = document.createElement("div"); a.textContent = x.answer;
      li.append(q, a); ul.append(li);
    });
    if (!ul.children.length) { const li = document.createElement("li"); li.textContent = "Aucun échange enregistré pour l'instant."; ul.append(li); }
  } catch (e) {
    ul.replaceChildren(); const li = document.createElement("li");
    li.textContent = `Lecture de Firestore impossible (${e.code || e.message}).`; ul.append(li);
  }
}

// ---- Interface -----------------------------------------------------------
function bubble(role, text, cls = "") {
  const d = document.createElement("div");
  d.className = `msg ${role} ${cls}`.trim();
  d.textContent = text;           // jamais de HTML interprété
  $("chat").append(d); $("chat").scrollTop = $("chat").scrollHeight;
  return d;
}

function updateProviderUI() {
  const p = $("provider").value, P = PROVIDERS[p];
  $("customWrap").classList.toggle("hidden", p !== "custom");
  const help = $("keyHelp"); help.replaceChildren();
  if (P.help) {
    help.append("Où trouver ma clé ? ");
    const a = document.createElement("a"); a.href = P.help[0]; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = P.help[1];
    help.append(a);
  }
}

function showApp() {
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("status").textContent = `Connecté : ${PROVIDERS[state.provider].label}` + (state.model ? ` · ${state.model}` : " · modèle automatique");
  $("system").value = state.system;
  $("saveWrap").classList.toggle("hidden", !fsConfigured);
  $("historyWrap").classList.toggle("hidden", !fsConfigured);
  if (fsConfigured) fsRefresh();
  $("input").focus();
}

function connect() {
  const err = $("loginError"); err.textContent = "";
  const provider = $("provider").value, key = $("apiKey").value.trim(), model = $("model").value.trim();
  if (!key) { err.textContent = "Collez votre clé API."; return; }
  if (/\s/.test(key)) { err.textContent = "La clé ne doit pas contenir d'espace."; return; }
  let baseUrl = "";
  if (provider === "custom") {
    baseUrl = cleanBase($("baseUrl").value);
    if (!validBase(baseUrl)) { err.textContent = "Adresse invalide : https obligatoire (sauf localhost)."; return; }
  }
  Object.assign(state, { provider, key, baseUrl, model, resolved: "", history: [] });
  saveSession($("remember").checked);
  $("apiKey").value = "";
  $("chat").replaceChildren();
  showApp();
}

async function send() {
  const input = $("input"), text = input.value.trim();
  if (!text || state.busy) return;
  state.busy = true; $("send").disabled = true; $("error").textContent = "";
  state.system = $("system").value.trim() || DEFAULT_SYSTEM;
  saveSessionIfAny();
  input.value = "";
  bubble("user", text);
  const wait = bubble("assistant", "…", "pending");
  const messages = [...state.history, { role: "user", content: text }].slice(-MAX_HISTORY);
  try {
    const answer = (await ask(messages)).trim() || "(réponse vide)";
    state.history = [...messages, { role: "assistant", content: answer }].slice(-MAX_HISTORY);
    wait.className = "msg assistant"; wait.textContent = answer;
    if (fsConfigured && $("saveFs").checked) {
      try { await fsSave(text, answer); fsRefresh(); }
      catch (e) { $("error").textContent = `Firestore n'a pas enregistré l'échange (${e.code || e.message}).`; }
    }
  } catch (e) {
    wait.remove();
    $("error").textContent = e.message || String(e);
    input.value = text;           // on rend le message à l'utilisateur
    $("chat").lastElementChild?.classList.contains("user") && $("chat").lastElementChild.remove();
  } finally {
    state.busy = false; $("send").disabled = false; input.focus();
  }
}

function saveSessionIfAny() { const s = loadSession(); if (s) saveSession(s.persistent); }

function forget() {
  forgetSession();
  Object.assign(state, { key: "", history: [], resolved: "" });
  $("chat").replaceChildren(); $("error").textContent = "";
  $("app").classList.add("hidden"); $("login").classList.remove("hidden");
}

// ---- Démarrage -----------------------------------------------------------
for (const [id, P] of Object.entries(PROVIDERS)) {
  const o = document.createElement("option"); o.value = id; o.textContent = P.label; $("provider").append(o);
}
$("provider").addEventListener("change", updateProviderUI);
$("connect").addEventListener("click", connect);
$("send").addEventListener("click", send);
$("forget").addEventListener("click", forget);
$("apiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

const saved = loadSession();
if (saved) {
  Object.assign(state, { provider: saved.provider, key: saved.key, baseUrl: saved.baseUrl || "", model: saved.model || "", system: saved.system || DEFAULT_SYSTEM });
  $("provider").value = saved.provider; $("remember").checked = saved.persistent;
  updateProviderUI();
  if (state.key) showApp();
} else {
  $("provider").value = "groq"; updateProviderUI();
}
