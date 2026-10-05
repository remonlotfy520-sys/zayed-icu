// نظام الرعاية المركزة: المرحلة 1
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp, addDoc, deleteDoc,
  orderBy, limit, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, USER_EMAIL_DOMAIN } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// تطبيق ثانوي لإنشاء حسابات المستخدمين بدون ما الأدمن يخرج من حسابه
let _secondaryAuth = null;
function secondaryAuth() {
  if (!_secondaryAuth) _secondaryAuth = getAuth(initializeApp(firebaseConfig, "secondary"));
  return _secondaryAuth;
}

const DEFAULT_UNITS = [
  { id: "icu1",   name: "الرعاية الأولى",  beds: 14, bedLabel: "سرير",  newborn: false },
  { id: "icu3",   name: "الرعاية الثالثة", beds: 14, bedLabel: "سرير",  newborn: false },
  { id: "burns",  name: "رعاية الحروق",    beds: 6,  bedLabel: "سرير",  newborn: false },
  { id: "peds",   name: "رعاية الأطفال",   beds: 4,  bedLabel: "سرير",  newborn: false },
  { id: "nicu",   name: "المبتسرين",       beds: 12, bedLabel: "حضانة", newborn: true  },
  { id: "stroke", name: "رعاية السكتة",    beds: 6,  bedLabel: "سرير",  newborn: false },
];

const DEFAULT_FINANCE = ["نفقة", "تأمين", "مجاني", "اقتصادي", "خاص"];
const listOf = (key) => key.split(".").reduce((o, k) => o?.[k], S.settings) ?? (key === "financeTypes" ? DEFAULT_FINANCE : []);

const S = {
  settings: undefined,   // undefined = لسه بيحمل، null = أول تشغيل
  user: null,
  profile: null,
  adm: {},               // unitId -> [active admissions]
  admUnsubs: [],
  admKey: "",
  pageUnsubs: [],
  page: "",
  unitFilter: null,
  settingUp: false,
  loginMsg: "",
};

const root = document.getElementById("app");
const dlg = document.getElementById("dlg");
const dlgBody = document.getElementById("dlgBody");

/* =========================================================
   أدوات مساعدة
   ========================================================= */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LOCALE = "ar-EG-u-nu-latn";
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const fmtDate = (d) => (d ? new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "2-digit", day: "2-digit" }).format(toDate(d)) : "");
const fmtDateTime = (d) => (d ? new Intl.DateTimeFormat(LOCALE, {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit"
}).format(toDate(d)) : "");
const genderText = (g) => (g === "male" ? "ذكر" : g === "female" ? "أنثى" : "");
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (d) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// اليوم رقم كام في الإقامة (يوم الدخول = اليوم 1)
function dayOfStay(admitAt) {
  const a = toDate(admitAt);
  if (!a) return 0;
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const t = new Date();
  const t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((t0 - a0) / 86400000) + 1;
}

function ageText(birthDate, estimated) {
  if (!birthDate) return "";
  const b = new Date(birthDate + "T00:00:00");
  const now = new Date();
  let years = now.getFullYear() - b.getFullYear();
  let months = now.getMonth() - b.getMonth();
  if (now.getDate() < b.getDate()) months--;
  if (months < 0) { years--; months += 12; }
  let txt;
  if (years >= 1) txt = `${years} سنة`;
  else if (months >= 1) txt = `${months} شهر`;
  else {
    const days = Math.max(0, Math.floor((now - b) / 86400000));
    txt = days === 0 ? "مولود اليوم" : `${days} يوم`;
  }
  return estimated ? `حوالي ${txt}` : txt;
}

// الرقم القومي المصري: [قرن][YYMMDD][محافظة 2][مسلسل 4][تحقق]، الرقم 13 فردي = ذكر
function parseNid(nid) {
  if (!/^[23]\d{13}$/.test(nid)) return null;
  const year = (nid[0] === "2" ? 1900 : 2000) + Number(nid.slice(1, 3));
  const month = Number(nid.slice(3, 5));
  const day = Number(nid.slice(5, 7));
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day || d > new Date()) return null;
  return { birthDate: isoDay(d), gender: Number(nid[12]) % 2 === 1 ? "male" : "female" };
}

// الشيفتات: 9 صباحاً إلى 9 مساءً، و9 مساءً إلى 9 صباحاً
function shiftStart(date = new Date()) {
  const s = new Date(date);
  s.setMinutes(0, 0, 0);
  const h = s.getHours();
  if (h >= 9 && h < 21) s.setHours(9);
  else if (h >= 21) s.setHours(21);
  else { s.setDate(s.getDate() - 1); s.setHours(21); }
  return s;
}
// أقدم وقت مسموح لليوزر يسجل أو يعدل فيه (الأدمن مفتوح)
function earliestEditable() {
  if (isAdmin()) return null;
  const s = shiftStart();
  return S.profile?.editWindowHours === 24 ? new Date(s.getTime() - 12 * 3600e3) : s;
}

function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), 3200);
}

function errText(e) {
  const code = e?.code || e?.message || "";
  const map = {
    "permission-denied": "ليس لديك صلاحية لتنفيذ هذا الإجراء.",
    "auth/invalid-credential": "اسم المستخدم أو كلمة المرور غير صحيحة.",
    "auth/wrong-password": "كلمة المرور غير صحيحة.",
    "auth/user-not-found": "اسم المستخدم غير موجود.",
    "auth/too-many-requests": "محاولات كثيرة. انتظر دقائق وحاول مرة أخرى.",
    "auth/email-already-in-use": "اسم المستخدم مستخدم بالفعل، اختر اسماً آخر.",
    "auth/weak-password": "كلمة المرور لازم تكون 6 حروف أو أرقام على الأقل.",
    "auth/network-request-failed": "لا يوجد اتصال بالإنترنت.",
    "unavailable": "لا يوجد اتصال بالخادم. تأكد من الإنترنت.",
    BED_TAKEN: "السرير ده اتشغل حالاً من مستخدم آخر. اختر سريراً فارغاً.",
    ALREADY_OUT: "الحالة دي خرجت بالفعل.",
    PATIENT_ADMITTED: "المريض ده مسجل دخول حالياً (رعاية أو داخلي)، ولازم يخرج الأول.",
  };
  for (const k in map) if (code.includes(k)) return map[k];
  console.error(e);
  return "حصل خطأ غير متوقع: " + (e?.message || code);
}

const isAdmin = () => S.profile?.role === "admin";
const units = () => S.settings?.units || [];
const unitById = (id) => units().find((u) => u.id === id);
// صلاحيات الأقسام: لكل قسم none / read / write (الرعاية كمان مقيدة بالوحدات)
const lvl = (sec) => (isAdmin() ? "write" : S.profile?.sections?.[sec] ?? (sec === "icu" ? S.profile?.access || "none" : "none"));
const canSee = (sec) => ["read", "write", "nurse"].includes(lvl(sec));
const canEdit = (sec) => lvl(sec) === "write";
const canEditAny = () => ["icu", "ward", "ops"].some(canEdit);
const canPrint = () => isAdmin() || !!S.profile?.print;
function visibleUnits() {
  if (isAdmin()) return units();
  if (!canSee("icu")) return [];
  const mine = S.profile?.units || [];
  return units().filter((u) => mine.includes(u.id));
}
const canWriteUnit = (unitId) =>
  isAdmin() || (canEdit("icu") && (S.profile?.units || []).includes(unitId));

function openDialog(html) {
  dlgBody.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dlgBody.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => dlg.close()));
}
const closeDialog = () => dlg.open && dlg.close();

function checksHtml(name, options, selected = []) {
  if (!options.length) return `<p class="hint">القائمة فاضية. الأدمن يضيفها من الإعدادات.</p>`;
  return `<div class="checks">${options.map((o) =>
    `<label><input type="checkbox" name="${name}" value="${esc(o)}" ${selected.includes(o) ? "checked" : ""}> ${esc(o)}</label>`
  ).join("")}</div>`;
}
function optionsHtml(options, selected, placeholder = "اختر…") {
  const list = [...options];
  if (selected && !list.includes(selected)) list.unshift(selected);
  return `<option value="">${placeholder}</option>` + list.map((o) =>
    `<option ${o === selected ? "selected" : ""}>${esc(o)}</option>`).join("");
}
const checkedValues = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

/* =========================================================
   التشغيل والاشتراكات
   ========================================================= */
onSnapshot(doc(db, "config", "settings"), (snap) => {
  S.settings = snap.exists() ? snap.data() : null;
  document.title = (S.settings?.hospitalName ? S.settings.hospitalName + " | " : "") + "الرعاية المركزة";
  if (S.profile) subscribeAdmissions();
  route();
}, (e) => {
  root.innerHTML = `<div class="boot">تعذر الاتصال بقاعدة البيانات. تأكد من إعدادات Firebase.<br><small>${esc(e.message)}</small></div>`;
});

let profileUnsub = null;
onAuthStateChanged(auth, (user) => {
  if (S.settingUp) return;
  S.user = user;
  S.profile = null;
  profileUnsub?.();
  stopAdmissions();
  subscribeSections();
  subscribeConsults();
  if (!user) { route(); return; }
  route();
  profileUnsub = onSnapshot(doc(db, "users", user.uid), async (snap) => {
    if (!snap.exists() || snap.data().active !== true) {
      S.loginMsg = "الحساب ده غير مفعّل. كلّم الأدمن.";
      await signOut(auth);
      return;
    }
    S.profile = { uid: user.uid, ...snap.data() };
    applyDeptDoctor();
    subscribeAdmissions();
    subscribeSections();
    subscribeConsults();
    route();
  }, async () => {
    S.loginMsg = "الحساب ده غير مفعّل. كلّم الأدمن.";
    await signOut(auth);
  });
});

function stopAdmissions() {
  S.admUnsubs.forEach((u) => u());
  S.admUnsubs = [];
  S.admKey = "";
  S.adm = {};
}
function subscribeAdmissions() {
  const list = visibleUnits();
  const key = list.map((u) => u.id).join(",");
  if (key === S.admKey) return;
  stopAdmissions();
  S.admKey = key;
  for (const u of list) {
    S.adm[u.id] = null;
    const q = query(collection(db, "admissions"), where("unitId", "==", u.id), where("status", "==", "active"));
    S.admUnsubs.push(onSnapshot(q, (snap) => {
      S.adm[u.id] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      liveRefresh();
    }, (e) => console.error("admissions", u.id, e)));
  }
}

// تحديث عداد الأيام كل 5 دقائق
setInterval(() => liveRefresh(), 5 * 60e3);

/* =========================================================
   التنقل
   ========================================================= */
window.addEventListener("hashchange", route);

function cleanupPage() {
  S.pageUnsubs.forEach((u) => u());
  S.pageUnsubs = [];
}

function route() {
  if (S.settings === undefined) { root.innerHTML = `<div class="boot">جاري التحميل…</div>`; return; }
  if (S.settings === null) { S.page = "setup"; renderSetup(); return; }
  if (!S.user) { S.page = "login"; renderLogin(); return; }
  if (!S.profile) { root.innerHTML = `<div class="boot">جاري التحميل…</div>`; return; }

  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const page = parts[0] || "";
  if (isDept() && !["", "home", "dept", "patient", "w", "consults"].includes(page)) { location.hash = "#/"; return; }
  const newKey = location.hash;
  // لو نفس الصفحة ومفيش غير تحديث بيانات، متعيدش فتح المستمعين
  if (S._lastHash === newKey && S.page && S.page !== "login" && S.page !== "setup") {
    liveRefresh();
    return;
  }
  S._lastHash = newKey;
  cleanupPage();

  if ((page === "" || page === "home") && isDept()) {
    S.page = "dept"; renderDeptHome();
  } else if (page === "dept" && (isAdmin() || isDept())) {
    S.page = "dept"; renderDeptHome(isDept() ? "" : parts[1] ? decodeURIComponent(parts[1]) : "");
  } else if (page === "" || page === "home") {
    S.page = "home"; renderHome();
  } else if (page === "patients") {
    S.page = "patients"; renderPatients();
  } else if (page === "p" && parts[1]) {
    S.page = "hub"; renderPatientHub(parts[1]);
  } else if (page === "ward" && canSee("ward")) {
    S.page = "ward"; S.wardFilter = parts[1] || null; renderWard(S.wardFilter);
  } else if (page === "w" && parts[1]) {
    S.page = "wadm"; renderWardAdmission(parts[1]);
  } else if (page === "reports" && canSee("reports")) {
    S.page = "reports";
    if (parts[1] === "discharge") renderDischargeReports(); else renderReports();
  } else if (page === "ds" && parts[1]) {
    S.page = "ds"; renderDischargeReport(parts[1]);
  } else if (page === "r" && parts[1] && canSee("reports")) {
    S.page = "report"; renderReport(parts[1]);
  } else if (page === "consults") {
    S.page = "consults"; renderConsults(parts[1] === "mine" && !isDept() ? "mine" : "in");
  } else if (page === "handover" && (canSee("icu") || canSee("ward"))) {
    S.page = "handover"; renderHandover(parts[1] ? decodeURIComponent(parts[1]) : "");
  } else if (page === "board" && (canSee("icu") || canSee("ward"))) {
    S.page = "board"; renderBoard();
  } else if (page === "ops" && canSee("ops")) {
    S.page = "ops"; renderOps();
  } else if (page === "o" && parts[1] && canSee("ops")) {
    S.page = "op"; renderOperation(parts[1]);
  } else if ((page === "icu" || page === "unit") && canSee("icu")) {
    S.page = "dashboard";
    S.unitFilter = page === "unit" ? parts[1] : null;
    renderDashboard();
  } else if (page === "patient" && parts[1]) {
    S.page = "patient";
    renderPatient(parts[1]);
  } else if (page === "stats" && isAdmin()) {
    S.page = "stats";
    renderStats();
  } else if (page === "archive" && isAdmin()) {
    S.page = "archive";
    if (parts[1] === "ward") renderWardArchive();
    else if (parts[1] === "ops") renderOpsArchive();
    else renderArchive();
  } else if (page === "settings" && isAdmin()) {
    S.page = "settings";
    renderSettings(parts[1] || "users");
  } else {
    location.hash = "#/";
  }
}

function shell(inner) {
  const s = S.settings, p = S.profile;
  root.innerHTML = `
  <header class="topbar">
    <a class="brand" href="#/">
      ${s.logo ? `<img src="${s.logo}" alt="">` : ""}
      <span><strong>${esc(s.hospitalName)}</strong><small>نظام المستشفى</small></span>
    </a>
    <nav class="nav">
      <a href="#/" class="${["home", "dept"].includes(S.page) && !(isAdmin() && S.page === "dept") ? "on" : ""}">الرئيسية</a>
      ${isDept() ? "" : `<a href="#/patients" class="${["patients", "hub"].includes(S.page) ? "on" : ""}">المرضى</a>`}
      ${canSee("icu") ? `<a href="#/icu" class="${["dashboard", "patient"].includes(S.page) ? "on" : ""}">الرعاية</a>` : ""}
      ${canSee("ward") ? `<a href="#/ward" class="${["ward", "wadm"].includes(S.page) ? "on" : ""}">الداخلي</a>` : ""}
      ${canSee("ops") ? `<a href="#/ops" class="${["ops", "op"].includes(S.page) ? "on" : ""}">العمليات</a>` : ""}
      ${canSee("reports") ? `<a href="#/reports" class="${["reports", "report"].includes(S.page) ? "on" : ""}">التقارير الطبية</a>` : ""}
      ${isAdmin() ? `<a href="#/dept" class="${S.page === "dept" ? "on" : ""}">الأقسام</a>` : ""}
      ${canSee("icu") || canSee("ward") ? `<a href="#/handover" class="${S.page === "handover" ? "on" : ""}">تسليم الشيفت</a>` : ""}
      ${isAdmin() || mySpecs().length || canEditAny() ? `<a href="#/consults" class="${S.page === "consults" ? "on" : ""}">الاستشارات${(S.consultIn || []).length ? ` <b class="nb">${S.consultIn.length}</b>` : ""}</a>` : ""}
      ${isAdmin() ? `<a href="#/archive" class="${S.page === "archive" ? "on" : ""}">الأرشيف</a>
      <a href="#/stats" class="${S.page === "stats" ? "on" : ""}">الإحصائيات</a>
      <a href="#/settings" class="${S.page === "settings" ? "on" : ""}">الإعدادات</a>` : ""}
    </nav>
    <div class="me">
      <button class="btn ghost sm ${installPrompt ? "" : "hidden"}" id="installBtn">تثبيت التطبيق</button>
      ${bellHtml()}
      <span>${esc(p.displayName)}</span>
      <button class="btn ghost sm" data-act="pw">كلمة المرور</button>
      <button class="btn ghost sm" data-act="logout">خروج</button>
    </div>
  </header>
  <main class="page">${inner}</main>`;
  root.querySelector('[data-act="logout"]').onclick = () => { S._lastHash = null; signOut(auth); };
  root.querySelector('[data-act="pw"]').onclick = openPasswordDialog;
  document.getElementById("installBtn").onclick = installApp;
  bindBell();
}

/* =========================================================
   أول تشغيل: إنشاء حساب الأدمن
   ========================================================= */
function renderSetup() {
  root.innerHTML = `
  <div class="auth"><div class="auth-card">
    <h1>تجهيز النظام لأول مرة</h1>
    <p class="sub">أنشئ حساب الأدمن. الحساب ده هو اللي هيضيف باقي المستخدمين.</p>
    <form class="form" id="setupForm">
      <label class="field"><span>اسم المستشفى</span><input name="hospital" required value="مستشفى الشيخ زايد آل نهيان"></label>
      <label class="field"><span>اسمك (يظهر في النظام)</span><input name="displayName" required placeholder="د. …"></label>
      <label class="field"><span>اسم المستخدم (إنجليزي)</span><input name="username" required class="ltr" autocomplete="username" placeholder="admin"></label>
      <label class="field"><span>كلمة المرور</span><input name="password" type="password" required minlength="6" autocomplete="new-password"></label>
      <div class="err" id="setupErr"></div>
      <button class="btn">إنشاء حساب الأدمن</button>
    </form>
  </div></div>`;
  const f = document.getElementById("setupForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("setupErr");
    err.textContent = "";
    const username = f.username.value.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) { err.textContent = "اسم المستخدم لازم يكون حروف إنجليزي وأرقام فقط (3 حروف على الأقل)."; return; }
    const btn = f.querySelector("button"); btn.disabled = true;
    S.settingUp = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, `${username}@${USER_EMAIL_DOMAIN}`, f.password.value);
      const uid = cred.user.uid;
      const b = writeBatch(db);
      b.set(doc(db, "config", "settings"), {
        hospitalName: f.hospital.value.trim(),
        logo: "",
        units: DEFAULT_UNITS,
        consultants: [],
        specialties: [],
        adminUid: uid,
        createdAt: serverTimestamp(),
      });
      b.set(doc(db, "users", uid), {
        username, displayName: f.displayName.value.trim(), role: "admin", access: "write",
        units: [], editWindowHours: 24, active: true, createdAt: serverTimestamp(),
      });
      await b.commit();
      S.settingUp = false;
      // تشغيل مسار تسجيل الدخول العادي
      S.user = null;
      await signOut(auth);
      await signInWithEmailAndPassword(auth, `${username}@${USER_EMAIL_DOMAIN}`, f.password.value);
    } catch (e) {
      S.settingUp = false;
      err.textContent = errText(e);
      btn.disabled = false;
    }
  };
}

/* =========================================================
   تسجيل الدخول
   ========================================================= */
function renderLogin() {
  const s = S.settings;
  root.innerHTML = `
  <div class="auth"><div class="auth-card">
    ${s.logo ? `<img class="logo" src="${s.logo}" alt="">` : ""}
    <h1>${esc(s.hospitalName)}</h1>
    <p class="sub">نظام الرعاية المركزة</p>
    <form class="form" id="loginForm">
      <label class="field"><span>اسم المستخدم</span><input name="username" required class="ltr" autocomplete="username" autofocus></label>
      <label class="field"><span>كلمة المرور</span><input name="password" type="password" required autocomplete="current-password"></label>
      <div class="err" id="loginErr">${esc(S.loginMsg)}</div>
      <button class="btn">دخول</button>
    </form>
  </div></div>`;
  S.loginMsg = "";
  const f = document.getElementById("loginForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("loginErr");
    err.textContent = "";
    const btn = f.querySelector("button"); btn.disabled = true;
    try {
      S._lastHash = null;
      await signInWithEmailAndPassword(auth, `${f.username.value.trim().toLowerCase()}@${USER_EMAIL_DOMAIN}`, f.password.value);
    } catch (e) {
      err.textContent = errText(e);
      btn.disabled = false;
    }
  };
}

function openPasswordDialog() {
  openDialog(`
  <form class="form" id="pwForm">
    <header class="dlg-head"><h3>تغيير كلمة المرور</h3></header>
    <label class="field"><span>كلمة المرور الحالية</span><input name="cur" type="password" required autocomplete="current-password"></label>
    <label class="field"><span>كلمة المرور الجديدة</span><input name="n1" type="password" required minlength="6" autocomplete="new-password"></label>
    <label class="field"><span>تأكيد كلمة المرور الجديدة</span><input name="n2" type="password" required minlength="6" autocomplete="new-password"></label>
    <div class="err" id="pwErr"></div>
    <div class="actions"><button class="btn">حفظ كلمة المرور</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("pwForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("pwErr");
    if (f.n1.value !== f.n2.value) { err.textContent = "كلمتا المرور الجديدتان غير متطابقتين."; return; }
    try {
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, f.cur.value));
      await updatePassword(auth.currentUser, f.n1.value);
      closeDialog(); toast("تم حفظ كلمة المرور");
    } catch (e) { err.textContent = errText(e); }
  };
}

/* =========================================================
   الصفحة الرئيسية: خريطة الأسرّة
   ========================================================= */
function renderDashboard() {
  const list = visibleUnits();
  if (!list.length) {
    shell(`<div class="empty">لم يتم تحديد أي وحدة لحسابك بعد. كلّم الأدمن يضيف لك الوحدات اللي هتشتغل عليها.</div>`);
    return;
  }
  const sel = S.unitFilter;
  const shown = sel ? list.filter((u) => u.id === sel) : list;
  if (sel && !shown.length) { location.hash = "#/icu"; return; }

  const stat = (u) => {
    const occ = (S.adm[u.id] || []).length;
    return { occ, free: Math.max(0, u.beds - occ), total: u.beds };
  };
  let tOcc = 0, tBeds = 0;
  list.forEach((u) => { const s = stat(u); tOcc += s.occ; tBeds += s.total; });

  const chips = `
    <nav class="unit-bar" aria-label="الوحدات">
      <a href="#/icu" class="chip ${!sel ? "on" : ""}">كل الوحدات <b>${tOcc}/${tBeds}</b></a>
      ${list.map((u) => { const s = stat(u); return `<a href="#/unit/${u.id}" class="chip ${sel === u.id ? "on" : ""}">${esc(u.name)} <b>${s.occ}/${s.total}</b></a>`; }).join("")}
    </nav>`;

  const sections = shown.map((u) => {
    const s = stat(u);
    const loading = S.adm[u.id] == null;
    const byBed = {};
    (S.adm[u.id] || []).forEach((a) => (byBed[a.bed] = a));
    const canW = canWriteUnit(u.id);
    let tiles = "";
    for (let n = 1; n <= u.beds; n++) {
      const a = byBed[n];
      if (a) {
        const meta = [ageText(a.birthDate, a.birthDateEstimated), genderText(a.gender)].filter(Boolean).join("، ");
        tiles += `
        <a class="bed occ" href="#/patient/${a.id}">
          <span class="bed-no">${esc(u.bedLabel)} ${n}</span>
          <span class="bed-day"><b>${dayOfStay(a.admitAt)}</b><small>يوم</small></span>
          ${a.clinical?.resp === "vent" ? `<span class="bed-flag">فنت</span>` : ""}
          <span class="bed-name">${esc(a.patientName)}</span>
          <span class="bed-meta">${esc(meta)}</span>
          ${a.consultant ? `<span class="bed-meta">${esc(a.consultant)}</span>` : ""}
        </a>`;
      } else if (canW && !loading) {
        tiles += `<button class="bed free" data-bed="${n}" data-unit="${u.id}">
          <span class="bed-no">${esc(u.bedLabel)} ${n}</span><span class="bed-state">فارغ، سجّل دخول حالة</span></button>`;
      } else {
        tiles += `<div class="bed free"><span class="bed-no">${esc(u.bedLabel)} ${n}</span><span class="bed-state">${loading ? "…" : "فارغ"}</span></div>`;
      }
    }
    const pct = s.total ? Math.round((s.occ / s.total) * 100) : 0;
    return `
    <section class="unit">
      <header class="unit-head">
        <h2><a href="#/unit/${u.id}">${esc(u.name)}</a></h2>
        <div class="unit-stats">
          <span><b>${s.occ}</b> مشغول</span>
          <span class="s-free"><b>${s.free}</b> فارغ</span>
          <span>من <b>${s.total}</b></span>
        </div>
        <div class="meter" role="img" aria-label="نسبة الإشغال ${pct}%"><i style="width:${pct}%"></i></div>
      </header>
      <div class="beds">${tiles}</div>
    </section>`;
  }).join("");

  shell(chips + sections);
  root.querySelectorAll("button.bed.free").forEach((b) =>
    (b.onclick = () => openAdmissionDialog(unitById(b.dataset.unit), Number(b.dataset.bed))));
}

/* =========================================================
   دخول حالة جديدة
   ========================================================= */
function openAdmissionDialog(unit, bed, preset) {
  const s = S.settings;
  const earliest = earliestEditable();
  const now = new Date();
  const mode0 = preset ? "preset" : unit.newborn ? "newborn" : "nid";
  openDialog(`
  <form class="form" id="admForm" data-mode="${mode0}" novalidate>
    <header class="dlg-head"><h3>دخول حالة</h3><p>${esc(unit.name)}، ${esc(unit.bedLabel)} ${bed}</p></header>

    ${preset ? `<div class="info">المريض: <strong>${esc(preset.name)}</strong> ${esc(preset.medicalId || "")}${preset.nationalId ? `، ${esc(preset.nationalId)}` : ""}</div>` : `<fieldset class="seg">
      <label><input type="radio" name="mode" value="nid" ${mode0 === "nid" ? "checked" : ""}> رقم قومي</label>
      <label><input type="radio" name="mode" value="newborn" ${mode0 === "newborn" ? "checked" : ""}> مولود (بيانات الأم)</label>
      <label><input type="radio" name="mode" value="unknown"> بدون رقم قومي</label>
    </fieldset>`}

    <label class="field mf m-nid"><span>الرقم القومي</span>
      <input name="nid" inputmode="numeric" maxlength="14" class="ltr" placeholder="14 رقم" autocomplete="off"></label>
    <div class="info mf m-nid" id="nidInfo"></div>

    <label class="field mf m-newborn"><span>اسم الأم</span><input name="motherName"></label>
    <label class="field mf m-newborn"><span>الرقم القومي للأم</span>
      <input name="motherNid" inputmode="numeric" maxlength="14" class="ltr" placeholder="14 رقم" autocomplete="off"></label>
    <div class="field mf m-newborn" id="babyPickWrap"></div>
    <div class="row2 mf m-newborn">
      <label class="field"><span>نوع المولود</span>
        <select name="babyGender"><option value="">اختر…</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
      <label class="field"><span>تاريخ الولادة</span><input name="babyBirth" type="date" max="${isoDay(now)}"></label>
    </div>
    <div class="info mf m-newborn" id="babyNamePreview"></div>

    <label class="field mf m-nid m-unknown"><span>اسم المريض</span><input name="name"></label>
    <div class="row2 mf m-unknown">
      <label class="field"><span>السن التقريبي (سنوات)</span><input name="approxAge" type="number" min="0" max="120"></label>
      <label class="field"><span>النوع</span>
        <select name="gender"><option value="">اختر…</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
    </div>

    <div class="row2">
      <label class="field"><span>العنوان</span><input name="address" value="${esc(preset?.address || "")}"></label>
      <label class="field"><span>رقم التليفون</span><input name="phone" inputmode="tel" class="ltr" value="${esc(preset?.phone || "")}"></label>
    </div>
    <div class="note" id="patientNote"></div>
    <div id="admDup"></div>

    <div class="form-group-title">بيانات الدخول</div>
    <label class="field"><span>تاريخ ووقت الدخول</span>
      <input name="admitAt" type="datetime-local" value="${toLocalInput(now)}" max="${toLocalInput(now)}"
        ${earliest ? `min="${toLocalInput(earliest)}"` : ""}>
      ${earliest ? `<span class="hint">مسموح من ${fmtDateTime(earliest)} فقط، حسب صلاحيتك.</span>` : ""}</label>
    <div class="row2">
      <label class="field"><span>استشاري الحالة</span><select name="consultant">${optionsHtml(s.consultants || [], "")}</select></label>
      <label class="field"><span>المعاملة المالية</span><select name="finance">${optionsHtml(listOf("financeTypes"), "")}</select></label>
    </div>
    <div class="field"><span>التخصصات المشتركة</span>${checksHtml("spec", s.specialties || [])}</div>

    <div class="err" id="admErr"></div>
    <div class="actions"><button class="btn">حفظ الدخول</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);

  const f = document.getElementById("admForm");
  const st = { nidData: null, existing: null, babies: [], lookupSeq: 0 };
  const note = document.getElementById("patientNote");

  f.querySelectorAll('input[name="mode"]').forEach((r) => (r.onchange = () => {
    f.dataset.mode = r.value;
    note.textContent = "";
  }));

  // --- رقم قومي ---
  f.nid.oninput = async () => {
    f.nid.value = f.nid.value.replace(/\D/g, "");
    const info = document.getElementById("nidInfo");
    st.nidData = null; st.existing = null; note.textContent = "";
    if (f.nid.value.length < 14) { info.textContent = ""; return; }
    const parsed = parseNid(f.nid.value);
    if (!parsed) { info.textContent = ""; note.textContent = "الرقم القومي غير صحيح. راجع الأرقام."; return; }
    st.nidData = parsed;
    info.textContent = `تاريخ الميلاد ${fmtDate(parsed.birthDate)}، السن ${ageText(parsed.birthDate)}، ${genderText(parsed.gender)}`;
    const seq = ++st.lookupSeq;
    try {
      const snap = await getDoc(doc(db, "patients", f.nid.value));
      if (seq !== st.lookupSeq || !snap.exists()) return;
      const p = snap.data();
      st.existing = { id: snap.id, ...p };
      if (!f.name.value) f.name.value = p.name || "";
      if (!f.address.value) f.address.value = p.address || "";
      if (!f.phone.value) f.phone.value = p.phone || "";
      note.textContent = p.currentAdmissionId
        ? "المريض ده مسجل دخول حالياً في الرعاية، ولازم يخرج الأول قبل دخول جديد."
        : `المريض ده دخل الرعاية قبل كده ${p.admissionsCount || 0} مرة${p.medicalId ? `، ورقمه الطبي ${p.medicalId}` : ""}. البيانات اتملت من ملفه.`;
    } catch (e) { console.error(e); }
  };

  // --- مولود ---
  const babyName = () => {
    const g = f.babyGender.value, m = f.motherName.value.trim();
    return m && g ? `${g === "male" ? "ابن" : "بنت"} ${m}` : "";
  };
  const refreshBabyName = () => {
    const n = babyName();
    document.getElementById("babyNamePreview").textContent = n ? `هيتسجل باسم: ${n}` : "";
  };
  f.motherName.oninput = refreshBabyName;
  f.babyGender.onchange = refreshBabyName;
  f.motherNid.oninput = async () => {
    f.motherNid.value = f.motherNid.value.replace(/\D/g, "");
    const wrap = document.getElementById("babyPickWrap");
    st.babies = [];
    wrap.innerHTML = "";
    if (f.motherNid.value.length < 14) return;
    if (!parseNid(f.motherNid.value)) { wrap.innerHTML = `<div class="note">الرقم القومي للأم غير صحيح.</div>`; return; }
    const seq = ++st.lookupSeq;
    try {
      const snap = await getDocs(query(collection(db, "patients"), where("motherNationalId", "==", f.motherNid.value)));
      if (seq !== st.lookupSeq || snap.empty) return;
      st.babies = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const m = st.babies[0];
      if (!f.motherName.value) { f.motherName.value = m.motherName || ""; refreshBabyName(); }
      if (!f.address.value) f.address.value = m.address || "";
      if (!f.phone.value) f.phone.value = m.phone || "";
      wrap.innerHTML = `<span>مواليد مسجلين لنفس الأم</span><div class="baby-list">
        ${st.babies.map((b) => `<label><input type="radio" name="baby" value="${b.id}">
          ${esc(b.name)}، مواليد ${fmtDate(b.birthDate)}، دخل ${b.admissionsCount || 0} مرة
          ${b.currentAdmissionId ? " (موجود حالياً في الرعاية)" : ""}</label>`).join("")}
        <label><input type="radio" name="baby" value="" checked> مولود جديد</label></div>`;
      wrap.querySelectorAll('input[name="baby"]').forEach((r) => (r.onchange = () => {
        const b = st.babies.find((x) => x.id === r.value);
        if (b) { f.babyGender.value = b.gender || ""; f.babyBirth.value = b.birthDate || ""; refreshBabyName(); }
      }));
    } catch (e) { console.error(e); }
  };

  // --- حفظ ---
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("admErr");
    err.textContent = "";
    const mode = f.dataset.mode;
    const address = f.address.value.trim();
    const phone = f.phone.value.trim();
    if (phone && !/^[0-9+\s-]{7,20}$/.test(phone)) { err.textContent = "رقم التليفون غير صحيح."; return; }

    let patientRef, patient;
    if (mode === "preset") {
      patientRef = doc(db, "patients", preset.id);
      patient = { idType: preset.idType, nationalId: preset.nationalId || "", name: preset.name, birthDate: preset.birthDate || "",
        birthDateEstimated: !!preset.birthDateEstimated, gender: preset.gender || "", isNewborn: !!preset.isNewborn };
    } else if (mode === "nid") {
      if (!st.nidData) { err.textContent = "اكتب رقم قومي صحيح (14 رقم)."; return; }
      if (!f.name.value.trim()) { err.textContent = "اكتب اسم المريض."; return; }
      patientRef = doc(db, "patients", f.nid.value);
      patient = { idType: "nid", nationalId: f.nid.value, name: f.name.value.trim(),
        birthDate: st.nidData.birthDate, birthDateEstimated: false, gender: st.nidData.gender, isNewborn: false };
    } else if (mode === "newborn") {
      if (!f.motherName.value.trim()) { err.textContent = "اكتب اسم الأم."; return; }
      if (!parseNid(f.motherNid.value)) { err.textContent = "اكتب الرقم القومي للأم صحيح."; return; }
      if (!f.babyGender.value) { err.textContent = "اختر نوع المولود."; return; }
      if (!f.babyBirth.value) { err.textContent = "اكتب تاريخ الولادة."; return; }
      const picked = f.querySelector('input[name="baby"]:checked')?.value || "";
      patientRef = picked ? doc(db, "patients", picked) : doc(collection(db, "patients"));
      patient = { idType: "newborn", nationalId: "", name: babyName(), motherName: f.motherName.value.trim(),
        motherNationalId: f.motherNid.value, birthDate: f.babyBirth.value, birthDateEstimated: false,
        gender: f.babyGender.value, isNewborn: true };
    } else {
      if (!f.gender.value) { err.textContent = "اختر النوع."; return; }
      let birthDate = "", est = false;
      if (f.approxAge.value !== "") {
        const b = new Date(); b.setFullYear(b.getFullYear() - Number(f.approxAge.value));
        birthDate = isoDay(b); est = true;
      }
      patientRef = doc(collection(db, "patients"));
      patient = { idType: "unknown", nationalId: "", name: f.name.value.trim() || "مجهول الهوية",
        birthDate, birthDateEstimated: est, gender: f.gender.value, isNewborn: false };
    }
    patient.address = address;
    patient.phone = phone;
    patient.nameKey = nameKey(patient.name);

    // منع تكرار المريض: لو ملف جديد وفيه مريض بنفس الاسم
    const isNewFile = mode === "unknown" || (mode === "nid" && !st.existing) || (mode === "newborn" && !f.querySelector('input[name="baby"]:checked')?.value);
    if (isNewFile && !f.querySelector('input[name="dupOk"]')?.checked) {
      try {
        const dups = await findNameDuplicates(patient.name, patientRef.id);
        if (dups.length) {
          showDuplicates(document.getElementById("admDup"), dups, (x) => {
            if (x.currentAdmissionId || x.currentWardId) { toast("المريض ده موجود حالياً في دخول تاني.", true); return; }
            closeDialog(); setTimeout(() => openAdmissionDialog(unit, bed, x), 0);
          });
          err.textContent = "فيه مريض متسجل بنفس الاسم. استخدم ملفه، أو أكّد إنه مريض مختلف.";
          return;
        }
      } catch (e) { console.error(e); }
    }

    const admitAt = f.admitAt.value ? new Date(f.admitAt.value) : null;
    if (!admitAt || isNaN(admitAt)) { err.textContent = "حدد تاريخ ووقت الدخول."; return; }
    if (admitAt > new Date(Date.now() + 5 * 60e3)) { err.textContent = "تاريخ الدخول لا يمكن أن يكون في المستقبل."; return; }
    const earliestNow = earliestEditable();
    if (earliestNow && admitAt < earliestNow) { err.textContent = `مسموح لك تسجل دخول من ${fmtDateTime(earliestNow)} فقط. لتاريخ أقدم كلّم الأدمن.`; return; }
    if (!f.consultant.value) { err.textContent = "اختر استشاري الحالة."; return; }
    if (!f.finance.value) { err.textContent = "اختر المعاملة المالية."; return; }

    const btn = f.querySelector("button.btn"); btn.disabled = true;
    const bedRef = doc(db, "beds", `${unit.id}_${bed}`);
    const admRef = doc(collection(db, "admissions"));
    const counterRef = doc(db, "config", "counters");
    let medicalId = "";
    const uid = S.profile.uid;
    try {
      await runTransaction(db, async (tx) => {
        const bSnap = await tx.get(bedRef);
        if (bSnap.exists()) throw new Error("BED_TAKEN");
        const pSnap = await tx.get(patientRef);
        if (pSnap.exists() && (pSnap.data().currentAdmissionId || pSnap.data().currentWardId)) throw new Error("PATIENT_ADMITTED");
        const cSnap = await tx.get(counterRef);
        const ctr = { mr: 1000, icu: 0, ...(cSnap.exists() ? cSnap.data() : {}) };
        const count = (pSnap.exists() ? pSnap.data().admissionsCount || 0 : 0) + 1;
        const pData = { ...patient, admissionsCount: count, currentAdmissionId: admRef.id,
          updatedAt: serverTimestamp(), updatedBy: uid };
        // الرقم الطبي للمريض (MR) بيتعمل مرة واحدة، ورقم الدخول (R) لكل دخول رعاية
        medicalId = pSnap.exists() && pSnap.data().medicalId;
        if (!medicalId) { ctr.mr += 1; medicalId = `MR-${ctr.mr}`; pData.medicalId = medicalId; }
        ctr.icu += 1;
        tx.set(counterRef, { mr: ctr.mr, icu: ctr.icu }, { merge: true });
        if (!pSnap.exists()) { pData.createdAt = serverTimestamp(); pData.createdBy = uid; }
        pData.visits = arrayUnion(visitEntry("icu", admRef.id, `${medicalId}-R${count}`, Timestamp.fromDate(admitAt), unit.name));
        tx.set(patientRef, pData, { merge: true });
        tx.set(bedRef, { unitId: unit.id, bed, admissionId: admRef.id, since: serverTimestamp() });
        tx.set(admRef, {
          patientId: patientRef.id, patientName: patient.name, gender: patient.gender,
          birthDate: patient.birthDate, birthDateEstimated: patient.birthDateEstimated,
          isNewborn: patient.isNewborn, nationalId: patient.nationalId || "",
          unitId: unit.id, bed, admitAt: Timestamp.fromDate(admitAt),
          consultant: f.consultant.value, specialties: checkedValues(f, "spec"), finance: f.finance.value,
          financeHistory: [{ type: f.finance.value, from: isoDay(admitAt), byName: S.profile.displayName }],
          admissionNo: count, status: "active", medicalId, admissionNumber: `${medicalId}-R${count}`,
          deptAccess: deptAccessOf({ consultant: f.consultant.value, specialties: checkedValues(f, "spec") }),
          createdBy: uid, createdByName: S.profile.displayName, createdAt: serverTimestamp(),
        });
      });
      closeDialog();
      audit("دخول حالة", { adm: { id: admRef.id, patientName: patient.name, unitId: unit.id } });
      toast("تم تسجيل الدخول");
      location.hash = `#/patient/${admRef.id}`;
    } catch (e) {
      err.textContent = errText(e);
      btn.disabled = false;
    }
  };
}

/* =========================================================
   ملف المريض
   ========================================================= */
const HISTORY_FIELDS = [
  ["complaint", "الشكوى الرئيسية"],
  ["hpi", "تاريخ المرض الحالي"],
  ["pmh", "الأمراض المزمنة"],
  ["psh", "العمليات السابقة"],
  ["drugs", "أدوية يتناولها قبل الدخول"],
  ["allergy", "الحساسية"],
  ["other", "ملاحظات أخرى"],
];
const DX_TYPES = { initial: "مبدئي", final: "نهائي", complication: "مضاعفات" };
// الحالة السريرية: قرح الفراش والتنفس و APACHE II
const BEDSORE = { "0": "لا يوجد", "1": "الدرجة 1", "2": "الدرجة 2", "3": "الدرجة 3", "4": "الدرجة 4" };
const RESP = { room: "هواء الغرفة", mask: "ماسك", vent: "جهاز تنفس (فنت)" };
const RESP_SHORT = { room: "هواء غرفة", mask: "ماسك", vent: "فنت" };
const TURNING = { yes: "تم", no: "لم يتم" };
const CONSCIOUSNESS = ["Conscious", "Drowsy", "Confused", "Sedated", "Comatose"];
const INV_TYPES = { lab: "تحليل", radiology: "أشعة", other: "أخرى" };
const ROUTES = ["IV", "IM", "SC", "Oral", "NG tube", "Inhalation", "Topical", "Rectal", "Other"];
const FREQS = ["Once daily", "BID (q12h)", "TID (q8h)", "QID (q6h)", "q4h", "PRN", "STAT", "Continuous infusion"];
const PTABS = [
  ["info", "البيانات"],
  ["history", "الحالة والتشخيص"],
  ["consult", "الإشراف المشترك"],
  ["inv", "الأشعة والتحاليل"],
  ["vitals", "العلامات الحيوية"],
  ["nursing", "التمريض"],
  ["meds", "العلاج"],
];
const BASE_VITALS = [
  { key: "hr", label: "النبض", unit: "bpm" },
  { key: "bp", label: "الضغط", unit: "mmHg" },
  { key: "rr", label: "التنفس", unit: "/min" },
  { key: "temp", label: "الحرارة", unit: "°C" },
  { key: "spo2", label: "الأكسجين SpO2", unit: "%" },
  { key: "rbs", label: "السكر", unit: "mg/dL" },
  { key: "gcs", label: "GCS", unit: "" },
  { key: "uop", label: "كمية البول", unit: "ml" },
];
// ألوان تمييز خانات العلامات الحيوية
const VCOLORS = {
  "": { name: "بدون", bg: "", fg: "" },
  red: { name: "أحمر", bg: "#FBE6E6", fg: "#9B1C1C" },
  orange: { name: "برتقالي", bg: "#FDEBD8", fg: "#9A4A0B" },
  yellow: { name: "أصفر", bg: "#FBF4CF", fg: "#7A5C00" },
  green: { name: "أخضر", bg: "#E1F3E6", fg: "#1E6B3A" },
  blue: { name: "أزرق", bg: "#E1ECFA", fg: "#1D4E89" },
  purple: { name: "بنفسجي", bg: "#ECE4F8", fg: "#5B2E91" },
  gray: { name: "رمادي", bg: "#ECEFEE", fg: "#3E4B48" },
};
const vStyle = (c) => (VCOLORS[c]?.bg ? `style="background:${VCOLORS[c].bg};color:${VCOLORS[c].fg}"` : "");

function unitVitals(u) {
  if (u?.vitals?.length) return u.vitals;
  const extra = u?.id === "nicu"
    ? [{ key: "weight", label: "الوزن", unit: "g" }, { key: "inctemp", label: "حرارة الحضانة", unit: "°C" }]
    : u?.id === "burns" ? [{ key: "tbsa", label: "نسبة الحرق", unit: "%" }] : [];
  return [...BASE_VITALS, ...extra];
}

const fmtTime = (d) => new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" }).format(toDate(d));
const fmtDayShort = (s) => new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit" }).format(new Date(s + "T00:00:00"));
const shiftName = (d) => { const h = toDate(d).getHours(); return h >= 9 && h < 21 ? "صباحي" : "مسائي"; };
const pre = (s) => esc(s).replace(/\n/g, "<br>");
const asc = (x, y) => toDate(x.at) - toDate(y.at);
const desc = (x, y) => toDate(y.at) - toDate(x.at);
function stayDayOn(admitAt, dayStr) {
  const a = toDate(admitAt);
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  return Math.round((new Date(dayStr + "T00:00:00") - a0) / 86400000) + 1;
}
function dayRange(from, to) {
  const out = [];
  const d = new Date(from + "T00:00:00"), end = new Date(to + "T00:00:00");
  while (d <= end) { out.push(isoDay(d)); d.setDate(d.getDate() + 1); }
  return out;
}
const earliestDateStr = () => { const e = earliestEditable(); return e ? isoDay(e) : null; };

function subRef(name, id) {
  return id ? doc(db, "admissions", S.P.aid, name, id) : collection(db, "admissions", S.P.aid, name);
}
const meta = () => ({ createdBy: S.profile.uid, createdByName: S.profile.displayName, createdAt: serverTimestamp() });
const upMeta = () => ({ updatedBy: S.profile.uid, updatedByName: S.profile.displayName, updatedAt: serverTimestamp() });

function pCanAdd() {
  const a = S.P.adm;
  return canWriteUnit(a.unitId) && (isAdmin() || a.status === "active");
}
function pCanEdit(t) {
  if (!pCanAdd()) return false;
  if (isAdmin()) return true;
  const d = toDate(t);
  return !!d && d >= earliestEditable();
}

// خانة وقت مقيدة بفترة التعديل
function timeInput(name, label, d = new Date()) {
  const e = earliestEditable();
  return `<label class="field"><span>${label}</span>
    <input name="${name}" type="datetime-local" value="${toLocalInput(toDate(d))}" max="${toLocalInput(new Date())}" ${e ? `min="${toLocalInput(e)}"` : ""}>
    ${e ? `<span class="hint">مسموح من ${fmtDateTime(e)}</span>` : ""}</label>`;
}
function readTime(input) {
  const d = new Date(input.value);
  if (!input.value || isNaN(d)) return [null, "حدد التاريخ والوقت."];
  if (d > new Date(Date.now() + 5 * 60e3)) return [null, "الوقت لا يمكن أن يكون في المستقبل."];
  const e = earliestEditable();
  if (e && d < e) return [null, `مسموح من ${fmtDateTime(e)} فقط. لوقت أقدم كلّم الأدمن.`];
  return [d, ""];
}
function dateInput(name, label, value, minStr) {
  const e = earliestDateStr();
  const min = [e, minStr].filter(Boolean).sort().pop();
  return `<label class="field"><span>${label}</span>
    <input name="${name}" type="date" value="${value}" max="${isoDay(new Date())}" ${min ? `min="${min}"` : ""}></label>`;
}
function readDate(input, minStr) {
  const v = input.value;
  if (!v) return [null, "حدد التاريخ."];
  if (v > isoDay(new Date())) return [null, "التاريخ لا يمكن أن يكون في المستقبل."];
  const e = earliestDateStr();
  if (e && v < e) return [null, `مسموح من يوم ${fmtDate(e)} فقط. لتاريخ أقدم كلّم الأدمن.`];
  if (minStr && v < minStr) return [null, `التاريخ لازم يكون من ${fmtDate(minStr)} أو بعده.`];
  return [v, ""];
}

// نافذة نموذج عامة: onSave ترجع نص خطأ أو لا شيء
function formDialog(title, fieldsHtml, submitLabel, onSave, onDelete) {
  openDialog(`
  <form class="form" id="gForm" novalidate>
    <header class="dlg-head"><h3>${title}</h3></header>
    ${fieldsHtml}
    <div class="err" id="gErr"></div>
    <div class="actions">
      <button class="btn">${submitLabel}</button>
      <button type="button" class="btn ghost" data-close>إلغاء</button>
      ${onDelete ? `<button type="button" class="btn ghost del" id="gDel">حذف</button>` : ""}
    </div>
  </form>`);
  const f = document.getElementById("gForm");
  const err = document.getElementById("gErr");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const btn = f.querySelector("button.btn");
    btn.disabled = true;
    try {
      const r = await onSave(f);
      if (r) { err.textContent = r; btn.disabled = false; return; }
      closeDialog();
    } catch (e) { err.textContent = errText(e); btn.disabled = false; }
  };
  if (onDelete) document.getElementById("gDel").onclick = async () => {
    if (!confirm("حذف السجل ده نهائياً؟")) return;
    try { await onDelete(); closeDialog(); toast("تم الحذف"); } catch (e) { err.textContent = errText(e); }
  };
  return f;
}

function renderPatient(aid) {
  shell(`<div class="loading">جاري تحميل ملف المريض…</div>`);
  const prevTab = S.P?.aid === aid ? S.P.tab : "info";
  const P = (S.P = { aid, adm: null, pat: null, entries: [], vitals: [], meds: [], tab: prevTab, showHist: false, scroll: {}, subs: false });
  const draw = () => { if (S.P === P && S.page === "patient" && P.adm && P.pat) drawPatient(); };
  S.pageUnsubs.push(onSnapshot(doc(db, "admissions", aid), (snap) => {
    if (!snap.exists()) { shell(`<div class="empty">الملف غير موجود. <a href="#/">ارجع للأسرّة</a></div>`); return; }
    P.adm = { id: snap.id, ...snap.data() };
    if (isDept()) P.pat = patFromAdm(P.adm);
    if (!P.subs) {
      P.subs = true;
      if (!isDept()) S.pageUnsubs.push(onSnapshot(doc(db, "patients", P.adm.patientId), (ps) => { P.pat = ps.data() || {}; draw(); }));
      S.pageUnsubs.push(onSnapshot(consultsQ(aid), (s) => {
        P.creqs = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw();
      }, () => {}));
      for (const k of ["entries", "vitals", "meds"]) {
        S.pageUnsubs.push(onSnapshot(collection(db, "admissions", aid, k), (s) => {
          P[k] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
          draw();
        }, (e) => console.error(k, e)));
      }
    }
    draw();
  }, () => {
    if (isDept()) { toast("مبقاش ليك صلاحية على الحالة دي (تم الرد أو الحالة خرجت)"); location.hash = "#/"; return; }
    shell(`<div class="empty">ليس لديك صلاحية لعرض هذا الملف. الحالات اللي خرجت بتظهر للأدمن فقط. <a href="#/">ارجع للأسرّة</a></div>`);
  }));
}

function drawPatient() {
  const P = S.P, a = P.adm, p = P.pat;
  const unit = unitById(a.unitId) || { name: a.unitId, bedLabel: "سرير" };
  const active = a.status === "active";
  const y = window.scrollY;

  const nConsult = P.entries.filter((e) => e.kind === "consult").length;
  const nPending = P.entries.filter((e) => e.kind === "investigation" && !e.result).length;
  const nMeds = P.meds.filter((m) => !m.stopDate && !medEnded(m)).length;
  const badge = { consult: nConsult, inv: nPending, meds: nMeds };

  const body = { info: ptInfo, history: ptHistory, consult: ptConsult, inv: ptInv, vitals: ptVitals, meds: ptMeds, nursing: ptNursing }[P.tab]();

  shell(`
  <div class="file-head">
    <a class="back" href="${isDept() ? "#/" : `#/unit/${a.unitId}`}">${isDept() ? `قسم ${esc(S.profile.deptSpecialty)}` : esc(unit.name)}</a>
    <h1>${isDept() ? esc(p.name || a.patientName) : `<a href="#/p/${a.patientId}" class="plain" title="ملف المريض الشامل">${esc(p.name || a.patientName)}</a>`}</h1>
    <div class="tags">
      ${p.medicalId ? `<span class="tag mr">${esc(p.medicalId)}</span>` : ""}
      <span class="tag">${esc(unit.bedLabel)} ${a.bed}</span>
      ${active ? `<span class="tag day">اليوم ${stayDays(a)} للإقامة</span>` : `<span class="tag archived">في الأرشيف: ${DIS_TYPES[a.dischargeType] || "خرج"}</span>`}
      ${a.consultant ? `<span class="tag">${esc(a.consultant)}</span>` : ""}
      ${a.clinical?.resp ? `<span class="tag ${a.clinical.resp === "vent" ? "hot" : ""}">${RESP_SHORT[a.clinical.resp]}</span>` : ""}
      ${Number(a.clinical?.bedsore) > 0 ? `<span class="tag ${Number(a.clinical.bedsore) >= 3 ? "hot" : ""}">قرحة فراش ${a.clinical.bedsore}</span>` : ""}
      ${a.clinical?.apache != null ? `<span class="tag ${a.clinical.apache > 40 ? "hot" : ""}">APACHE ${a.clinical.apache}</span>` : ""}
      ${a.clinical?.restraint ? `<span class="tag">أمر تقييد</span>` : ""}
    </div>
    ${(active && canWriteUnit(a.unitId)) || canPrint() || canEdit("reports") ? `<div class="file-actions">
      ${active && canWriteUnit(a.unitId) ? `<button class="btn ghost" data-act="transfer">نقل</button>
      <button class="btn danger" data-act="discharge">خروج</button>` : ""}
      ${active && canWriteUnit(a.unitId) ? `<button class="btn ghost" data-act="wristband">بطاقة تعريف</button>` : ""}
      ${canEdit("reports") ? `<button class="btn ghost" data-act="report">تقرير طبي</button>` : ""}
      ${active && canWriteUnit(a.unitId) ? `<button class="btn ghost" data-act="consultReq">طلب استشارة</button>` : ""}
      ${isAdmin() ? `<button class="btn ghost del" data-act="deleteAdm">حذف الدخول</button>` : ""}
      ${canPrint() ? `<button class="btn ghost" data-act="print">طباعة / PDF</button>` : ""}</div>` : ""}
  </div>
  <nav class="ptabs" role="tablist">${PTABS.map(([k, t]) =>
    `<button role="tab" aria-selected="${P.tab === k}" data-act="tab" data-tab="${k}" class="${P.tab === k ? "on" : ""}">${t}${badge[k] ? `<b>${badge[k]}</b>` : ""}</button>`).join("")}</nav>
  <div class="ptab-body">${body}</div>
  <datalist id="dlDrugs">${(S.settings.drugs || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
  <datalist id="dlFreq">${FREQS.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`);

  root.querySelector("main").onclick = onPatientClick;
  const cr = document.getElementById("pCreqs"); if (cr) bindConsultActions(cr, P.creqs || []);
  root.querySelectorAll(".sheet[data-sheet]").forEach((el) => {
    const k = el.dataset.sheet;
    // الجدول بيفتح على آخر قراءة (أقصى الشمال في العربي)
    el.scrollLeft = k in P.scroll ? P.scroll[k] : -(el.scrollWidth - el.clientWidth);
    el.onscroll = () => (P.scroll[k] = el.scrollLeft);
  });
  window.scrollTo(0, y);
}

function onPatientClick(ev) {
  const b = ev.target.closest("[data-act]");
  if (!b) return;
  const P = S.P, id = b.dataset.id;
  const ent = () => P.entries.find((x) => x.id === id);
  const med = () => P.meds.find((x) => x.id === id);
  switch (b.dataset.act) {
    case "tab": P.tab = b.dataset.tab; P.scroll = {}; drawPatient(); window.scrollTo(0, 0); break;
    case "editBasic": openEditBasic(P.adm, P.pat); break;
    case "editAdm": openEditAdmission(P.adm); break;
    case "histEdit": openHistory(); break;
    case "histToggle": P.showHist = !P.showHist; drawPatient(); break;
    case "dxAdd": openDx(); break;
    case "stAdd": openStatus(); break;
    case "stEdit": openStatus(ent()); break;
    case "dxEdit": openDx(ent()); break;
    case "cAdd": openConsult(); break;
    case "cEdit": openConsult(ent()); break;
    case "invAdd": openInv(); break;
    case "invEdit": openInvEdit(ent()); break;
    case "invResult": openInvResult(ent()); break;
    case "vAdd": openVitals(); break;
    case "nAdd": openNursingNote(); break;
    case "nEdit": openNursingNote(ent()); break;
    case "consultReq": openConsultRequest("icu", P.adm); break;
    case "vEdit": openVitals(P.vitals.find((x) => x.id === id)); break;
    case "mAdd": openMed(); break;
    case "mChange": openMedChange(med()); break;
    case "mStop": openMedStop(med()); break;
    case "mResume": resumeMed(med()); break;
    case "mDel": deleteMed(med()); break;
    case "transfer": openTransfer(); break;
    case "discharge": openDischarge(); break;
    case "prevAdm": loadPrevAdmissions(); break;
    case "dsum": dischargeSummaryAction("icu"); break;
    case "print": openPrintDialog(); break;
    case "wristband": printWristband(); break;
    case "report": openReportForm({ type: "icu", adm: P.adm, pat: P.pat }); break;
    case "deleteAdm": deleteIcuAdmission(); break;
    case "finChange": openFinanceChange(); break;
    case "finDel": deleteFinance(b.dataset.from); break;
  }
}

/* ---------- البيانات ---------- */
function ptInfo() {
  const { adm: a, pat: p } = S.P;
  const unit = unitById(a.unitId) || { name: a.unitId, bedLabel: "سرير" };
  const canW = a.status === "active" && canWriteUnit(a.unitId);
  const age = ageText(p.birthDate ?? a.birthDate, p.birthDateEstimated ?? a.birthDateEstimated);
  const idRows = p.idType === "newborn"
    ? `<dt>اسم الأم</dt><dd>${esc(p.motherName)}</dd><dt>الرقم القومي للأم</dt><dd class="ltr">${esc(p.motherNationalId)}</dd>
       <dt>تاريخ الولادة</dt><dd>${fmtDate(p.birthDate)}</dd>`
    : p.idType === "unknown"
      ? `<dt>الرقم القومي</dt><dd class="muted">غير معروف</dd>`
      : `<dt>الرقم القومي</dt><dd class="ltr">${esc(p.nationalId)}</dd><dt>تاريخ الميلاد</dt><dd>${fmtDate(p.birthDate)}</dd>`;
  const specs = (a.specialties || []).map((x) => `<span class="pill">${esc(x)}</span>`).join("") || `<span class="muted">لا يوجد</span>`;
  return `
  <div class="file-grid">
    <section class="panel">
      <header><h2>البيانات الأساسية</h2>${canW ? `<button class="btn ghost sm" data-act="editBasic">تعديل</button>` : ""}</header>
      <dl class="kv">
        <dt>الاسم</dt><dd>${esc(p.name)}</dd>
        <dt>الرقم الطبي</dt><dd class="ltr">${esc(p.medicalId) || "—"}</dd>
        ${idRows}
        <dt>السن</dt><dd>${esc(age) || "—"}</dd>
        <dt>النوع</dt><dd>${genderText(p.gender) || "—"}</dd>
        <dt>العنوان</dt><dd>${esc(p.address) || "—"}</dd>
        <dt>التليفون</dt><dd class="ltr">${esc(p.phone) || "—"}</dd>
      </dl>
      ${p.visits?.length ? visitsListHtml(p, a.id) : visitsHtml(a, p)}
    </section>
    <section class="panel">
      <header><h2>بيانات الدخول</h2>${canW ? `<button class="btn ghost sm" data-act="editAdm">تعديل</button>` : ""}</header>
      <dl class="kv">
        <dt>رقم الدخول</dt><dd class="ltr">${esc(a.admissionNumber) || "—"}</dd>
        <dt>تاريخ الدخول</dt><dd>${fmtDateTime(a.admitAt)}</dd>
        <dt>أيام الإقامة</dt><dd>${stayDays(a)} يوم</dd>
        <dt>الوحدة</dt><dd>${esc(unit.name)}، ${esc(unit.bedLabel)} ${a.bed}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(a.consultant) || "—"}</dd>
        <dt>المعاملة المالية</dt><dd>${finInfoHtml(a, canW)}</dd>
        <dt>التخصصات المشتركة</dt><dd>${specs}</dd>
        <dt>سجّل الدخول</dt><dd>${esc(a.createdByName)}</dd>
      </dl>
    </section>
  </div>${ptInfoExtra()}`;
}

/* ---------- التاريخ المرضي والتشخيص ---------- */
function ptHistory() {
  const P = S.P;
  const hs = P.entries.filter((e) => e.kind === "history").sort(desc);
  const cur = hs[0];
  const add = pCanAdd();
  const histBody = cur
    ? `<dl class="kv">${HISTORY_FIELDS.filter(([k]) => cur[k]).map(([k, l]) => `<dt>${l}</dt><dd>${pre(cur[k])}</dd>`).join("")}</dl>
       <p class="by-line">آخر تحديث: ${esc(cur.createdByName)}، ${fmtDateTime(cur.at)}</p>
       ${hs.length > 1 ? `<button class="linkbtn" data-act="histToggle">${P.showHist ? "إخفاء" : "عرض"} النسخ السابقة (${hs.length - 1})</button>` : ""}
       ${P.showHist ? `<div class="old-versions">${hs.slice(1).map((h) => `
         <div class="old"><p class="by-line">${esc(h.createdByName)}، ${fmtDateTime(h.at)}</p>
         <dl class="kv">${HISTORY_FIELDS.filter(([k]) => h[k]).map(([k, l]) => `<dt>${l}</dt><dd>${pre(h[k])}</dd>`).join("")}</dl></div>`).join("")}</div>` : ""}`
    : `<p class="muted">لم يُسجل التاريخ المرضي بعد.</p>`;

  const dx = P.entries.filter((e) => e.kind === "diagnosis").sort(desc);
  const dxBody = dx.length
    ? `<ul class="entries">${dx.map((e) => `
        <li>
          <div class="entry-head"><span class="pill t-${e.dxType}">${DX_TYPES[e.dxType] || ""}</span>
            <span class="by-line">${esc(e.createdByName)}، ${fmtDateTime(e.at)}</span>
            ${pCanEdit(e.at) ? `<button class="btn ghost sm" data-act="dxEdit" data-id="${e.id}">تعديل</button>` : ""}</div>
          <p>${pre(e.text)}</p>
        </li>`).join("")}</ul>`
    : `<p class="muted">لم يُسجل تشخيص بعد.</p>`;

  return clinicalPanel() + `
  <div class="file-grid">
    <section class="panel">
      <header><h2>التاريخ المرضي</h2>${add ? `<button class="btn ghost sm" data-act="histEdit">${cur ? "تحديث" : "تسجيل"}</button>` : ""}</header>
      ${histBody}
    </section>
    <section class="panel">
      <header><h2>التشخيص</h2>${add ? `<button class="btn ghost sm" data-act="dxAdd">إضافة تشخيص</button>` : ""}</header>
      ${dxBody}
    </section>
  </div>`;
}

function clinicalPanel() {
  const list = S.P.entries.filter((e) => e.kind === "status").sort(desc);
  const c = list[0];
  const add = pCanAdd();
  const box = (label, val, cls = "") => `<div class="cl-box ${cls}"><span>${label}</span><strong>${val}</strong></div>`;
  return `
  <section class="panel clinical">
    <header><h2>الحالة السريرية</h2>${add ? `<button class="btn ghost sm" data-act="stAdd">تحديث</button>` : ""}</header>
    ${c ? `
      <div class="cl-row">
        ${box("التنفس", esc(RESP[c.resp] || "—"), c.resp === "vent" ? "hot" : "")}
        ${box("درجة الوعي", esc(c.consciousness || "—"))}
        ${box("APACHE II", c.apache ?? "—", c.apache > 40 ? "hot" : "")}
        ${box("قرح الفراش", esc(BEDSORE[c.bedsore] || "—") + (c.bedsoreSite ? `<small>${esc(c.bedsoreSite)}</small>` : ""), Number(c.bedsore) >= 3 ? "hot" : "")}
        ${box("التقليب", esc(TURNING[c.turning] || "—"), c.turning === "no" ? "hot" : "")}
        ${box("أمر تقييد", c.restraint ? "يوجد" : "لا يوجد", c.restraint ? "warn" : "")}
      </div>
      <p class="by-line">آخر تحديث: ${esc(c.createdByName)}، ${fmtDateTime(c.at)}</p>
      <details class="cl-hist"><summary>السجل (${list.length})</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>الوقت</th><th>التنفس</th><th>الوعي</th><th>APACHE</th><th>قرح الفراش</th><th>التقليب</th><th>تقييد</th><th>بواسطة</th><th></th></tr></thead>
          <tbody>${list.map((e) => `<tr><td class="nowrap">${fmtDateTime(e.at)}</td><td>${esc(RESP_SHORT[e.resp] || "—")}</td>
            <td>${esc(e.consciousness || "—")}</td><td>${e.apache ?? "—"}</td>
            <td>${esc(BEDSORE[e.bedsore] || "—")}${e.bedsoreSite ? `<div class="by-line">${esc(e.bedsoreSite)}</div>` : ""}</td>
            <td>${esc(TURNING[e.turning] || "—")}</td><td>${e.restraint ? "نعم" : "—"}</td>
            <td>${esc(e.createdByName)}</td>
            <td>${pCanEdit(e.at) ? `<button class="btn ghost sm" data-act="stEdit" data-id="${e.id}">تعديل</button>` : ""}</td></tr>`).join("")}</tbody>
        </table></div></details>`
    : `<p class="muted">لم تُسجل بعد. سجّل التنفس والوعي و APACHE وقرح الفراش والتقليب من زر "تحديث".</p>`}
  </section>`;
}

function openStatus(e) {
  const latest = S.P.entries.filter((x) => x.kind === "status").sort(desc)[0] || {};
  const prev = e || latest;
  const seg = (name, obj, cur, short) => `<fieldset class="seg seg-wrap">${Object.entries(obj).map(([k, l]) =>
    `<label><input type="radio" name="${name}" value="${k}" ${String(cur ?? "") === k ? "checked" : ""}> ${short ? short(k, l) : l}</label>`).join("")}</fieldset>`;
  const f = formDialog(e ? "تعديل الحالة السريرية" : "تحديث الحالة السريرية", `
    <div class="field"><span>التنفس</span>${seg("resp", RESP, prev.resp)}</div>
    <div class="row2">
      <label class="field"><span>درجة الوعي</span><input name="consciousness" list="dlConsc" value="${esc(prev.consciousness || "")}" autocomplete="off">
        <datalist id="dlConsc">${CONSCIOUSNESS.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>
      <label class="field"><span>APACHE II Score</span><input name="apache" type="number" min="0" max="71" class="ltr" value="${prev.apache ?? ""}" placeholder="0 - 71"></label>
    </div>
    <div class="field"><span>قرح الفراش</span>${seg("bedsore", BEDSORE, prev.bedsore, (k, l) => (k === "0" ? l : k))}</div>
    <label class="field" id="siteWrap"><span>مكان القرحة</span><input name="bedsoreSite" value="${esc(prev.bedsoreSite || "")}" placeholder="مثال: العجز، الكعب"></label>
    <div class="field"><span>التقليب</span>${seg("turning", TURNING, prev.turning)}</div>
    <div class="checks">
      <label><input type="checkbox" name="restraint" ${prev.restraint ? "checked" : ""}> أمر تقييد</label>
    </div>
    ${timeInput("at", "الوقت", e?.at || new Date())}`,
    e ? "حفظ التعديل" : "حفظ",
    async (f) => {
      const radio = (n) => f.querySelector(`input[name="${n}"]:checked`)?.value || "";
      const resp = radio("resp"), bedsore = radio("bedsore"), turning = radio("turning");
      const consciousness = f.elements.consciousness.value.trim();
      const av = f.elements.apache.value.trim();
      const apache = av === "" ? null : Number(av);
      const restraint = f.elements.restraint.checked;
      if (!resp && !bedsore && !turning && !consciousness && apache == null && !restraint) return "سجّل خانة واحدة على الأقل.";
      if (apache != null && (!Number.isInteger(apache) || apache < 0 || apache > 71)) return "APACHE II لازم يكون رقم صحيح من 0 لـ 71.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      const data = { kind: "status", resp, consciousness, apache, bedsore, turning, restraint,
        bedsoreSite: Number(bedsore) > 0 ? f.elements.bedsoreSite.value.trim() : "", at: Timestamp.fromDate(at) };
      let id = e?.id;
      if (e) await pUpd(subRef("entries", e.id), { ...data, ...upMeta() });
      else id = (await addDoc(subRef("entries"), { ...data, ...meta() })).id;
      await syncClinical({ id, ...data });
      toast("تم حفظ الحالة السريرية");
    },
    e ? async () => { await pDel(subRef("entries", e.id)); await syncClinical(null, e.id); } : null);
  const sync = () => {
    document.getElementById("siteWrap").classList.toggle("hidden", !(Number(f.querySelector('input[name="bedsore"]:checked')?.value) > 0));
  };
  f.querySelectorAll('input[name="bedsore"]').forEach((r) => (r.onchange = sync));
  sync();
}

// آخر حالة سريرية بتتحفظ على الدخول نفسه عشان تظهر على خريطة الأسرّة
async function syncClinical(changed, removedId) {
  const a = S.P.adm;
  const list = S.P.entries.filter((x) => x.kind === "status" && x.id !== removedId && x.id !== changed?.id);
  if (changed) list.push(changed);
  list.sort(desc);
  const c = list[0];
  try {
    await updateDoc(doc(db, "admissions", a.id), {
      clinical: c ? { resp: c.resp || "", bedsore: c.bedsore || "", apache: c.apache ?? null, consciousness: c.consciousness || "",
        turning: c.turning || "", restraint: !!c.restraint, at: c.at } : null,
    });
  } catch (e) { console.error("clinical", e); }
}

function openHistory() {
  const cur = S.P.entries.filter((e) => e.kind === "history").sort(desc)[0];
  formDialog("التاريخ المرضي",
    HISTORY_FIELDS.map(([k, l]) => {
      const opts = listOf(`historyOptions.${k}`);
      return `<div class="field"><label for="h_${k}"><span>${l}</span></label>
        <textarea id="h_${k}" name="${k}" rows="${k === "hpi" ? 4 : 2}" class="ltr-auto">${esc(cur?.[k] || "")}</textarea>
        ${opts.length ? `<div class="opt-chips">${opts.map((o) => `<button type="button" class="opt" data-f="${k}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}</div>`;
    }).join("")
    + (cur ? `<p class="hint">الحفظ بيعمل نسخة جديدة، والنسخة الحالية بتفضل محفوظة في السجل.</p>` : ""),
    "حفظ التاريخ المرضي",
    async (f) => {
      const data = {};
      HISTORY_FIELDS.forEach(([k]) => (data[k] = f.elements[k].value.trim()));
      if (!Object.values(data).some(Boolean)) return "اكتب بيانات في خانة واحدة على الأقل.";
      await addDoc(subRef("entries"), { kind: "history", ...data, at: Timestamp.now(), ...meta() });
      toast("تم حفظ التاريخ المرضي");
    });
  bindOptChips();
}

// الضغط على اختيار من القائمة بيضيفه للخانة، وتقدر تعدل عليه بعدها
function appendTo(ta, v) {
  const cur = ta.value.trim();
  if (cur.split(/[\n،,]+/).map((x) => x.trim()).includes(v)) return;
  ta.value = cur ? `${cur}، ${v}` : v;
  ta.focus();
}
function bindOptChips() {
  dlgBody.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
    appendTo(dlgBody.querySelector(`textarea[name="${b.dataset.f}"]`), b.dataset.v);
    b.classList.add("used");
  }));
}

function openDx(e) {
  const t = e?.dxType || "initial";
  formDialog(e ? "تعديل التشخيص" : "إضافة تشخيص", `
    <fieldset class="seg">${Object.entries(DX_TYPES).map(([k, l]) =>
      `<label><input type="radio" name="dxType" value="${k}" ${k === t ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    ${listOf("diagnoses").length ? `<label class="field"><span>اختر من قائمة التشخيصات</span>
      <input name="dxPick" list="dlDx" class="ltr" placeholder="اكتب أول حروف التشخيص واختار" autocomplete="off"></label>
      <datalist id="dlDx">${listOf("diagnoses").map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}
    <label class="field"><span>التشخيص</span><textarea name="text" rows="3" class="ltr-auto">${esc(e?.text || "")}</textarea>
      <span class="hint">الاختيار من القائمة بيتكتب هنا، وتقدر تعدل عليه.</span></label>
    ${isAdmin() ? `<div class="checks"><label><input type="checkbox" name="saveRef"> أضف التشخيص ده لقائمة التشخيصات</label></div>` : ""}
    ${timeInput("at", "الوقت", e?.at || new Date())}`,
    e ? "حفظ التعديل" : "إضافة التشخيص",
    async (f) => {
      const text = f.elements.text.value.trim();
      if (!text) return "اكتب التشخيص.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      const data = { kind: "diagnosis", dxType: f.querySelector('input[name="dxType"]:checked').value, text, at: Timestamp.fromDate(at) };
      if (e) await pUpd(subRef("entries", e.id), { ...data, ...upMeta() });
      else await addDoc(subRef("entries"), { ...data, ...meta() });
      if (f.elements.saveRef?.checked && !listOf("diagnoses").includes(text))
        await updateDoc(doc(db, "config", "settings"), { diagnoses: [...listOf("diagnoses"), text] });
      toast(e ? "تم حفظ التعديل" : "تمت إضافة التشخيص");
    },
    e ? () => pDel(subRef("entries", e.id)) : null);
  const pick = document.querySelector('#gForm input[name="dxPick"]');
  if (pick) pick.onchange = () => {
    const v = pick.value.trim();
    if (!listOf("diagnoses").includes(v)) return;
    appendTo(document.querySelector('#gForm textarea[name="text"]'), v);
    pick.value = "";
  };
}

/* ---------- الإشراف المشترك ---------- */
function ptConsult() {
  const list = S.P.entries.filter((e) => e.kind === "consult").sort(desc);
  const a = S.P.adm;
  return `
  <section class="panel" style="margin-bottom:16px" id="pCreqs">
    <header><h2>طلبات الاستشارة</h2>${a.status === "active" && canWriteUnit(a.unitId) ? `<button class="btn ghost sm" data-act="consultReq">طلب استشارة</button>` : ""}</header>
    ${consultListHtml(S.P.creqs || [], true)}
  </section>
  <section class="panel">
    <header><h2>الإشراف المشترك ورأي التخصصات</h2>${pCanAdd() || deptCanOpinion(S.P.adm) ? `<button class="btn ghost sm" data-act="cAdd">إضافة رأي</button>` : ""}</header>
    ${list.length ? `<ul class="entries">${list.map((e) => `
      <li>
        <div class="entry-head"><span class="pill">${esc(e.specialty)}</span>
          ${e.doctor ? `<strong>${esc(e.doctor)}</strong>` : ""}
          <span class="by-line">${fmtDateTime(e.at)}، سجّله ${esc(e.createdByName)}</span>
          ${pCanEdit(e.at) ? `<button class="btn ghost sm" data-act="cEdit" data-id="${e.id}">تعديل</button>` : ""}</div>
        <p>${pre(e.opinion)}</p>
      </li>`).join("")}</ul>` : `<p class="muted">لا يوجد آراء مسجلة.</p>`}
  </section>`;
}

function openConsult(e) {
  const specs = isDept() ? [S.profile.deptSpecialty] : [...new Set([...(S.P.adm.specialties || []), ...(S.settings.specialties || [])])];
  formDialog(e ? "تعديل الرأي" : "إضافة رأي تخصص", `
    <div class="row2">
      <label class="field"><span>التخصص</span><select name="specialty">${optionsHtml(specs, e?.specialty || "")}</select></label>
      <label class="field"><span>اسم الطبيب</span><input name="doctor" value="${esc(e?.doctor || S.profile.doctorName || "")}"></label>
    </div>
    <label class="field"><span>الرأي والتوصيات</span><textarea name="opinion" rows="5">${esc(e?.opinion || "")}</textarea></label>
    ${timeInput("at", "الوقت", e?.at || new Date())}`,
    e ? "حفظ التعديل" : "إضافة الرأي",
    async (f) => {
      const specialty = f.elements.specialty.value, opinion = f.elements.opinion.value.trim();
      if (!specialty) return "اختر التخصص.";
      if (!opinion) return "اكتب الرأي.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      const data = { kind: "consult", specialty, doctor: f.elements.doctor.value.trim(), opinion, at: Timestamp.fromDate(at) };
      if (e) await pUpd(subRef("entries", e.id), { ...data, ...upMeta() });
      else await addDoc(subRef("entries"), { ...data, ...meta() });
      toast(e ? "تم حفظ التعديل" : "تمت إضافة الرأي");
    },
    e ? () => pDel(subRef("entries", e.id)) : null);
}

/* ---------- الأشعة والتحاليل ---------- */
function ptInv() {
  const list = S.P.entries.filter((e) => e.kind === "investigation").sort(desc);
  const add = pCanAdd();
  return `
  <div class="toolbar"><h2>الأشعة والتحاليل</h2>${add ? `<button class="btn" data-act="invAdd">طلب جديد</button>` : ""}</div>
  ${list.length ? `<div class="table-wrap"><table>
    <thead><tr><th>وقت الطلب</th><th>النوع</th><th>الطلب</th><th>النتيجة</th><th></th></tr></thead>
    <tbody>${list.map((e) => {
      const resEditable = add && (!e.resultAt || pCanEdit(e.resultAt));
      return `<tr class="${e.result ? "" : "pending"}">
        <td>${fmtDateTime(e.at)}<div class="by-line">${esc(e.createdByName)}</div></td>
        <td>${INV_TYPES[e.invType] || ""}</td>
        <td class="ltr-auto"><strong>${esc(e.name)}</strong></td>
        <td>${e.result
          ? `<div class="ltr-auto">${pre(e.result)}</div><div class="by-line">${fmtDateTime(e.resultAt)}، ${esc(e.resultByName || "")}</div>`
          : `<span class="wait">منتظر النتيجة</span>`}</td>
        <td class="nowrap">
          ${resEditable ? `<button class="btn ghost sm" data-act="invResult" data-id="${e.id}">${e.result ? "تعديل النتيجة" : "إضافة النتيجة"}</button>` : ""}
          ${pCanEdit(e.at) ? `<button class="btn ghost sm" data-act="invEdit" data-id="${e.id}">تعديل الطلب</button>` : ""}
        </td></tr>`;
    }).join("")}</tbody></table></div>` : `<div class="empty">لا يوجد طلبات أشعة أو تحاليل.</div>`}`;
}

function openInv() {
  const common = S.settings.investigations || [];
  formDialog("طلب أشعة أو تحاليل", `
    <fieldset class="seg">${Object.entries(INV_TYPES).map(([k, l], i) =>
      `<label><input type="radio" name="invType" value="${k}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    ${common.length ? `<div class="field"><span>من القائمة</span>${checksHtml("pick", common)}</div>` : ""}
    <label class="field"><span>${common.length ? "طلبات أخرى" : "الطلبات"}</span>
      <textarea name="others" rows="2" class="ltr-auto" placeholder="كل طلب في سطر، أو افصل بينهم بفاصلة"></textarea></label>
    ${timeInput("at", "وقت الطلب")}`,
    "حفظ الطلبات",
    async (f) => {
      const names = [...checkedValues(f, "pick"), ...f.elements.others.value.split(/[\n,،]+/).map((s) => s.trim()).filter(Boolean)];
      if (!names.length) return "اختر أو اكتب طلباً واحداً على الأقل.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      const invType = f.querySelector('input[name="invType"]:checked').value;
      const b = writeBatch(db);
      names.forEach((name) => b.set(doc(subRef("entries")), {
        kind: "investigation", invType, name, at: Timestamp.fromDate(at),
        result: "", resultAt: null, ...meta(),
      }));
      await b.commit();
      toast(names.length > 1 ? `تم حفظ ${names.length} طلبات` : "تم حفظ الطلب");
    });
}

function openInvEdit(e) {
  formDialog("تعديل الطلب", `
    <fieldset class="seg">${Object.entries(INV_TYPES).map(([k, l]) =>
      `<label><input type="radio" name="invType" value="${k}" ${k === e.invType ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    <label class="field"><span>الطلب</span><input name="invName" class="ltr-auto" value="${esc(e.name)}"></label>
    ${timeInput("at", "وقت الطلب", e.at)}`,
    "حفظ التعديل",
    async (f) => {
      const name = f.elements.invName.value.trim();
      if (!name) return "اكتب اسم الطلب.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      await pUpd(subRef("entries", e.id), { name, invType: f.querySelector('input[name="invType"]:checked').value,
        at: Timestamp.fromDate(at), ...upMeta() });
      toast("تم حفظ التعديل");
    },
    () => pDel(subRef("entries", e.id)));
}

function openInvResult(e) {
  formDialog(`نتيجة: ${esc(e.name)}`, `
    <label class="field"><span>النتيجة</span><textarea name="result" rows="4" class="ltr-auto">${esc(e.result || "")}</textarea></label>
    ${timeInput("resultAt", "وقت النتيجة", e.resultAt || new Date())}`,
    "حفظ النتيجة",
    async (f) => {
      const result = f.elements.result.value.trim();
      if (!result) return "اكتب النتيجة.";
      const [at, er] = readTime(f.elements.resultAt); if (er) return er;
      await pUpd(subRef("entries", e.id), { result, resultAt: Timestamp.fromDate(at),
        resultBy: S.profile.uid, resultByName: S.profile.displayName });
      toast("تم حفظ النتيجة");
    });
}

/* ---------- العلامات الحيوية وتطور الحالة ---------- */
function ptVitals() {
  const P = S.P, a = P.adm;
  const fields = unitVitals(unitById(a.unitId));
  const rs = [...P.vitals].sort(asc);
  const head = `<div class="toolbar"><h2>العلامات الحيوية وتطور الحالة</h2>${pCanNurse() ? `<button class="btn" data-act="vAdd">إضافة قراءة</button>` : ""}</div>`;
  if (!rs.length) return head + `<div class="empty">لا يوجد قراءات مسجلة. كل قراءة بتظهر كعمود بتاريخها ووقتها.</div>`;

  const groups = [];
  rs.forEach((r) => {
    const d = isoDay(toDate(r.at));
    if (groups.length && groups[groups.length - 1].day === d) groups[groups.length - 1].n++;
    else groups.push({ day: d, n: 1 });
  });
  const colHead = (r) => pCanEditN(r.at)
    ? `<button class="col-btn" data-act="vEdit" data-id="${r.id}" title="تعديل القراءة">${fmtTime(r.at)}<small>${shiftName(r.at)}</small></button>`
    : `${fmtTime(r.at)}<small>${shiftName(r.at)}</small>`;
  return head + `
  <div class="table-wrap sheet" data-sheet="vitals"><table class="grid">
    <thead>
      <tr><th class="stick" rowspan="2">العلامة</th>${groups.map((g) =>
        `<th colspan="${g.n}" class="day-h">${fmtDate(g.day)}<small>اليوم ${stayDayOn(a.admitAt, g.day)}</small></th>`).join("")}</tr>
      <tr>${rs.map((r) => `<th class="rd-h">${colHead(r)}</th>`).join("")}</tr>
    </thead>
    <tbody>
      ${fields.map((f) => `<tr><th class="stick" ${vStyle(f.color)}>${esc(f.label)}${f.unit ? `<small>${esc(f.unit)}</small>` : ""}</th>
        ${rs.map((r) => `<td class="v" ${vStyle(f.color)}>${esc(r.values?.[f.key] ?? "")}</td>`).join("")}</tr>`).join("")}
      <tr class="note-row"><th class="stick">تطور الحالة</th>${rs.map((r) => `<td class="note ltr-auto">${pre(r.note || "")}</td>`).join("")}</tr>
      <tr class="by-row"><th class="stick">سجّل</th>${rs.map((r) => `<td>${esc(r.createdByName)}</td>`).join("")}</tr>
    </tbody>
  </table></div>`;
}

function openVitals(r) {
  const fields = unitVitals(unitById(S.P.adm.unitId));
  formDialog(r ? "تعديل القراءة" : "إضافة قراءة", `
    ${timeInput("at", "وقت القراءة", r?.at || new Date())}
    <div class="vgrid">${fields.map((f) => `<label class="field vfield" ${vStyle(f.color)}><span>${esc(f.label)}${f.unit ? ` (${esc(f.unit)})` : ""}</span>
      <input name="v_${f.key}" class="ltr" value="${esc(r?.values?.[f.key] ?? "")}" autocomplete="off"></label>`).join("")}</div>
    <label class="field"><span>تطور الحالة</span><textarea name="note" rows="4" class="ltr-auto">${esc(r?.note || "")}</textarea></label>`,
    r ? "حفظ التعديل" : "حفظ القراءة",
    async (f) => {
      const values = {};
      fields.forEach((x) => { const v = f.elements["v_" + x.key].value.trim(); if (v) values[x.key] = v; });
      const note = f.elements.note.value.trim();
      if (!Object.keys(values).length && !note) return "سجّل علامة واحدة على الأقل أو تطور الحالة.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      if (r) await pUpd(subRef("vitals", r.id), { values: { ...Object.fromEntries(Object.entries(r.values || {}).filter(([k]) => !fields.some((f) => f.key === k))), ...values }, note, at: Timestamp.fromDate(at), ...upMeta() });
      else await addDoc(subRef("vitals"), { values, note, at: Timestamp.fromDate(at), ...meta() });
      toast(r ? "تم حفظ التعديل" : "تم حفظ القراءة");
    },
    r ? () => pDel(subRef("vitals", r.id)) : null);
}

/* ---------- العلاج ---------- */
// المدة: عدد أيام العلاج (اختياري). آخر يوم = يوم البداية + المدة - 1
const addDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return isoDay(d); };
const medEnd = (m) => (m.duration ? addDays(m.startDate, m.duration - 1) : null);
const medEnded = (m) => !m.stopDate && !!medEnd(m) && medEnd(m) < isoDay(new Date());
const medDayNo = (m, day) => Math.round((new Date(day + "T00:00:00") - new Date(m.startDate + "T00:00:00")) / 86400000) + 1;
const sortedDoses = (m) => [...(m.doses || [])].sort((x, y) => x.from.localeCompare(y.from));
const currentDose = (m) => sortedDoses(m).pop() || {};

function ptMeds() {
  const P = S.P, a = P.adm;
  const add = pCanAdd();
  const minEdit = earliestDateStr();
  const head = `<div class="toolbar"><h2>العلاج اليومي</h2>${add ? `<button class="btn" data-act="mAdd">إضافة علاج</button>` : ""}</div>`;
  if (!P.meds.length) return head + `<div class="empty">لا يوجد علاج مسجل. العلاج بيفضل مستمر كل يوم لحد ما يتوقف.</div>`;

  const days = dayRange(isoDay(toDate(a.admitAt)), isoDay(stayEnd(a)));
  const off = (m) => (m.stopDate || medEnded(m) ? 1 : 0);
  const meds = [...P.meds].sort((x, y) => off(x) - off(y) || x.startDate.localeCompare(y.startDate));
  const cell = (m, day) => {
    const end = medEnd(m);
    if (day < m.startDate || (m.stopDate && day > m.stopDate) || (end && day > end)) return `<td></td>`;
    if (m.stopDate === day) return `<td class="c-stop">أوقف</td>`;
    const d = sortedDoses(m).filter((x) => x.from <= day).pop();
    if (!d) return `<td></td>`;
    const changed = d.from === day && day !== m.startDate;
    const dn = m.duration ? `<em>${medDayNo(m, day)}/${m.duration}</em>` : "";
    return `<td class="c-on ${changed ? "c-chg" : ""} ${end === day ? "c-last" : ""}">${esc(d.dose)}<small>${esc(d.frequency)}</small>${dn}</td>`;
  };
  const acts = (m) => {
    if (!add) return "";
    const b = [];
    if (!m.stopDate) b.push(`<button class="linkbtn" data-act="mChange" data-id="${m.id}">${medEnded(m) ? "تمديد" : "تغيير الجرعة"}</button>`,
      `<button class="linkbtn" data-act="mStop" data-id="${m.id}">إيقاف</button>`);
    else if (isAdmin() || (minEdit && m.stopDate >= minEdit)) b.push(`<button class="linkbtn" data-act="mResume" data-id="${m.id}">إلغاء الإيقاف</button>`);
    if (pCanEdit(m.enteredAt)) b.push(`<button class="linkbtn del" data-act="mDel" data-id="${m.id}">حذف</button>`);
    return `<span class="row-acts">${b.join("")}</span>`;
  };
  return head + `
  <div class="table-wrap sheet" data-sheet="meds"><table class="grid meds">
    <thead><tr><th class="stick">الدواء</th>${days.map((d) =>
      `<th class="day-h">${fmtDayShort(d)}<small>اليوم ${stayDayOn(a.admitAt, d)}</small></th>`).join("")}</tr></thead>
    <tbody>${meds.map((m) => {
      const cd = currentDose(m);
      const today = isoDay(new Date());
      const status = m.stopDate ? `متوقف ${fmtDate(m.stopDate)}`
        : medEnded(m) ? `انتهت المدة (${m.duration} يوم) في ${fmtDate(medEnd(m))}`
        : m.duration ? `اليوم ${medDayNo(m, today)} من ${m.duration}، ينتهي ${fmtDate(medEnd(m))}`
        : `مستمر من ${fmtDate(m.startDate)}، اليوم ${medDayNo(m, today)}`;
      return `<tr class="${off(m) ? "stopped" : ""}">
        <th class="stick med-h">
          <strong class="ltr-auto">${esc(m.name)}</strong>
          <span>${esc(m.route)}${cd.frequency ? `، ${esc(cd.frequency)}` : ""}</span>
          <span class="status">${status}</span>
          ${m.note ? `<span class="muted">${esc(m.note)}</span>` : ""}
          ${acts(m)}
        </th>${days.map((d) => cell(m, d)).join("")}</tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

function openMed() {
  const today = isoDay(new Date());
  formDialog("إضافة علاج", `
    <label class="field"><span>اسم الدواء</span><input name="medName" list="dlDrugs" class="ltr" autocomplete="off"></label>
    <div class="row2">
      <label class="field"><span>الجرعة</span><input name="dose" class="ltr" placeholder="1 g"></label>
      <label class="field"><span>طريقة الإعطاء</span><select name="route">${optionsHtml(ROUTES, "")}</select></label>
    </div>
    <div class="row2">
      <label class="field"><span>عدد المرات</span><input name="frequency" list="dlFreq" class="ltr" autocomplete="off"></label>
      ${dateInput("startDate", "يبدأ من يوم", today, isoDay(toDate(S.P.adm.admitAt)))}
    </div>
    <div class="row2">
      <label class="field"><span>المدة بالأيام (اختياري)</span><input name="duration" type="number" min="1" max="365" placeholder="مستمر لحد الإيقاف"></label>
      <label class="field"><span>ملاحظة (اختياري)</span><input name="note"></label>
    </div>`,
    "إضافة العلاج",
    async (f) => {
      const name = f.elements.medName.value.trim(), dose = f.elements.dose.value.trim();
      const route = f.elements.route.value, frequency = f.elements.frequency.value.trim();
      if (!name) return "اكتب اسم الدواء.";
      if (!dose) return "اكتب الجرعة.";
      if (!route) return "اختر طريقة الإعطاء.";
      if (!frequency) return "اكتب عدد المرات.";
      const [start, er] = readDate(f.elements.startDate, isoDay(toDate(S.P.adm.admitAt))); if (er) return er;
      const [duration, der] = readDuration(f.elements.duration); if (der) return der;
      const now = Timestamp.now();
      await addDoc(subRef("meds"), {
        name, route, note: f.elements.note.value.trim(), startDate: start, stopDate: null, duration,
        doses: [{ dose, frequency, from: start, byName: S.profile.displayName }],
        at: now, enteredAt: now, ...meta(),
      });
      toast("تمت إضافة العلاج");
    });
}

function readDuration(input) {
  if (input.value === "") return [null, ""];
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 1 || n > 365) return [null, "المدة لازم تكون رقم صحيح من 1 لـ 365 يوم."];
  return [n, ""];
}

function openMedChange(m) {
  const cd = currentDose(m);
  const minStr = [m.startDate, earliestDateStr()].filter(Boolean).sort().pop();
  formDialog(`تغيير الجرعة أو المدة: ${esc(m.name)}`, `
    <div class="row2">
      <label class="field"><span>الجرعة الجديدة</span><input name="dose" class="ltr" value="${esc(cd.dose || "")}"></label>
      <label class="field"><span>عدد المرات</span><input name="frequency" list="dlFreq" class="ltr" value="${esc(cd.frequency || "")}" autocomplete="off"></label>
    </div>
    <div class="row2">
      ${dateInput("from", "من يوم", isoDay(new Date()), minStr)}
      <label class="field"><span>المدة الكلية بالأيام</span><input name="duration" type="number" min="1" max="365" value="${m.duration || ""}" placeholder="مستمر لحد الإيقاف"></label>
    </div>
    <p class="hint">المدة بتتحسب من أول يوم للدواء (${fmtDate(m.startDate)}). الجرعة القديمة بتفضل ظاهرة في الأيام اللي قبل التغيير.</p>`,
    "حفظ",
    async (f) => {
      const dose = f.elements.dose.value.trim(), frequency = f.elements.frequency.value.trim();
      if (!dose || !frequency) return "اكتب الجرعة وعدد المرات.";
      const [from, er] = readDate(f.elements.from, m.startDate); if (er) return er;
      const [duration, der] = readDuration(f.elements.duration); if (der) return der;
      if (duration && addDays(m.startDate, duration - 1) < from) return "المدة بتخلص قبل تاريخ التغيير. زوّد المدة.";
      const cd2 = currentDose(m);
      const doseChanged = dose !== cd2.dose || frequency !== cd2.frequency;
      const upd = { duration, at: Timestamp.now(), ...upMeta() };
      if (doseChanged) {
        if (!isAdmin() && sortedDoses(m).some((x) => x.from > from)) return "فيه تغيير جرعة مسجل بعد التاريخ ده.";
        const doses = sortedDoses(m).filter((x) => x.from !== from);
        doses.push({ dose, frequency, from, byName: S.profile.displayName });
        upd.doses = doses;
      }
      await pUpd(subRef("meds", m.id), upd);
      toast("تم الحفظ");
    });
}

function openMedStop(m) {
  const minStr = [m.startDate, earliestDateStr()].filter(Boolean).sort().pop();
  formDialog(`إيقاف ${esc(m.name)}`, `
    ${dateInput("stopDate", "تاريخ الإيقاف", isoDay(new Date()), minStr)}
    <label class="field"><span>السبب (اختياري)</span><input name="reason"></label>`,
    "إيقاف العلاج",
    async (f) => {
      const [d, er] = readDate(f.elements.stopDate, m.startDate); if (er) return er;
      await pUpd(subRef("meds", m.id), { stopDate: d, stopReason: f.elements.reason.value.trim(),
        stoppedByName: S.profile.displayName, at: Timestamp.now(), ...upMeta() });
      toast("تم إيقاف العلاج");
    });
}

async function resumeMed(m) {
  if (!confirm(`إلغاء إيقاف ${m.name}؟ العلاج هيرجع مستمر.`)) return;
  try {
    await pUpd(subRef("meds", m.id), { stopDate: null, stopReason: "", at: Timestamp.now(), ...upMeta() });
    toast("تم إلغاء الإيقاف");
  } catch (e) { toast(errText(e), true); }
}

async function deleteMed(m) {
  if (!confirm(`حذف ${m.name} نهائياً من جدول العلاج؟ استخدم الحذف للأخطاء فقط، وللإيقاف استخدم "إيقاف".`)) return;
  try { await pDel(subRef("meds", m.id)); toast("تم الحذف"); } catch (e) { toast(errText(e), true); }
}

/* ---------- تعديل البيانات الأساسية وبيانات الدخول ---------- */

function openEditBasic(a, p) {
  const nb = p.idType === "newborn";
  openDialog(`
  <form class="form" id="basicForm">
    <header class="dlg-head"><h3>تعديل البيانات الأساسية</h3></header>
    ${nb
      ? `<label class="field"><span>اسم الأم</span><input name="motherName" required value="${esc(p.motherName)}"></label>`
      : `<label class="field"><span>اسم المريض</span><input name="name" required value="${esc(p.name)}"></label>`}
    <div class="row2">
      <label class="field"><span>العنوان</span><input name="address" value="${esc(p.address)}"></label>
      <label class="field"><span>رقم التليفون</span><input name="phone" class="ltr" value="${esc(p.phone)}"></label>
    </div>
    <div class="err" id="basicErr"></div>
    <div class="actions"><button class="btn">حفظ التعديل</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("basicForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("basicErr");
    const phone = f.phone.value.trim();
    if (phone && !/^[0-9+\s-]{7,20}$/.test(phone)) { err.textContent = "رقم التليفون غير صحيح."; return; }
    const upd = { address: f.address.value.trim(), phone, updatedAt: serverTimestamp(), updatedBy: S.profile.uid };
    if (nb) {
      upd.motherName = f.motherName.value.trim();
      upd.name = `${p.gender === "male" ? "ابن" : "بنت"} ${upd.motherName}`;
    } else upd.name = f.name.value.trim();
    if (!upd.name) { err.textContent = "الاسم مطلوب."; return; }
    upd.nameKey = nameKey(upd.name);
    try {
      const b = writeBatch(db);
      b.update(doc(db, "patients", a.patientId), upd);
      b.update(doc(db, "admissions", a.id), { patientName: upd.name });
      await b.commit();
      audit("تعديل البيانات الأساسية", { adm: a, before: { name: p.name, address: p.address || "", phone: p.phone || "" } });
      closeDialog(); toast("تم حفظ التعديل");
    } catch (e) { err.textContent = errText(e); }
  };
}

function openEditAdmission(a) {
  const s = S.settings;
  const admin = isAdmin();
  openDialog(`
  <form class="form" id="admEdit">
    <header class="dlg-head"><h3>تعديل بيانات الدخول</h3></header>
    <label class="field"><span>تاريخ ووقت الدخول</span>
      <input name="admitAt" type="datetime-local" value="${toLocalInput(toDate(a.admitAt))}" max="${toLocalInput(new Date())}" ${admin ? "" : "disabled"}>
      ${admin ? "" : `<span class="hint">تعديل تاريخ الدخول للأدمن فقط.</span>`}</label>
    <label class="field"><span>استشاري الحالة</span><select name="consultant">${optionsHtml(s.consultants || [], a.consultant)}</select></label>
    <p class="hint">المعاملة المالية بتتغير من زر "تغيير" جنبها في بيانات الدخول، عشان تتسجل بالتاريخ.</p>
    <div class="field"><span>التخصصات المشتركة</span>${checksHtml("spec", [...new Set([...(s.specialties || []), ...(a.specialties || [])])], a.specialties || [])}</div>
    <div class="err" id="aeErr"></div>
    <div class="actions"><button class="btn">حفظ التعديل</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("admEdit");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("aeErr");
    if (!f.consultant.value) { err.textContent = "اختر استشاري الحالة."; return; }
    const upd = { consultant: f.consultant.value, specialties: checkedValues(f, "spec"),
      updatedAt: serverTimestamp(), updatedBy: S.profile.uid };
    upd.deptAccess = deptAccessOf({ ...a, ...upd });
    if (admin) {
      const d = new Date(f.admitAt.value);
      if (isNaN(d) || d > new Date()) { err.textContent = "تاريخ الدخول غير صحيح."; return; }
      upd.admitAt = Timestamp.fromDate(d);
    }
    try {
      await updateDoc(doc(db, "admissions", a.id), upd);
      audit("تعديل بيانات الدخول", { adm: a, before: { consultant: a.consultant || "",
        specialties: a.specialties || [], admitAt: a.admitAt } });
      closeDialog(); toast("تم حفظ التعديل");
    }
    catch (e) { err.textContent = errText(e); }
  };
}

/* =========================================================
   الإعدادات (أدمن)
   ========================================================= */
function renderSettings(tab) {
  const tabs = [["users", "المستخدمين"], ["units", "وحدات الرعاية"], ["wardunits", "أقسام الداخلي"], ["vitals", "خانات العلامات الحيوية"], ["lists", "القوائم"], ["clinical", "قوائم التشخيص والتاريخ"], ["hospital", "بيانات المستشفى"], ["deptmap", "الاستشاريين والأقسام"], ["audit", "سجل التعديلات"], ["backup", "نسخة احتياطية"]];
  const nav = `<nav class="tabs">${tabs.map(([k, t]) => `<a href="#/settings/${k}" class="${tab === k ? "on" : ""}">${t}</a>`).join("")}</nav>`;
  shell(nav + `<div id="tabBody"><div class="loading">جاري التحميل…</div></div>`);
  const body = document.getElementById("tabBody");
  ({ users: tabUsers, units: tabUnits, wardunits: tabWardUnits, vitals: tabVitalFields, lists: tabLists, clinical: tabClinicalLists, hospital: tabHospital, audit: tabAudit, backup: tabBackup, deptmap: tabDeptMap }[tab] || tabUsers)(body);
}

/* ---------- المستخدمين ---------- */
async function tabUsers(body) {
  let list = [];
  try {
    const snap = await getDocs(collection(db, "users"));
    list = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "ar"));
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }
  const secOf = (u, k) => u.sections?.[k] ?? (k === "icu" ? u.access || "none" : "none");
  const unitNames = (ids) => (ids || []).map((id) => unitById(id)?.name).filter(Boolean).join("، ");
  body.innerHTML = `
  <div class="toolbar"><h2>المستخدمين (${list.length})</h2><button class="btn" id="addUser">إضافة مستخدم</button></div>
  <div class="table-wrap"><table>
    <thead><tr><th>الاسم</th><th>اسم المستخدم</th>${Object.values(SECTIONS).map((l) => `<th>${l}</th>`).join("")}<th>طباعة</th><th>فترة التعديل</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${list.map((u) => `<tr>
      <td>${esc(u.displayName)}${u.role === "admin" ? ` <span class="pill">أدمن</span>` : u.role === "dept" ? ` <span class="pill">قسم ${esc(u.deptSpecialty)}${u.shared ? " (مشترك)" : ""}</span>` : ""}</td>
      <td class="ltr">${esc(u.username)}</td>
      ${Object.keys(SECTIONS).map((k) => `<td>${u.role === "admin" ? "كاملة" : `${levelLabel(secOf(u, k))}${k === "icu" && secOf(u, k) !== "none" ? `<div class="by-line">${esc(unitNames(u.units)) || "بدون وحدات"}</div>` : ""}`}</td>`).join("")}
      <td>${u.role === "admin" || u.print ? "نعم" : "—"}</td>
      <td>${u.role === "admin" ? "مفتوحة" : `${u.editWindowHours || 12} ساعة`}</td>
      <td>${u.active ? "مفعّل" : `<span class="status-off">موقوف</span>`}</td>
      <td><button class="btn ghost sm" data-uid="${u.uid}">تعديل</button></td>
    </tr>`).join("")}</tbody>
  </table></div>
  <p class="muted">لو مستخدم نسي كلمة المرور: أوقف حسابه وأنشئ له حساب جديد باسم مستخدم مختلف. كل مستخدم يقدر يغير كلمة المرور بنفسه من الشريط العلوي.</p>`;
  document.getElementById("addUser").onclick = () => openUserDialog(null, () => tabUsers(body));
  body.querySelectorAll("[data-uid]").forEach((b) => (b.onclick = () =>
    openUserDialog(list.find((u) => u.uid === b.dataset.uid), () => tabUsers(body))));
}

function openUserDialog(u, done) {
  const isNew = !u;
  const self = u?.uid === S.profile.uid;
  u = u || { role: "doctor", sections: { icu: "write", ward: "none", ops: "none" }, units: [], editWindowHours: 12, active: true, print: false };
  const secOf = (k) => u.sections?.[k] ?? (k === "icu" ? u.access || "none" : "none");
  openDialog(`
  <form class="form" id="userForm" novalidate>
    <header class="dlg-head"><h3>${isNew ? "إضافة مستخدم" : "تعديل مستخدم"}</h3>${isNew ? "" : `<p class="ltr">${esc(u.username)}</p>`}</header>
    <label class="field"><span>الاسم (يظهر في النظام)</span><input name="displayName" required value="${esc(u.displayName)}" placeholder="د. …"></label>
    ${isNew ? `<div class="row2">
      <label class="field"><span>اسم المستخدم (إنجليزي)</span><input name="username" class="ltr" autocomplete="off"></label>
      <label class="field"><span>كلمة المرور</span><input name="password" type="text" autocomplete="off" minlength="6"></label>
    </div>` : ""}
    <div class="row2">
      <label class="field"><span>نوع الحساب</span>
        <select name="role" ${self ? "disabled" : ""}><option value="doctor" ${!["admin", "dept"].includes(u.role) ? "selected" : ""}>مستخدم</option><option value="dept" ${u.role === "dept" ? "selected" : ""}>حساب قسم (مشترك)</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>أدمن</option></select></label>
      <label class="field"><span>فترة التعديل في الرعاية</span>
        <select name="editWindowHours"><option value="12" ${u.editWindowHours !== 24 ? "selected" : ""}>12 ساعة (الشيفت الحالي)</option><option value="24" ${u.editWindowHours === 24 ? "selected" : ""}>24 ساعة (الشيفت الحالي واللي قبله)</option></select></label>
    </div>
    <div class="doc-only perm-grid">
      ${Object.entries(SECTIONS).map(([k, l]) => `<div class="field"><span>${l}</span><fieldset class="seg">${Object.entries(levelsFor(k)).map(([lv, ll]) =>
        `<label><input type="radio" name="sec_${k}" value="${lv}" ${secOf(k) === lv ? "checked" : ""}> ${ll}</label>`).join("")}</fieldset></div>`).join("")}
    </div>
    <div class="field doc-only" id="icuUnits"><span>وحدات الرعاية المسموح بيها</span>
      <div class="checks">${units().map((x) => `<label><input type="checkbox" name="units" value="${x.id}" ${(u.units || []).includes(x.id) ? "checked" : ""}> ${esc(x.name)}</label>`).join("")}</div></div>
    <div class="checks doc-only"><label><input type="checkbox" name="print" ${u.print ? "checked" : ""}> صلاحية الطباعة و PDF</label></div>
    <label class="field dept-only"><span>القسم</span><select name="deptSpecialty">${optionsHtml(S.settings.specialties || [], u.deptSpecialty || "")}</select>
      <span class="hint">المستخدم ده بيشوف حالات القسم والإشراف المشترك والعروض بتاعته بس، وبيرد على العروض ويكتب رأيه في الإشراف المشترك. ملوش دخول على أي قسم تاني.</span></label>
    <div class="checks dept-only"><label><input type="checkbox" name="sharedAcc" ${u.shared ? "checked" : ""}> حساب مشترك (أكتر من طبيب بيدخلوا بيه، فبيسأل عن اسم الطبيب كل مرة)</label></div>
    <div class="field not-dept"><span>تخصص المستخدم (عشان توصله طلبات الاستشارة)</span>
      ${checksHtml("uspecs", S.settings.specialties || [], u.specialties || [])}</div>
    ${isNew ? "" : `<div class="checks"><label><input type="checkbox" name="active" ${u.active ? "checked" : ""} ${self ? "disabled" : ""}> الحساب مفعّل</label></div>`}
    <div class="err" id="userErr"></div>
    <div class="actions"><button class="btn">${isNew ? "إضافة المستخدم" : "حفظ التعديل"}</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("userForm");
  const sync = () => {
    f.querySelectorAll(".doc-only").forEach((el) => el.classList.toggle("hidden", f.role.value !== "doctor"));
    f.querySelectorAll(".dept-only").forEach((el) => el.classList.toggle("hidden", f.role.value !== "dept"));
    f.querySelectorAll(".not-dept").forEach((el) => el.classList.toggle("hidden", f.role.value === "dept"));
    if (f.role.value === "doctor") document.getElementById("icuUnits").classList.toggle("hidden", f.querySelector('input[name="sec_icu"]:checked').value === "none");
  };
  f.role.onchange = sync;
  f.querySelectorAll('input[name="sec_icu"]').forEach((r) => (r.onchange = sync));
  sync();

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("userErr");
    err.textContent = "";
    const role = self ? "admin" : f.role.value;
    const sections = Object.fromEntries(Object.keys(SECTIONS).map((k) => [k, role === "admin" ? "write" : role === "dept" ? "none" : f.querySelector(`input[name="sec_${k}"]:checked`).value]));
    const data = {
      displayName: f.displayName.value.trim(), role, sections,
      access: ["none", "nurse"].includes(sections.icu) ? "read" : sections.icu,
      units: role === "admin" || sections.icu === "none" ? [] : checkedValues(f, "units"),
      print: role === "admin" ? true : role === "dept" ? false : f.print.checked,
      shared: role === "dept" ? f.elements.sharedAcc.checked : false,
      specialties: role === "dept" ? [f.deptSpecialty.value].filter(Boolean) : checkedValues(f, "uspecs").slice(0, 10),
      deptSpecialty: role === "dept" ? f.deptSpecialty.value : "",
      editWindowHours: Number(f.editWindowHours.value),
    };
    if (!data.displayName) { err.textContent = "اكتب اسم المستخدم الظاهر."; return; }
    if (role === "dept" && !data.deptSpecialty) { err.textContent = "اختر القسم."; return; }
    if (role === "doctor" && Object.values(sections).every((x) => x === "none")) { err.textContent = "اختر قسم واحد على الأقل."; return; }
    if (role !== "admin" && sections.icu !== "none" && !data.units.length) { err.textContent = "اختر وحدة رعاية واحدة على الأقل."; return; }
    const btn = f.querySelector("button.btn"); btn.disabled = true;
    try {
      if (isNew) {
        const username = f.username.value.trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw { message: "اسم المستخدم لازم يكون حروف إنجليزي وأرقام فقط (3 حروف على الأقل)." };
        if (f.password.value.length < 6) throw { code: "auth/weak-password" };
        const sa = secondaryAuth();
        const cred = await createUserWithEmailAndPassword(sa, `${username}@${USER_EMAIL_DOMAIN}`, f.password.value);
        await setDoc(doc(db, "users", cred.user.uid), { ...data, username, active: true, createdAt: serverTimestamp(), createdBy: S.profile.uid });
        await signOut(sa);
        toast(`تمت إضافة ${data.displayName}`);
      } else {
        data.active = self ? true : f.active.checked;
        data.updatedAt = serverTimestamp();
        await updateDoc(doc(db, "users", u.uid), data);
        toast("تم حفظ التعديل");
      }
      closeDialog(); done();
    } catch (e) {
      err.textContent = e.code ? errText(e) : e.message;
      btn.disabled = false;
    }
  };
}

/* ---------- الوحدات ---------- */
function tabUnits(body) {
  let rows = units().map((u) => ({ ...u }));
  const occupiedMax = (id) => Math.max(0, ...(S.adm[id] || []).map((a) => a.bed));
  const occCount = (id) => (S.adm[id] || []).length;
  const draw = () => {
    body.innerHTML = `
    <div class="toolbar"><h2>الوحدات والأسرّة</h2><button class="btn ghost" id="addUnit">إضافة وحدة</button></div>
    <div class="table-wrap"><table class="units-edit">
      <thead><tr><th>اسم الوحدة</th><th>عدد الأسرّة</th><th>تسمية السرير</th><th>وحدة مواليد</th><th>مشغول حالياً</th><th></th></tr></thead>
      <tbody>${rows.map((u, i) => `<tr>
        <td><input data-i="${i}" data-k="name" value="${esc(u.name)}"></td>
        <td><input data-i="${i}" data-k="beds" type="number" min="1" max="200" value="${u.beds}"></td>
        <td><select data-i="${i}" data-k="bedLabel"><option ${u.bedLabel === "سرير" ? "selected" : ""}>سرير</option><option ${u.bedLabel === "حضانة" ? "selected" : ""}>حضانة</option></select></td>
        <td><input data-i="${i}" data-k="newborn" type="checkbox" ${u.newborn ? "checked" : ""} title="الدخول الافتراضي ببيانات الأم"></td>
        <td>${occCount(u.id)}</td>
        <td>${occCount(u.id) ? "" : `<button class="btn ghost sm" data-del="${i}">حذف</button>`}</td>
      </tr>`).join("")}</tbody>
    </table></div>
    <div class="err" id="unitsErr" style="margin-top:12px"></div>
    <div class="actions" style="margin-top:12px"><button class="btn" id="saveUnits">حفظ الوحدات</button></div>`;
    body.querySelectorAll("[data-k]").forEach((el) => (el.onchange = () => {
      const r = rows[el.dataset.i];
      r[el.dataset.k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
    }));
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { rows.splice(Number(b.dataset.del), 1); draw(); }));
    document.getElementById("addUnit").onclick = () => {
      rows.push({ id: "u" + Date.now().toString(36), name: "وحدة جديدة", beds: 4, bedLabel: "سرير", newborn: false });
      draw();
    };
    document.getElementById("saveUnits").onclick = async () => {
      const err = document.getElementById("unitsErr");
      err.textContent = "";
      for (const u of rows) {
        u.name = String(u.name || "").trim();
        if (!u.name) { err.textContent = "كل وحدة لازم يكون ليها اسم."; return; }
        if (!Number.isInteger(u.beds) || u.beds < 1) { err.textContent = `عدد الأسرّة في "${u.name}" غير صحيح.`; return; }
        if (u.beds < occupiedMax(u.id)) { err.textContent = `مينفعش تقلل أسرّة "${u.name}" لأقل من ${occupiedMax(u.id)}، لأن السرير ده مشغول.`; return; }
      }
      try { await updateDoc(doc(db, "config", "settings"), { units: rows }); toast("تم حفظ الوحدات"); }
      catch (e) { err.textContent = errText(e); }
    };
  };
  draw();
}


/* ---------- خانات العلامات الحيوية ---------- */
function tabVitalFields(body, unitId) {
  const list = units();
  const u = list.find((x) => x.id === unitId) || list[0];
  if (!u) { body.innerHTML = `<div class="empty">لا يوجد وحدات.</div>`; return; }
  let rows = unitVitals(u).map((f) => ({ ...f }));
  const draw = () => {
    body.innerHTML = `
    <div class="unit-bar">${list.map((x) => `<button class="chip ${x.id === u.id ? "on" : ""}" data-unit="${x.id}">${esc(x.name)}</button>`).join("")}</div>
    <div class="toolbar"><h2>خانات العلامات الحيوية: ${esc(u.name)}</h2><button class="btn ghost" id="addField">إضافة خانة</button></div>
    <div class="table-wrap"><table class="units-edit">
      <thead><tr><th>الخانة</th><th>الوحدة (Unit)</th><th>اللون</th><th>الترتيب</th><th></th></tr></thead>
      <tbody>${rows.map((f, i) => `<tr>
        <td><input data-i="${i}" data-k="label" value="${esc(f.label)}"></td>
        <td><input data-i="${i}" data-k="unit" value="${esc(f.unit)}" class="ltr" style="width:110px"></td>
        <td><div class="swatches" role="radiogroup" aria-label="لون الخانة">${Object.entries(VCOLORS).map(([k, c]) =>
          `<button type="button" class="sw ${(f.color || "") === k ? "on" : ""}" data-sw="${i}" data-c="${k}" title="${c.name}" aria-label="${c.name}"
            style="background:${c.bg || "#fff"}">${k ? "" : "∅"}</button>`).join("")}</div></td>
        <td class="nowrap"><button class="btn ghost sm" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="لفوق">▲</button>
          <button class="btn ghost sm" data-down="${i}" ${i === rows.length - 1 ? "disabled" : ""} aria-label="لتحت">▼</button></td>
        <td><button class="btn ghost sm" data-del="${i}">حذف</button></td></tr>`).join("")}</tbody>
    </table></div>
    <p class="muted">حذف خانة بيخفيها من الجدول بس، والقراءات القديمة بتفضل محفوظة. الخانات دي خاصة بالوحدة دي لوحدها.</p>
    <div class="err" id="vfErr"></div>
    <div class="actions"><button class="btn" id="saveFields">حفظ الخانات</button></div>`;
    body.querySelectorAll("[data-unit]").forEach((b) => (b.onclick = () => tabVitalFields(body, b.dataset.unit)));
    body.querySelectorAll("[data-k]").forEach((el) => (el.oninput = () => (rows[el.dataset.i][el.dataset.k] = el.value)));
    body.querySelectorAll("[data-sw]").forEach((b) => (b.onclick = () => { rows[b.dataset.sw].color = b.dataset.c; draw(); }));
    const move = (i, j) => { [rows[i], rows[j]] = [rows[j], rows[i]]; draw(); };
    body.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)));
    body.querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1)));
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { rows.splice(+b.dataset.del, 1); draw(); }));
    document.getElementById("addField").onclick = () => { rows.push({ key: "f" + Date.now().toString(36), label: "", unit: "" }); draw(); };
    document.getElementById("saveFields").onclick = async () => {
      const err = document.getElementById("vfErr");
      rows = rows.map((f) => ({ key: f.key, label: String(f.label || "").trim(), unit: String(f.unit || "").trim(), color: f.color || "" }));
      if (!rows.length) { err.textContent = "لازم خانة واحدة على الأقل."; return; }
      if (rows.some((f) => !f.label)) { err.textContent = "كل خانة لازم يكون ليها اسم."; return; }
      const updated = units().map((x) => (x.id === u.id ? { ...x, vitals: rows } : x));
      try { await updateDoc(doc(db, "config", "settings"), { units: updated }); toast("تم حفظ الخانات"); }
      catch (e) { err.textContent = errText(e); }
    };
  };
  draw();
}

/* ---------- القوائم ---------- */
function tabLists(body) {
  listsEditor(body, [["financeTypes", "المعاملة المالية", "مثال: تعاقد شركة"], ["consultants", "الاستشاريين", "مثال: د. أحمد محمود"],
    ["anesthesiaConsultants", "استشاريين التخدير", "مثال: د. …"], ["operations", "العمليات الشائعة", "مثال: ORIF"],
    ["specialties", "التخصصات المشتركة", "مثال: باطنة"], ["investigations", "التحاليل والأشعة الشائعة", "مثال: CBC"],
    ["drugs", "الأدوية الشائعة", "مثال: Ceftriaxone"]], tabLists);
}
const HIST_OPT_FIELDS = ["complaint", "pmh", "psh", "drugs", "allergy"];
function tabClinicalLists(body) {
  listsEditor(body, [["diagnoses", "التشخيصات", "مثال: Acute MI"],
    ...HIST_OPT_FIELDS.map((k) => [`historyOptions.${k}`, `التاريخ المرضي: ${HISTORY_FIELDS.find(([x]) => x === k)[1]}`, "اكتب واضغط إضافة"]),
    ["reportOptions.done", "التقرير الطبي: ما تم", "مثال: تم عمل أشعة مقطعية"], ["reportOptions.required", "التقرير الطبي: مطلوب", "مثال: متابعة بالعيادة"]], tabClinicalLists);
}
function listsEditor(body, blocks, redraw) {
  const block = (key, title, ph) => `
    <div class="settings-block">
      <div class="toolbar"><h2>${title}</h2></div>
      <div class="list-editor">
        <form class="add" data-key="${key}"><input placeholder="${ph}" required><button class="btn">إضافة</button></form>
        <div class="list-items">${listOf(key).map((x, i) =>
          `<span>${esc(x)}<button type="button" data-key="${key}" data-i="${i}" aria-label="حذف ${esc(x)}">×</button></span>`).join("")
          || `<span class="muted" style="border:0;background:none">القائمة فاضية</span>`}</div>
      </div>
    </div>`;
  body.innerHTML = blocks.map(([k, t, ph]) => block(k, t, ph)).join("");
  const save = async (key, arr) => {
    try { await updateDoc(doc(db, "config", "settings"), { [key]: arr }); redraw(body); }
    catch (e) { toast(errText(e), true); }
  };
  body.querySelectorAll("form.add").forEach((f) => (f.onsubmit = (ev) => {
    ev.preventDefault();
    const v = f.querySelector("input").value.trim();
    const arr = [...listOf(f.dataset.key)];
    if (!v) return;
    if (arr.includes(v)) { toast("موجود بالفعل في القائمة", true); return; }
    arr.push(v);
    save(f.dataset.key, arr);
  }));
  body.querySelectorAll(".list-items button").forEach((b) => (b.onclick = () => {
    const arr = [...listOf(b.dataset.key)];
    arr.splice(Number(b.dataset.i), 1);
    save(b.dataset.key, arr);
  }));
}

/* ---------- بيانات المستشفى ---------- */
function tabHospital(body) {
  let logo = S.settings.logo || "";
  const draw = () => {
    body.innerHTML = `
    <form class="form" id="hospForm" style="max-width:560px">
      <label class="field"><span>اسم المستشفى</span><input name="hospitalName" required value="${esc(S.settings.hospitalName)}"></label>
      <div class="field"><span>اللوجو</span>
        <div class="logo-preview">
          ${logo ? `<img src="${logo}" alt="اللوجو الحالي">` : `<span class="muted">لا يوجد لوجو</span>`}
          <label class="btn ghost sm">اختيار صورة<input type="file" accept="image/*" name="logoFile" hidden></label>
          ${logo ? `<button type="button" class="btn ghost sm" id="rmLogo">إزالة</button>` : ""}
        </div>
        <span class="hint">اللوجو هيظهر في الشريط العلوي، وهيبقى اختياري في الطباعة (المرحلة 4).</span></div>
      <div class="err" id="hospErr"></div>
      <div class="actions"><button class="btn">حفظ بيانات المستشفى</button></div>
    </form>`;
    const f = document.getElementById("hospForm");
    f.logoFile.onchange = async () => {
      const file = f.logoFile.files[0];
      if (!file) return;
      try { logo = await resizeImage(file, 320); draw(); }
      catch { document.getElementById("hospErr").textContent = "تعذر قراءة الصورة."; }
    };
    document.getElementById("rmLogo")?.addEventListener("click", () => { logo = ""; draw(); });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        await updateDoc(doc(db, "config", "settings"), { hospitalName: f.hospitalName.value.trim(), logo });
        toast("تم حفظ بيانات المستشفى");
      } catch (e) { document.getElementById("hospErr").textContent = errText(e); }
    };
  };
  draw();
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const r = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* =========================================================
   المرحلة 3: النقل والخروج والأرشيف وسجل التعديلات
   ========================================================= */
const DIS_TYPES = { improved: "تحسن", death: "وفاة", ward: "تحويل للداخلي", transfer: "تحويل لمستشفى أخرى", escape: "هروب", request: "خروج حسب الطلب" };
const stayEnd = (a) => (a.status === "discharged" && a.dischargeAt ? toDate(a.dischargeAt) : new Date());
function stayDays(a) {
  const s = toDate(a.admitAt), e = stayEnd(a);
  if (!s) return 0;
  const s0 = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const e0 = new Date(e.getFullYear(), e.getMonth(), e.getDate());
  return Math.round((e0 - s0) / 86400000) + 1;
}
const unitName = (id) => unitById(id)?.name || id;

// المعاملة المالية بالتاريخ: [{type, from}] وكل يوم إقامة بياخد المعاملة السارية فيه
function finHist(a) {
  if (a.financeHistory?.length) return [...a.financeHistory].sort((x, y) => x.from.localeCompare(y.from));
  return a.finance ? [{ type: a.finance, from: isoDay(toDate(a.admitAt)) }] : [];
}
function finOn(a, day) {
  const h = finHist(a);
  return (h.filter((x) => x.from <= day).pop() || h[0])?.type || "غير محدد";
}
function finBreakdown(a, fromDay, toDay) {
  let s0 = isoDay(toDate(a.admitAt)), e0 = isoDay(stayEnd(a));
  if (fromDay && fromDay > s0) s0 = fromDay;
  if (toDay && toDay < e0) e0 = toDay;
  const out = {};
  if (s0 > e0) return out;
  dayRange(s0, e0).forEach((d) => { const t = finOn(a, d); out[t] = (out[t] || 0) + 1; });
  return out;
}
const finText = (b) => Object.entries(b).map(([k, n]) => `${k} ${n === 1 ? "يوم" : n === 2 ? "يومين" : n <= 10 ? n + " أيام" : n + " يوم"}`).join("، ") || "—";
const bedName = (unitId, bed) => `${unitById(unitId)?.bedLabel || "سرير"} ${bed}`;

/* ---------- سجل التعديلات ---------- */
function audit(action, extra = {}) {
  const a = extra.adm || S.P?.adm;
  const rec = {
    at: serverTimestamp(), uid: S.profile.uid, name: S.profile.displayName, action,
    admissionId: a?.id || "", patientName: a?.patientName || "", unitId: a?.unitId || "",
  };
  if (extra.before) { const { id, ...rest } = extra.before; rec.before = rest; }
  if (extra.details) rec.details = extra.details;
  addDoc(collection(db, "audit"), rec).catch((e) => console.error("audit", e));
}
const KIND_LABEL = { status: "الحالة السريرية", history: "التاريخ المرضي", diagnosis: "تشخيص", consult: "رأي تخصص", investigation: "طلب أشعة/تحاليل" };
function recLabel(col, old) {
  if (col === "vitals") return "قراءة علامات حيوية";
  if (col === "meds") return `علاج ${old?.name || ""}`;
  return KIND_LABEL[old?.kind] || "سجل";
}
const oldRec = (col, id) => (S.P?.[col] || []).find((x) => x.id === id);
async function pUpd(ref, data) {
  const col = ref.parent.id, old = oldRec(col, ref.id);
  await updateDoc(ref, data);
  audit(`تعديل ${recLabel(col, old)}`, { before: old });
}
async function pDel(ref) {
  const col = ref.parent.id, old = oldRec(col, ref.id);
  await deleteDoc(ref);
  audit(`حذف ${recLabel(col, old)}`, { before: old });
}

/* ---------- إضافات تبويب البيانات ---------- */
function ptInfoExtra() {
  const P = S.P, a = P.adm;
  let html = "";
  if (a.status === "discharged") {
    const i = a.dischargeInfo || {};
    html += `
    <section class="panel dis-panel t-${a.dischargeType}">
      <header><h2>بيانات الخروج</h2><button class="btn ghost sm" data-act="dsum">${a.dischargeType === "death" ? "تقرير الوفاة" : "تقرير الخروج"}</button></header>
      <dl class="kv">
        <dt>نوع الخروج</dt><dd><strong>${DIS_TYPES[a.dischargeType] || ""}</strong></dd>
        <dt>${a.dischargeType === "death" ? "وقت الوفاة" : "وقت الخروج"}</dt><dd>${fmtDateTime(a.dischargeAt)}</dd>
        <dt>أيام الإقامة</dt><dd>${stayDays(a)} يوم</dd>
        <dt>المعاملة المالية</dt><dd>${esc(finText(finBreakdown(a)))}</dd>
        ${i.deathCause ? `<dt>سبب الوفاة</dt><dd>${pre(i.deathCause)}</dd>` : ""}
        ${i.ward ? `<dt>القسم الداخلي</dt><dd>${esc(i.ward)}</dd>` : ""}
        ${i.hospital ? `<dt>المستشفى</dt><dd>${esc(i.hospital)}</dd>` : ""}
        ${i.reason ? `<dt>سبب التحويل</dt><dd>${pre(i.reason)}</dd>` : ""}
        ${i.notes ? `<dt>ملاحظات</dt><dd>${pre(i.notes)}</dd>` : ""}
        <dt>سجّل الخروج</dt><dd>${esc(a.dischargedByName)}</dd>
      </dl>
    </section>`;
  }
  if (a.moves?.length) {
    html += `
    <section class="panel">
      <header><h2>سجل النقل</h2></header>
      <ul class="entries">${[...a.moves].sort((x, y) => toDate(x.at) - toDate(y.at)).map((m) => `
        <li><div class="entry-head"><strong>${esc(unitName(m.fromUnit))}، ${esc(bedName(m.fromUnit, m.fromBed))}</strong>
          <span aria-hidden="true">←</span><strong>${esc(unitName(m.toUnit))}، ${esc(bedName(m.toUnit, m.toBed))}</strong>
          <span class="by-line">${fmtDateTime(m.at)}، ${esc(m.byName)}</span></div>
          ${m.reason ? `<p>${esc(m.reason)}</p>` : ""}</li>`).join("")}</ul>
    </section>`;
  }
  return html ? `<div class="stack">${html}</div>` : "";
}

async function loadPrevAdmissions() {
  const P = S.P;
  try {
    const qs = [getDocs(query(collection(db, "admissions"), where("patientId", "==", P.adm.patientId)))];
    if (P.adm.nationalId) qs.push(getDocs(query(collection(db, "admissions"), where("nationalId", "==", P.adm.nationalId))));
    const found = new Map();
    (await Promise.all(qs)).forEach((snap) => snap.docs.forEach((d) => found.set(d.id, { id: d.id, ...d.data() })));
    P.prev = [...found.values()].filter((x) => x.id !== P.adm.id).sort((x, y) => toDate(y.admitAt) - toDate(x.admitAt));
  } catch (e) { P.prev = []; P.prevErr = errText(e); }
  if (S.P === P) drawPatient();
}

function visitsHtml(a, p) {
  const P = S.P;
  if (!isAdmin()) {
    const v = p.admissionsCount || 1;
    return `<div class="visits ${v > 1 ? "repeat" : ""}"><span class="visits-icon" aria-hidden="true">${v}</span>
      <span>${v > 1 ? `دخل الرعاية ${v} مرات، وده الدخول رقم ${a.admissionNo || v}` : "أول دخول للرعاية"}</span></div>`;
  }
  if (P.prev === undefined && !P.prevLoading) { P.prevLoading = true; loadPrevAdmissions(); }
  const list = P.prev || [];
  const v = Math.max(p.admissionsCount || 1, list.length + 1);
  return `<div class="visits ${v > 1 ? "repeat" : ""}"><span class="visits-icon" aria-hidden="true">${v}</span>
      <span>${v > 1 ? `دخل الرعاية ${v} مرات` : "أول دخول للرعاية"}</span></div>
    ${P.prev === undefined ? `<p class="by-line">جاري تحميل الدخولات السابقة…</p>` : ""}
    ${P.prevErr ? `<p class="err">${esc(P.prevErr)}</p>` : ""}
    ${list.length ? `<ul class="prev-list">${list.map((x) => `
      <li><a href="#/patient/${x.id}">
        <strong>${fmtDate(x.admitAt)}</strong>
        <span>${esc(unitName(x.unitId))}</span>
        <span class="dis t-${x.status === "active" ? "improved" : x.dischargeType}">${x.status === "active" ? "موجود حالياً" : DIS_TYPES[x.dischargeType] || "خرج"}</span>
        <span class="by-line">${stayDays(x)} يوم</span>
      </a></li>`).join("")}</ul>` : ""}`;
}

function finInfoHtml(a, canW) {
  const h = finHist(a);
  if (!h.length) return `— ${canW ? `<button class="linkbtn" data-act="finChange">تحديد</button>` : ""}`;
  const b = finBreakdown(a);
  return `<strong>${esc(h[h.length - 1].type)}</strong>
    ${canW ? `<button class="linkbtn" data-act="finChange">تغيير</button>` : ""}
    <div class="fin-days">${esc(finText(b))}</div>
    ${h.length > 1 ? `<ul class="fin-tl">${h.map((x, i) => `<li>من ${fmtDate(x.from)}: ${esc(x.type)}
      ${isAdmin() && i > 0 ? `<button class="linkbtn del" data-act="finDel" data-from="${x.from}" aria-label="حذف">حذف</button>` : ""}</li>`).join("")}</ul>` : ""}`;
}

function openFinanceChange(a = S.P.adm, col = "admissions") {
  const admitDay = isoDay(toDate(a.admitAt));
  const cur = finHist(a).pop()?.type || "";
  formDialog("تغيير المعاملة المالية", `
    <label class="field"><span>المعاملة الجديدة</span><select name="ftype">${optionsHtml(listOf("financeTypes"), cur)}</select></label>
    ${dateInput("from", "تبدأ من يوم", isoDay(new Date()), admitDay)}
    <p class="hint">الأيام اللي قبل التاريخ ده بتفضل على المعاملة القديمة، وتقرير الخروج بيحسب عدد أيام كل معاملة.</p>`,
    "حفظ المعاملة",
    async (f) => {
      const type = f.elements.ftype.value;
      if (!type) return "اختر المعاملة المالية.";
      const [from, er] = readDate(f.elements.from, admitDay); if (er) return er;
      if (a.status === "discharged" && from > isoDay(stayEnd(a))) return "التاريخ بعد يوم الخروج.";
      const hist = finHist(a).filter((x) => x.from !== from);
      hist.push({ type, from, byName: S.profile.displayName });
      hist.sort((x, y) => x.from.localeCompare(y.from));
      await updateDoc(doc(db, col, a.id), { financeHistory: hist, finance: hist[hist.length - 1].type, ...upMeta() });
      audit(`تغيير المعاملة المالية إلى ${type}`, { adm: a, details: { from }, before: { financeHistory: finHist(a) } });
      toast("تم حفظ المعاملة المالية");
    });
}

async function deleteFinance(from, a = S.P.adm, col = "admissions") {
  if (!confirm(`حذف تغيير المعاملة المالية من يوم ${fmtDate(from)}؟`)) return;
  const hist = finHist(a).filter((x) => x.from !== from);
  try {
    await updateDoc(doc(db, col, a.id), { financeHistory: hist, finance: hist[hist.length - 1].type, ...upMeta() });
    audit("حذف تغيير المعاملة المالية", { adm: a, before: { financeHistory: finHist(a) } });
    toast("تم الحذف");
  } catch (e) { toast(errText(e), true); }
}

/* ---------- الخروج ---------- */
function openDischarge() {
  const a = S.P.adm;
  const f = formDialog(`خروج: ${esc(a.patientName)}`, `
    <fieldset class="seg seg-wrap">${Object.entries(DIS_TYPES).map(([k, l], i) =>
      `<label><input type="radio" name="dtype" value="${k}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    ${timeInput("at", "وقت الخروج")}
    <label class="field df d-death"><span>سبب الوفاة</span><textarea name="deathCause" rows="2" class="ltr-auto"></textarea></label>
    ${wardUnits().length ? `<div class="row2 df d-ward"><label class="field"><span>قسم الداخلي</span><select name="wdept"></select></label>
      <label class="field"><span>السرير</span><select name="wbed"></select></label></div>
      <label class="field df d-ward"><span>القسم المسؤول عن الحالة في الداخلي</span><select name="wresp">${optionsHtml(S.settings.specialties || [], respOf(a.consultant))}</select></label>
      <p class="hint df d-ward">هيتسجل دخول داخلي تلقائي على السرير ده، بنفس الاستشاري والمعاملة المالية وآخر تشخيص.</p>`
      : `<label class="field df d-ward"><span>القسم الداخلي المحول إليه</span><input name="ward"></label>`}
    <label class="field df d-transfer"><span>اسم المستشفى</span><input name="hospital"></label>
    <label class="field df d-transfer"><span>سبب التحويل</span><textarea name="reason" rows="2"></textarea></label>
    <label class="field"><span>ملاحظات (اختياري)</span><textarea name="notes" rows="2"></textarea></label>
    <div class="checks"><label><input type="checkbox" name="writeDs" checked> اكتب تقرير الخروج (أو الوفاة) بعد التأكيد</label></div>
    <p class="note">بعد الخروج الملف بيتنقل للأرشيف والسرير بيفضى، والملف مش هيظهر غير للأدمن.</p>`,
    "تأكيد الخروج",
    async (f) => {
      const type = f.querySelector('input[name="dtype"]:checked').value;
      const [at, er] = readTime(f.elements.at); if (er) return er;
      if (at < toDate(a.admitAt)) return "وقت الخروج لازم يكون بعد وقت الدخول.";
      const info = { notes: f.elements.notes.value.trim() };
      if (type === "death") { info.deathCause = f.elements.deathCause.value.trim(); if (!info.deathCause) return "اكتب سبب الوفاة."; }
      let toWard = null;
      if (type === "ward" && wardUnits().length) {
        toWard = { dept: f.elements.wdept.value, bed: Number(f.elements.wbed.value), resp: f.elements.wresp.value };
        if (!toWard.dept || !toWard.bed) return "اختر قسم الداخلي والسرير.";
        if ((S.settings.specialties || []).length && !toWard.resp) return "اختر القسم المسؤول عن الحالة في الداخلي.";
        info.ward = `${wardById(toWard.dept)?.name || ""}، سرير ${toWard.bed}`;
      } else if (type === "ward") { info.ward = f.elements.ward.value.trim(); if (!info.ward) return "اكتب القسم الداخلي."; }
      const lastDx = S.P.entries.filter((e) => e.kind === "diagnosis").sort(desc)[0]?.text || "";
      const dsCtx = f.elements.writeDs.checked ? await buildDischargeContext("icu") : null;
      const wRef = doc(collection(db, "wardAdmissions"));
      if (type === "transfer") {
        info.hospital = f.elements.hospital.value.trim(); info.reason = f.elements.reason.value.trim();
        if (!info.hospital) return "اكتب اسم المستشفى.";
      }
      const aRef = doc(db, "admissions", a.id);
      const pRef = doc(db, "patients", a.patientId);
      await runTransaction(db, async (tx) => {
        const aSnap = await tx.get(aRef);
        const cur = aSnap.data();
        if (cur.status !== "active") throw new Error("ALREADY_OUT");
        const bedRef = doc(db, "beds", `${cur.unitId}_${cur.bed}`);
        const bSnap = await tx.get(bedRef);
        const pSnap = await tx.get(pRef);
        let wBed;
        if (toWard) {
          wBed = doc(db, "beds", `${toWard.dept}_${toWard.bed}`);
          if ((await tx.get(wBed)).exists()) throw new Error("BED_TAKEN");
        }
        tx.update(aRef, {
          status: "discharged", dischargeAt: Timestamp.fromDate(at), dischargeType: type, dischargeInfo: info, deptAccess: [],
          dischargedBy: S.profile.uid, dischargedByName: S.profile.displayName, ...upMeta(),
          ...(toWard ? { wardAdmissionId: wRef.id } : {}),
        });
        if (bSnap.exists() && bSnap.data().admissionId === a.id) tx.delete(bedRef);
        const pUpd = {};
        if (pSnap.exists() && pSnap.data().currentAdmissionId === a.id) Object.assign(pUpd, { currentAdmissionId: null, lastDischargeAt: Timestamp.fromDate(at) });
        if (pSnap.exists()) pUpd.visits = visitsAfterDischarge(pSnap.data(), a.id, at, type);
        if (toWard) {
          const pd = pSnap.data();
          const n = (pd.wardCount || 0) + 1;
          tx.set(wBed, { unitId: toWard.dept, bed: toWard.bed, admissionId: wRef.id, section: "ward", since: serverTimestamp() });
          tx.set(wRef, wardAdmissionData({ id: a.patientId, ...pd }, toWard.dept, toWard.bed, at,
            { consultant: a.consultant, responsible: toWard.resp, finance: finHist(a).pop()?.type || a.finance || "", specialties: a.specialties || [], diagnosis: lastDx },
            n, pd.medicalId, { source: "icu", sourceId: a.id }));
          Object.assign(pUpd, { currentWardId: wRef.id, wardCount: (pd.wardCount || 0) + 1 });
          pUpd.visits.push(visitEntry("ward", wRef.id, `${pd.medicalId || ""}-D${n}`, Timestamp.fromDate(at), wardById(toWard.dept)?.name));
        }
        if (Object.keys(pUpd).length) tx.update(pRef, pUpd);
      });
      audit(`خروج: ${DIS_TYPES[type]}`, { adm: a, details: info });
      toast(`تم تسجيل الخروج (${DIS_TYPES[type]})`);
      const go = () => {
        if (toWard) location.hash = canSee("ward") ? `#/w/${wRef.id}` : `#/unit/${a.unitId}`;
        else if (!isAdmin()) location.hash = `#/unit/${a.unitId}`;
      };
      setTimeout(() => { go(); if (dsCtx) openDischargeSummary({ ...dsCtx, dis: { at: Timestamp.fromDate(at), type, info } }); }, 0);
    });
  const sync = () => (f.dataset.dtype = f.querySelector('input[name="dtype"]:checked').value);
  f.querySelectorAll('input[name="dtype"]').forEach((r) => (r.onchange = sync));
  sync();
  if (f.elements.wdept) bedOccupancy().then((occ) => {
    const free = (u) => Array.from({ length: u.beds }, (_, i) => i + 1).filter((n) => !occ[u.id]?.has(n));
    f.elements.wdept.innerHTML = wardUnits().filter((u) => free(u).length).map((u) => `<option value="${u.id}">${esc(u.name)} (${free(u).length} فاضي)</option>`).join("");
    const fill = () => { const u = wardById(f.elements.wdept.value); f.elements.wbed.innerHTML = u ? free(u).map((n) => `<option value="${n}">سرير ${n}</option>`).join("") : ""; };
    f.elements.wdept.onchange = fill; fill();
  }).catch(() => {});
}

/* ---------- النقل بين الوحدات ---------- */
async function openTransfer() {
  const a = S.P.adm;
  const occ = {};
  try {
    const snap = await getDocs(collection(db, "beds"));
    snap.forEach((d) => { const x = d.data(); (occ[x.unitId] ||= new Set()).add(x.bed); });
  } catch (e) { toast(errText(e), true); return; }
  const freeBeds = (u) => Array.from({ length: u.beds }, (_, i) => i + 1).filter((n) => !occ[u.id]?.has(n));
  const opts = units().filter((u) => freeBeds(u).length);
  if (!opts.length) { toast("مفيش أي سرير فاضي في الوحدات.", true); return; }

  const f = formDialog(`نقل: ${esc(a.patientName)}`, `
    <p class="muted" style="margin:0">حالياً في ${esc(unitName(a.unitId))}، ${esc(bedName(a.unitId, a.bed))}</p>
    <div class="row2">
      <label class="field"><span>الوحدة</span><select name="unit">${opts.map((u) =>
        `<option value="${u.id}" ${u.id === a.unitId ? "selected" : ""}>${esc(u.name)} (${freeBeds(u).length} فاضي)</option>`).join("")}</select></label>
      <label class="field"><span>السرير</span><select name="bed"></select></label>
    </div>
    ${timeInput("at", "وقت النقل")}
    <label class="field"><span>السبب (اختياري)</span><input name="reason"></label>
    <div class="note" id="trNote"></div>`,
    "تأكيد النقل",
    async (f) => {
      const toUnit = f.elements.unit.value, toBed = Number(f.elements.bed.value);
      if (!toUnit || !toBed) return "اختر الوحدة والسرير.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      if (at < toDate(a.admitAt)) return "وقت النقل لازم يكون بعد وقت الدخول.";
      const aRef = doc(db, "admissions", a.id);
      const newBed = doc(db, "beds", `${toUnit}_${toBed}`);
      await runTransaction(db, async (tx) => {
        const cur = (await tx.get(aRef)).data();
        if (cur.status !== "active") throw new Error("ALREADY_OUT");
        const oldBed = doc(db, "beds", `${cur.unitId}_${cur.bed}`);
        const nb = await tx.get(newBed);
        if (nb.exists()) throw new Error("BED_TAKEN");
        const ob = await tx.get(oldBed);
        if (ob.exists() && ob.data().admissionId === a.id) tx.delete(oldBed);
        tx.set(newBed, { unitId: toUnit, bed: toBed, admissionId: a.id, since: serverTimestamp() });
        tx.update(aRef, {
          unitId: toUnit, bed: toBed, ...upMeta(),
          moves: arrayUnion({ fromUnit: cur.unitId, fromBed: cur.bed, toUnit, toBed, at: Timestamp.fromDate(at),
            byName: S.profile.displayName, reason: f.elements.reason.value.trim() }),
        });
      });
      audit("نقل", { adm: a, details: { from: `${unitName(a.unitId)} ${a.bed}`, to: `${unitName(toUnit)} ${toBed}` } });
      toast(`تم النقل إلى ${unitName(toUnit)}، ${bedName(toUnit, toBed)}`);
      if (!isAdmin() && !(S.profile.units || []).includes(toUnit)) setTimeout(() => (location.hash = "#/"), 0);
    });
  const fillBeds = () => {
    const u = unitById(f.elements.unit.value);
    f.elements.bed.innerHTML = freeBeds(u).map((n) => `<option value="${n}">${esc(u.bedLabel)} ${n}</option>`).join("");
    document.getElementById("trNote").textContent = !isAdmin() && !(S.profile.units || []).includes(u.id)
      ? "الوحدة دي مش ضمن وحداتك، يعني بعد النقل مش هتقدر تفتح الملف." : "";
  };
  f.elements.unit.onchange = fillBeds;
  fillBeds();
}

/* ---------- الأرشيف (أدمن) ---------- */
function renderArchive() {
  const A = (S.A ||= { from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), unit: "", type: "", q: "" });
  shell(archiveTabs("icu") + `
  <form class="filters" id="arcF">
    <label class="field"><span>خروج من</span><input type="date" name="from" value="${A.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${A.to}"></label>
    <label class="field"><span>الوحدة</span><select name="unit"><option value="">كل الوحدات</option>${units().map((u) =>
      `<option value="${u.id}" ${A.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>
    <label class="field"><span>نوع الخروج</span><select name="type"><option value="">الكل</option>${Object.entries(DIS_TYPES).map(([k, l]) =>
      `<option value="${k}" ${A.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field grow"><span>بحث بالاسم أو الرقم القومي أو الرقم الطبي</span><input name="q" value="${esc(A.q)}" placeholder="الرقم القومي والرقم الطبي بيدوروا في كل السنين"></label>
    <button class="btn">عرض</button>
  </form>
  <div id="arcBody"><div class="loading">جاري التحميل…</div></div>`);
  const f = document.getElementById("arcF");
  f.onsubmit = (ev) => {
    ev.preventDefault();
    Object.assign(A, { from: f.elements.from.value, to: f.elements.to.value, unit: f.elements.unit.value, type: f.elements.type.value, q: f.elements.q.value.trim() });
    loadArchive();
  };
  loadArchive();
}

async function loadArchive() {
  const A = S.A, body = document.getElementById("arcBody");
  if (!body) return;
  body.innerHTML = `<div class="loading">جاري التحميل…</div>`;
  let rows = [];
  try {
    if (/^mr-?\d+$/i.test(A.q)) {
      const mr = "MR-" + A.q.replace(/\D/g, "");
      const ps = await getDocs(query(collection(db, "patients"), where("medicalId", "==", mr)));
      for (const pd of ps.docs) {
        const s2 = await getDocs(query(collection(db, "admissions"), where("patientId", "==", pd.id)));
        rows.push(...s2.docs.map((d) => ({ id: d.id, ...d.data() })));
      }
      rows = rows.filter((r) => r.status === "discharged");
    } else if (/^\d{14}$/.test(A.q)) {
      const byNid = await getDocs(query(collection(db, "admissions"), where("nationalId", "==", A.q)));
      rows = byNid.docs.map((d) => ({ id: d.id, ...d.data() }));
      const babies = await getDocs(query(collection(db, "patients"), where("motherNationalId", "==", A.q)));
      for (const b of babies.docs) {
        const s = await getDocs(query(collection(db, "admissions"), where("patientId", "==", b.id)));
        rows.push(...s.docs.map((d) => ({ id: d.id, ...d.data() })));
      }
      rows = rows.filter((r) => r.status === "discharged");
    } else {
      if (!A.from || !A.to) { body.innerHTML = `<div class="err">حدد الفترة.</div>`; return; }
      const snap = await getDocs(query(collection(db, "admissions"),
        where("dischargeAt", ">=", Timestamp.fromDate(new Date(A.from + "T00:00:00"))),
        where("dischargeAt", "<=", Timestamp.fromDate(new Date(A.to + "T23:59:59"))),
        orderBy("dischargeAt", "desc")));
      rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (A.q) rows = rows.filter((r) => (r.patientName || "").includes(A.q));
    }
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }
  if (A.unit) rows = rows.filter((r) => r.unitId === A.unit);
  if (A.type) rows = rows.filter((r) => r.dischargeType === A.type);
  rows.sort((x, y) => toDate(y.dischargeAt) - toDate(x.dischargeAt));

  const counts = Object.keys(DIS_TYPES).map((k) => [k, rows.filter((r) => r.dischargeType === k).length]);
  body.innerHTML = !rows.length ? `<div class="empty">لا يوجد حالات خرجت بالشروط دي.</div>` : `
    <div class="arc-sum"><span><b>${rows.length}</b> حالة</span>${counts.map(([k, n]) =>
      `<span class="dis t-${k}"><b>${n}</b> ${DIS_TYPES[k]}</span>`).join("")}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>الاسم</th><th>الرقم الطبي</th><th>الرقم القومي</th><th>الوحدة</th><th>الدخول</th><th>الخروج</th><th>الإقامة</th><th>نوع الخروج</th><th>المعاملة المالية</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><a href="#/patient/${r.id}"><strong>${esc(r.patientName)}</strong></a></td>
        <td class="ltr">${esc(r.medicalId) || "—"}</td>
        <td class="ltr">${esc(r.nationalId) || `<span class="muted">—</span>`}</td>
        <td>${esc(unitName(r.unitId))}</td>
        <td>${fmtDate(r.admitAt)}</td>
        <td>${fmtDateTime(r.dischargeAt)}</td>
        <td>${stayDays(r)} يوم</td>
        <td><span class="dis t-${r.dischargeType}">${DIS_TYPES[r.dischargeType] || ""}</span></td>
        <td>${esc(finText(finBreakdown(r)))}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

/* ---------- سجل التعديلات (أدمن) ---------- */
const HIDE_KEYS = new Set(["createdBy", "createdAt", "createdByName", "updatedBy", "updatedAt", "updatedByName", "enteredAt", "resultBy"]);
function fmtVal(v) {
  if (v == null || v === "") return "—";
  if (v?.toDate) return fmtDateTime(v);
  if (Array.isArray(v)) return v.map(fmtVal).join("، ");
  if (typeof v === "object") return Object.entries(v).filter(([, x]) => x !== "" && x != null).map(([k, x]) => `${k}: ${fmtVal(x)}`).join("، ");
  return String(v);
}
async function tabAudit(body) {
  let list = [];
  try {
    const snap = await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(300)));
    list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }
  body.innerHTML = `
  <div class="toolbar"><h2>سجل التعديلات</h2><input id="auQ" class="search" placeholder="بحث باسم المريض أو المستخدم"></div>
  <p class="muted">آخر 300 عملية: الدخول، والخروج، والنقل، وأي تعديل أو حذف في ملف المريض، مع البيانات قبل التعديل.</p>
  ${list.length ? `<div class="table-wrap"><table>
    <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>المريض</th><th>الوحدة</th><th>التفاصيل</th></tr></thead>
    <tbody id="auBody">${list.map((x) => `<tr data-s="${esc((x.patientName || "") + " " + (x.name || ""))}">
      <td class="nowrap">${fmtDateTime(x.at)}</td>
      <td>${esc(x.name)}</td>
      <td>${esc(x.action)}</td>
      <td>${x.admissionId ? `<a href="#/patient/${x.admissionId}">${esc(x.patientName)}</a>` : "—"}</td>
      <td>${esc(unitName(x.unitId))}</td>
      <td>${x.before || x.details ? `<details><summary>عرض</summary>
        ${x.details ? `<p class="au-d">${esc(fmtVal(x.details))}</p>` : ""}
        ${x.before ? `<p class="au-d"><strong>قبل التعديل:</strong> ${esc(fmtVal(Object.fromEntries(Object.entries(x.before).filter(([k]) => !HIDE_KEYS.has(k)))))}</p>` : ""}
      </details>` : ""}</td></tr>`).join("")}</tbody>
  </table></div>` : `<div class="empty">لا يوجد عمليات مسجلة بعد.</div>`}`;
  const q = document.getElementById("auQ");
  q.oninput = () => body.querySelectorAll("#auBody tr").forEach((tr) => tr.classList.toggle("hidden", !tr.dataset.s.includes(q.value.trim())));
}

/* =========================================================
   المرحلة 4: الطباعة و PDF والإحصائيات (أدمن)
   ========================================================= */
const PRINT_CSS = `
@page{size:A4;margin:12mm 11mm 14mm}
@page{@bottom-center{content:"صفحة " counter(page) " من " counter(pages);font-size:9pt;color:#666}}
*{box-sizing:border-box}
body{font-family:"IBM Plex Sans Arabic",Tahoma,Arial,sans-serif;color:#13302C;font-size:10.5pt;line-height:1.5;margin:0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.ph{display:flex;align-items:center;gap:12px;border-bottom:2px solid #0E6B63;padding-bottom:8px;margin-bottom:12px}
.ph img{max-height:56px;max-width:120px}
.ph strong{display:block;font-size:14pt}
.ph span{color:#56706A}
.ph-meta{margin-inline-start:auto;text-align:end;font-size:8.5pt;color:#56706A}
h1{font-size:16pt;margin:0 0 4px}
h2{font-size:12pt;margin:16px 0 6px;padding:3px 8px;background:#DCEDE9;border-radius:4px;break-after:avoid}
.sub{color:#56706A;margin:0 0 8px}
.kv2{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0}
.kv dt{color:#56706A}
.kv dd{margin:0;font-weight:600}
table{width:100%;border-collapse:collapse;margin:4px 0 10px;font-size:9.5pt}
th,td{border:1px solid #B9C9C4;padding:3px 5px;text-align:start;vertical-align:top}
thead th{background:#F0F5F3}
tr{break-inside:avoid}
.grid th,.grid td{text-align:center}
.grid tbody th{text-align:start;background:#F6F9F8;white-space:nowrap}
.grid small{display:block;font-size:7.5pt;color:#56706A;font-weight:400}
.grid td.note{text-align:start;font-size:8.5pt}
.c-stop{color:#B4232A;font-weight:600}
.c-chg{background:#FDF3DF}
.muted{color:#56706A}
.pre{white-space:pre-wrap}
.ltr{direction:ltr;unicode-bidi:plaintext}
.sign{margin-top:28px;display:flex;justify-content:space-between;font-size:10pt}
`;

function printDoc(title, bodyHtml, withLogo) {
  const s = S.settings;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet">
  <style>${PRINT_CSS}</style></head><body>
  <header class="ph">${withLogo && s.logo ? `<img src="${s.logo}" alt="">` : ""}
    <div><strong>${esc(s.hospitalName)}</strong><span>الرعاية المركزة</span></div>
    <div class="ph-meta">تاريخ الطباعة: ${fmtDateTime(new Date())}<br>${esc(S.profile.displayName)}</div></header>
  ${bodyHtml}</body></html>`;
  document.getElementById("printFrame")?.remove();
  const fr = document.createElement("iframe");
  fr.id = "printFrame";
  fr.title = "طباعة";
  fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(fr);
  let done = false;
  const go = async () => {
    if (done) return; done = true;
    try { await fr.contentDocument.fonts?.ready; } catch {}
    setTimeout(() => { fr.contentWindow.focus(); fr.contentWindow.print(); }, 150);
  };
  fr.onload = go;
  const d = fr.contentDocument;
  d.open(); d.write(html); d.close();
  setTimeout(go, 2500);
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

function openPrintDialog() {
  const hasLogo = !!S.settings.logo;
  const secs = [["info", "البيانات والدخول والخروج"], ["history", "الحالة السريرية والتاريخ المرضي والتشخيص"], ["consult", "الإشراف المشترك"],
    ["inv", "الأشعة والتحاليل"], ["vitals", "العلامات الحيوية وتطور الحالة"], ["meds", "العلاج"]];
  const f = formDialog("طباعة ملف المريض", `
    <div class="field"><span>الأقسام</span><div class="checks">${secs.map(([k, l]) =>
      `<label><input type="checkbox" name="sec" value="${k}" checked> ${l}</label>`).join("")}</div></div>
    <div class="row2">
      <label class="field"><span>فترة العلامات الحيوية والعلاج</span>
        <select name="range"><option value="0">كل أيام الإقامة</option><option value="1">آخر يوم</option><option value="3">آخر 3 أيام</option><option value="7">آخر 7 أيام</option></select></label>
      <div class="field"><span>اللوجو</span><div class="checks"><label><input type="checkbox" name="logo" ${hasLogo ? "checked" : "disabled"}> ${hasLogo ? "طباعة باللوجو" : "مفيش لوجو متسجل"}</label></div></div>
    </div>
    <p class="hint">عشان تحفظه PDF: من نافذة الطباعة اختار <strong>Save as PDF</strong> أو <strong>حفظ بتنسيق PDF</strong> بدل الطابعة.</p>`,
    "طباعة",
    async (f) => {
      const sel = checkedValues(f, "sec");
      if (!sel.length) return "اختر قسماً واحداً على الأقل.";
      const a = S.P.adm;
      printDoc(`${a.patientName} - ${fmtDate(new Date())}`, buildPatientPrint(sel, Number(f.elements.range.value)), f.elements.logo.checked);
    });
  return f;
}

function buildPatientPrint(sel, rangeDays) {
  const P = S.P, a = P.adm, p = P.pat;
  const unit = unitById(a.unitId) || { name: a.unitId, bedLabel: "سرير" };
  const lastDay = isoDay(stayEnd(a));
  const fromDay = rangeDays ? addDays(lastDay, -(rangeDays - 1)) : isoDay(toDate(a.admitAt));
  let h = `<h1>${esc(p.name || a.patientName)}</h1>
    <p class="sub">${p.medicalId ? `${esc(p.medicalId)}، ` : ""}${a.admissionNumber ? `دخول ${esc(a.admissionNumber)}، ` : ""}${esc(unit.name)}، ${esc(unit.bedLabel)} ${a.bed}، دخول ${fmtDateTime(a.admitAt)}، ${stayDays(a)} يوم إقامة
    ${a.status === "discharged" ? `، خرج ${fmtDateTime(a.dischargeAt)} (${DIS_TYPES[a.dischargeType] || ""})` : ""}</p>`;

  if (sel.includes("info")) {
    const idRows = p.idType === "newborn"
      ? `<dt>اسم الأم</dt><dd>${esc(p.motherName)}</dd><dt>الرقم القومي للأم</dt><dd class="ltr">${esc(p.motherNationalId)}</dd>`
      : `<dt>الرقم القومي</dt><dd class="ltr">${esc(p.nationalId) || "غير معروف"}</dd>`;
    const i = a.dischargeInfo || {};
    h += `<h2>البيانات</h2><div class="kv2">
      <dl class="kv">${idRows}
        <dt>السن</dt><dd>${esc(ageText(p.birthDate, p.birthDateEstimated)) || "—"}</dd>
        <dt>النوع</dt><dd>${genderText(p.gender) || "—"}</dd>
        <dt>العنوان</dt><dd>${esc(p.address) || "—"}</dd>
        <dt>التليفون</dt><dd class="ltr">${esc(p.phone) || "—"}</dd>
        <dt>مرات الدخول</dt><dd>${p.admissionsCount || 1}</dd></dl>
      <dl class="kv">
        <dt>تاريخ الدخول</dt><dd>${fmtDateTime(a.admitAt)}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(a.consultant) || "—"}</dd>
        <dt>المعاملة المالية</dt><dd>${esc(finText(finBreakdown(a)))}</dd>
        <dt>التخصصات المشتركة</dt><dd>${esc((a.specialties || []).join("، ")) || "—"}</dd>
        ${a.status === "discharged" ? `<dt>الخروج</dt><dd>${DIS_TYPES[a.dischargeType] || ""}، ${fmtDateTime(a.dischargeAt)}</dd>
          ${i.deathCause ? `<dt>سبب الوفاة</dt><dd>${esc(i.deathCause)}</dd>` : ""}
          ${i.ward ? `<dt>القسم الداخلي</dt><dd>${esc(i.ward)}</dd>` : ""}
          ${i.hospital ? `<dt>المستشفى</dt><dd>${esc(i.hospital)}</dd>` : ""}
          ${i.reason ? `<dt>سبب التحويل</dt><dd>${esc(i.reason)}</dd>` : ""}
          ${i.notes ? `<dt>ملاحظات</dt><dd>${esc(i.notes)}</dd>` : ""}` : ""}
      </dl></div>
      ${a.moves?.length ? `<table><thead><tr><th>وقت النقل</th><th>من</th><th>إلى</th><th>السبب</th></tr></thead><tbody>${[...a.moves]
        .sort((x, y) => toDate(x.at) - toDate(y.at)).map((m) => `<tr><td>${fmtDateTime(m.at)}</td>
        <td>${esc(unitName(m.fromUnit))} ${m.fromBed}</td><td>${esc(unitName(m.toUnit))} ${m.toBed}</td><td>${esc(m.reason)}</td></tr>`).join("")}</tbody></table>` : ""}`;
  }

  if (sel.includes("history")) {
    const cur = P.entries.filter((e) => e.kind === "history").sort(desc)[0];
    const dx = P.entries.filter((e) => e.kind === "diagnosis").sort(asc);
    const st = P.entries.filter((e) => e.kind === "status").sort(asc);
    if (st.length) h += `<h2>الحالة السريرية</h2><table><thead><tr><th>الوقت</th><th>التنفس</th><th>الوعي</th><th>APACHE II</th><th>قرح الفراش</th><th>التقليب</th><th>تقييد</th></tr></thead><tbody>${st.map((e) =>
      `<tr><td>${fmtDateTime(e.at)}</td><td>${RESP_SHORT[e.resp] || "—"}</td><td>${esc(e.consciousness || "—")}</td><td>${e.apache ?? "—"}</td>
      <td>${BEDSORE[e.bedsore] || "—"}${e.bedsoreSite ? `، ${esc(e.bedsoreSite)}` : ""}</td><td>${TURNING[e.turning] || "—"}</td>
      <td>${e.restraint ? "نعم" : "—"}</td></tr>`).join("")}</tbody></table>`;
    h += `<h2>التاريخ المرضي</h2>${cur
      ? `<dl class="kv">${HISTORY_FIELDS.filter(([k]) => cur[k]).map(([k, l]) => `<dt>${l}</dt><dd class="pre ltr">${esc(cur[k])}</dd>`).join("")}</dl>`
      : `<p class="muted">لم يُسجل.</p>`}
      <h2>التشخيص</h2>${dx.length ? `<table><thead><tr><th>الوقت</th><th>النوع</th><th>التشخيص</th><th>بواسطة</th></tr></thead><tbody>${dx.map((e) =>
        `<tr><td>${fmtDateTime(e.at)}</td><td>${DX_TYPES[e.dxType] || ""}</td><td class="pre ltr">${esc(e.text)}</td><td>${esc(e.createdByName)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">لم يُسجل.</p>`}`;
  }

  if (sel.includes("consult")) {
    const list = P.entries.filter((e) => e.kind === "consult").sort(asc);
    h += `<h2>الإشراف المشترك</h2>${list.length ? `<table><thead><tr><th>الوقت</th><th>التخصص</th><th>الطبيب</th><th>الرأي</th></tr></thead><tbody>${list.map((e) =>
      `<tr><td>${fmtDateTime(e.at)}</td><td>${esc(e.specialty)}</td><td>${esc(e.doctor)}</td><td class="pre">${esc(e.opinion)}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">لا يوجد.</p>`}`;
  }

  if (sel.includes("inv")) {
    const list = P.entries.filter((e) => e.kind === "investigation").sort(asc);
    h += `<h2>الأشعة والتحاليل</h2>${list.length ? `<table><thead><tr><th>وقت الطلب</th><th>النوع</th><th>الطلب</th><th>النتيجة</th><th>وقت النتيجة</th></tr></thead><tbody>${list.map((e) =>
      `<tr><td>${fmtDateTime(e.at)}</td><td>${INV_TYPES[e.invType] || ""}</td><td class="ltr">${esc(e.name)}</td>
       <td class="pre ltr">${esc(e.result) || "منتظر"}</td><td>${e.resultAt ? fmtDateTime(e.resultAt) : ""}</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">لا يوجد.</p>`}`;
  }

  if (sel.includes("vitals")) {
    const fields = unitVitals(unitById(a.unitId));
    const rs = [...P.vitals].sort(asc).filter((r) => isoDay(toDate(r.at)) >= fromDay);
    h += `<h2>العلامات الحيوية وتطور الحالة</h2>` + (rs.length ? chunk(rs, 7).map((part) => `
      <table class="grid"><thead><tr><th></th>${part.map((r) => `<th>${fmtDayShort(isoDay(toDate(r.at)))}<small>${fmtTime(r.at)}، ${shiftName(r.at)}</small></th>`).join("")}</tr></thead>
      <tbody>${fields.map((f) => `<tr><th>${esc(f.label)}${f.unit ? `<small>${esc(f.unit)}</small>` : ""}</th>${part.map((r) => `<td>${esc(r.values?.[f.key] ?? "")}</td>`).join("")}</tr>`).join("")}
      <tr><th>تطور الحالة</th>${part.map((r) => `<td class="note pre ltr">${esc(r.note || "")}</td>`).join("")}</tr>
      <tr><th>سجّل</th>${part.map((r) => `<td><small>${esc(r.createdByName)}</small></td>`).join("")}</tr></tbody></table>`).join("")
      : `<p class="muted">لا يوجد قراءات في الفترة دي.</p>`);
  }

  if (sel.includes("meds")) {
    const days = dayRange(fromDay < isoDay(toDate(a.admitAt)) ? isoDay(toDate(a.admitAt)) : fromDay, lastDay);
    const meds = [...P.meds].sort((x, y) => x.startDate.localeCompare(y.startDate))
      .filter((m) => !(m.stopDate && m.stopDate < days[0]) && !(medEnd(m) && medEnd(m) < days[0]) && m.startDate <= lastDay);
    const cell = (m, day) => {
      const end = medEnd(m);
      if (day < m.startDate || (m.stopDate && day > m.stopDate) || (end && day > end)) return `<td></td>`;
      if (m.stopDate === day) return `<td class="c-stop">أوقف</td>`;
      const d = sortedDoses(m).filter((x) => x.from <= day).pop();
      if (!d) return `<td></td>`;
      return `<td class="${d.from === day && day !== m.startDate ? "c-chg" : ""}">${esc(d.dose)}<small>${esc(d.frequency)}</small>${m.duration ? `<small>${medDayNo(m, day)}/${m.duration}</small>` : ""}</td>`;
    };
    h += `<h2>العلاج</h2>` + (meds.length && days.length ? chunk(days, 8).map((part) => `
      <table class="grid"><thead><tr><th>الدواء</th>${part.map((d) => `<th>${fmtDayShort(d)}<small>اليوم ${stayDayOn(a.admitAt, d)}</small></th>`).join("")}</tr></thead>
      <tbody>${meds.map((m) => `<tr><th class="ltr">${esc(m.name)}<small>${esc(m.route)}</small></th>${part.map((d) => cell(m, d)).join("")}</tr>`).join("")}</tbody></table>`).join("")
      : `<p class="muted">لا يوجد علاج في الفترة دي.</p>`);
  }

  h += `<div class="sign"><span>توقيع الطبيب: ....................</span><span>توقيع الاستشاري: ....................</span></div>`;
  return h;
}

/* ---------- الإحصائيات (أدمن) ---------- */
// تقسيم إقامة المريض على الوحدات حسب سجل النقل
function staySegments(a) {
  const mv = [...(a.moves || [])].sort((x, y) => toDate(x.at) - toDate(y.at));
  let unit = mv.length ? mv[0].fromUnit : a.unitId, t = toDate(a.admitAt);
  const segs = [];
  for (const m of mv) { segs.push({ unit, from: t, to: toDate(m.at) }); unit = m.toUnit; t = toDate(m.at); }
  segs.push({ unit, from: t, to: stayEnd(a) });
  return segs;
}

function renderStats() {
  const now = new Date();
  const T = (S.T ||= { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(now) });
  const us = units();
  let tb = 0, to = 0;
  const occRows = us.map((u) => {
    const o = (S.adm[u.id] || []).length; tb += u.beds; to += o;
    const pct = u.beds ? Math.round((o / u.beds) * 100) : 0;
    return `<tr><td>${esc(u.name)}</td><td>${u.beds}</td><td>${o}</td><td>${u.beds - o}</td>
      <td><div class="bar-cell"><div class="meter"><i style="width:${pct}%"></i></div><span>${pct}%</span></div></td></tr>`;
  }).join("");
  const tp = tb ? Math.round((to / tb) * 100) : 0;
  shell(`
  <div class="toolbar"><h2>الإحصائيات</h2><div class="file-actions" style="margin:0"><button class="btn ghost" id="stSpecial">تقارير خاصة (PDF)</button><button class="btn ghost" id="stPrint">طباعة</button></div></div>
  <section class="settings-block">
    <h3 class="st-h">الإشغال الحالي</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>الوحدة</th><th>الأسرّة</th><th>مشغول</th><th>فارغ</th><th>الإشغال</th></tr></thead>
      <tbody>${occRows}<tr class="total"><td>الإجمالي</td><td>${tb}</td><td>${to}</td><td>${tb - to}</td>
        <td><div class="bar-cell"><div class="meter"><i style="width:${tp}%"></i></div><span>${tp}%</span></div></td></tr></tbody>
    </table></div>
  </section>
  <h3 class="st-h">إحصائيات فترة</h3>
  <form class="filters" id="stF">
    <label class="field"><span>من</span><input type="date" name="from" value="${T.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${T.to}"></label>
    <button class="btn">عرض</button>
  </form>
  <div id="stBody"><div class="loading">جاري الحساب…</div></div>`);
  document.getElementById("stPrint").onclick = () => window.print();
  document.getElementById("stSpecial").onclick = () => (S.T.special ? printSpecialReports() : toast("استنى لحد ما الإحصائيات تخلص تحميل", true));
  const f = document.getElementById("stF");
  f.onsubmit = (ev) => { ev.preventDefault(); T.from = f.elements.from.value; T.to = f.elements.to.value; loadStats(); };
  loadStats();
}

async function loadStats() {
  const T = S.T, body = document.getElementById("stBody");
  if (!body) return;
  if (!T.from || !T.to || T.from > T.to) { body.innerHTML = `<div class="err">حدد فترة صحيحة.</div>`; return; }
  body.innerHTML = `<div class="loading">جاري الحساب…</div>`;
  const start = new Date(T.from + "T00:00:00");
  const end = new Date(T.to + "T23:59:59.999");
  const effEnd = new Date(Math.min(end, new Date()));
  let all;
  try {
    // كل الحالات اللي خرجت بعد بداية الفترة + الحالات الموجودة حالياً = كل اللي كانوا موجودين في الفترة
    const snap = await getDocs(query(collection(db, "admissions"), where("dischargeAt", ">=", Timestamp.fromDate(start)), orderBy("dischargeAt")));
    all = [...snap.docs.map((d) => ({ id: d.id, ...d.data() })), ...Object.values(S.adm).flat().filter(Boolean)]
      .filter((a) => toDate(a.admitAt) <= end);
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }

  const blank = () => ({ adm: 0, dis: 0, types: Object.fromEntries(Object.keys(DIS_TYPES).map((k) => [k, 0])), los: 0, hours: 0 });
  const U = {};
  units().forEach((u) => (U[u.id] = blank()));
  const fin = {};
  const inRange = (d) => d && d >= start && d <= end;
  for (const a of all) {
    const segs = staySegments(a);
    for (const s of segs) {
      const ov = Math.min(s.to, effEnd) - Math.max(s.from, start);
      if (ov > 0) (U[s.unit] ||= blank()).hours += ov / 36e5;
    }
    if (inRange(toDate(a.admitAt))) (U[segs[0].unit] ||= blank()).adm++;
    const fb = finBreakdown(a, T.from, isoDay(effEnd));
    Object.entries(fb).forEach(([k, n]) => (fin[k] = (fin[k] || 0) + n));
    if (a.status === "discharged" && inRange(toDate(a.dischargeAt))) {
      const x = (U[a.unitId] ||= blank());
      x.dis++; x.types[a.dischargeType] = (x.types[a.dischargeType] || 0) + 1; x.los += stayDays(a);
    }
  }
  const periodDays = Math.max(0, (effEnd - start) / 864e5);
  const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "—");
  const tot = blank(); let totBeds = 0;
  const row = (name, x, beds) => {
    const occ = beds && periodDays ? (x.hours / 24) / (beds * periodDays) : 0;
    const op = Math.min(100, Math.round(occ * 100));
    return `<tr><td>${esc(name)}</td><td>${x.adm}</td><td>${x.dis}</td>
      ${Object.keys(DIS_TYPES).map((k) => `<td>${x.types[k] || 0}</td>`).join("")}
      <td>${pct(x.types.death, x.dis)}</td><td>${x.dis ? (Math.round((x.los / x.dis) * 10) / 10) + " يوم" : "—"}</td>
      <td>${Math.round(x.hours / 24)}</td>
      <td><div class="bar-cell"><div class="meter"><i style="width:${op}%"></i></div><span>${beds && periodDays ? op + "%" : "—"}</span></div></td></tr>`;
  };
  const rows = Object.entries(U).map(([id, x]) => {
    const u = unitById(id);
    totBeds += u?.beds || 0;
    tot.adm += x.adm; tot.dis += x.dis; tot.los += x.los; tot.hours += x.hours;
    Object.keys(tot.types).forEach((k) => (tot.types[k] += x.types[k] || 0));
    return row(u?.name || id, x, u?.beds || 0);
  }).join("");
  const finTotal = Object.values(fin).reduce((s, n) => s + n, 0);

  body.innerHTML = `
  <p class="muted">الفترة من ${fmtDate(T.from)} إلى ${fmtDate(T.to)}${end > new Date() ? " (محسوبة لحد النهارده)" : ""}.</p>
  <div class="table-wrap"><table class="stats">
    <thead><tr><th>الوحدة</th><th>دخول</th><th>خروج</th>${Object.values(DIS_TYPES).map((l) => `<th>${l}</th>`).join("")}
      <th>نسبة الوفيات</th><th>متوسط الإقامة</th><th>أيام المرضى</th><th>نسبة الإشغال</th></tr></thead>
    <tbody>${rows}${row("الإجمالي", tot, totBeds).replace("<tr>", '<tr class="total">')}</tbody>
  </table></div>
  <h3 class="st-h">أيام المرضى حسب المعاملة المالية</h3>
  ${finTotal ? `<div class="fin">${Object.entries(fin).sort((x, y) => y[1] - x[1]).map(([k, n]) =>
    `<div class="fin-item"><strong>${n}</strong><span>${esc(k)}</span><small>${pct(n, finTotal)} من أيام المرضى</small></div>`).join("")}</div>`
    : `<p class="muted">لا يوجد مرضى في الفترة دي.</p>`}
  <p class="muted st-note">نسبة الوفيات = الوفيات ÷ حالات الخروج في الفترة. متوسط الإقامة لحالات الخروج فقط.
  أيام المرضى ونسبة الإشغال بتتحسب بالساعات لكل وحدة حسب سجل النقل، ونسبة الإشغال = أيام المرضى ÷ (عدد الأسرّة × أيام الفترة).
  الدخول بيتحسب على أول وحدة دخلها المريض، والخروج على آخر وحدة.</p>
  <div id="stExtra"></div>`;
  S.T.special = null;
  loadStatsExtra(start, end, effEnd, all);
}

/* ---------- بطاقة تعريف المريض (Wristband) ---------- */
function printWristband() {
  const { adm: a, pat: p } = S.P;
  const unit = unitById(a.unitId) || { name: a.unitId, bedLabel: "سرير" };
  printDoc(`بطاقة ${a.patientName}`, `
    <style>.ph{display:none}.card{border:2px solid #0E6B63;border-radius:10px;padding:14px 18px;width:88mm;margin:0 auto;text-align:center}
      .card .n{font-size:16pt;font-weight:700}.card .mr{font-size:22pt;font-weight:700;letter-spacing:2px;margin:8px 0;padding:6px;background:#EDF2F0;border-radius:8px;direction:ltr}
      .card .r{font-size:10.5pt}</style>
    <div class="card">
      <div class="n">${esc(p.name || a.patientName)}</div>
      <div class="mr">${esc(p.medicalId || a.admissionNumber || "")}</div>
      <div class="r">السن: ${esc(ageText(p.birthDate, p.birthDateEstimated)) || "—"}، ${genderText(p.gender)}</div>
      <div class="r">${p.idType === "newborn" ? `الأم: ${esc(p.motherName)}` : `الرقم القومي: <span class="ltr">${esc(p.nationalId) || "—"}</span>`}</div>
      <div class="r">${esc(unit.name)}، ${esc(unit.bedLabel)} ${a.bed}، دخول ${fmtDate(a.admitAt)}</div>
    </div>`, false);
}

/* =========================================================
   المرحلة 5: سجل المرضى، الداخلي، العمليات، التنبيهات
   ========================================================= */
const SECTIONS = { icu: "الرعاية المركزة", ward: "الداخلي", ops: "العمليات", reports: "التقارير الطبية" };
const LEVELS = { none: "مفيش دخول", read: "عرض فقط", write: "عرض وكتابة" };
const WARD_DIS = { improved: "خروج تحسن", death: "وفاة", otherDept: "تحويل إلى قسم آخر", icu: "تحويل للرعاية المركزة", escape: "هروب", request: "حسب الطلب" };
const OP_STATUS = { scheduled: "مجدولة", done: "تمت", cancelled: "ملغية" };
const CASE_TYPES = ["طوارئ", "غير طارئة"];
const wardUnits = () => S.settings?.wardUnits || [];
const wardById = (id) => wardUnits().find((u) => u.id === id);

/* ---------- تسجيل مريض جديد / تعديل بياناته ---------- */
function patientFormHtml(p, isNew) {
  const nb = p?.idType === "newborn";
  return `
    ${isNew ? `<fieldset class="seg">
      <label><input type="radio" name="mode" value="nid" checked> رقم قومي</label>
      <label><input type="radio" name="mode" value="newborn"> مولود (بيانات الأم)</label>
      <label><input type="radio" name="mode" value="unknown"> بدون رقم قومي</label></fieldset>
    <label class="field mf m-nid"><span>الرقم القومي</span><input name="nid" inputmode="numeric" maxlength="14" class="ltr" autocomplete="off"></label>
    <div class="info mf m-nid" id="pfNidInfo"></div>
    <label class="field mf m-newborn"><span>الرقم القومي للأم</span><input name="motherNid" inputmode="numeric" maxlength="14" class="ltr" autocomplete="off"></label>
    <div class="row2 mf m-newborn">
      <label class="field"><span>نوع المولود</span><select name="babyGender"><option value="">اختر…</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
      <label class="field"><span>تاريخ الولادة</span><input name="babyBirth" type="date" max="${isoDay(new Date())}"></label>
    </div>
    <div class="row2 mf m-unknown">
      <label class="field"><span>السن التقريبي (سنوات)</span><input name="approxAge" type="number" min="0" max="120"></label>
      <label class="field"><span>النوع</span><select name="gender"><option value="">اختر…</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
    </div>` : ""}
    ${isNew || nb ? `<label class="field ${isNew ? "mf m-newborn" : ""}"><span>اسم الأم</span><input name="motherName" value="${esc(p?.motherName || "")}"></label>` : ""}
    ${isNew || !nb ? `<label class="field ${isNew ? "mf m-nid m-unknown" : ""}"><span>اسم المريض</span><input name="pname" value="${esc(p?.name || "")}"></label>` : ""}
    <label class="field"><span>العنوان</span><input name="address" value="${esc(p?.address || "")}"></label>
    ${isNew ? `<div id="pfDup"></div>` : ""}
    <div class="row2">
      <label class="field"><span>تليفون 1</span><input name="phone" class="ltr" inputmode="tel" value="${esc(p?.phone || "")}"></label>
      <label class="field"><span>تليفون 2</span><input name="phone2" class="ltr" inputmode="tel" value="${esc(p?.phone2 || "")}"></label>
    </div>`;
}

function openPatientForm(onCreated) {
  const f = formDialog("تسجيل مريض جديد", patientFormHtml(null, true), "تسجيل المريض", async (f) => {
    const mode = f.dataset.mode;
    const phone = f.elements.phone.value.trim(), phone2 = f.elements.phone2.value.trim();
    for (const ph of [phone, phone2]) if (ph && !/^[0-9+\s-]{7,20}$/.test(ph)) return "رقم التليفون غير صحيح.";
    let ref, data;
    if (mode === "nid") {
      const nid = f.elements.nid.value.trim();
      const pn = parseNid(nid);
      if (!pn) return "اكتب رقم قومي صحيح (14 رقم).";
      if (!f.elements.pname.value.trim()) return "اكتب اسم المريض.";
      ref = doc(db, "patients", nid);
      data = { idType: "nid", nationalId: nid, name: f.elements.pname.value.trim(), birthDate: pn.birthDate, birthDateEstimated: false, gender: pn.gender, isNewborn: false };
    } else if (mode === "newborn") {
      const m = f.elements.motherName.value.trim(), mn = f.elements.motherNid.value.trim(), g = f.elements.babyGender.value, b = f.elements.babyBirth.value;
      if (!m) return "اكتب اسم الأم.";
      if (!parseNid(mn)) return "اكتب الرقم القومي للأم صحيح.";
      if (!g || !b) return "حدد نوع المولود وتاريخ الولادة.";
      ref = doc(collection(db, "patients"));
      data = { idType: "newborn", nationalId: "", name: `${g === "male" ? "ابن" : "بنت"} ${m}`, motherName: m, motherNationalId: mn, birthDate: b, birthDateEstimated: false, gender: g, isNewborn: true };
    } else {
      if (!f.elements.gender.value) return "اختر النوع.";
      let birthDate = "", est = false;
      if (f.elements.approxAge.value !== "") { const d = new Date(); d.setFullYear(d.getFullYear() - Number(f.elements.approxAge.value)); birthDate = isoDay(d); est = true; }
      ref = doc(collection(db, "patients"));
      data = { idType: "unknown", nationalId: "", name: f.elements.pname.value.trim() || "مجهول الهوية", birthDate, birthDateEstimated: est, gender: f.elements.gender.value, isNewborn: false };
    }
    Object.assign(data, { address: f.elements.address.value.trim(), phone, phone2, nameKey: nameKey(data.name) });
    const openExisting = (x) => { closeDialog(); if (onCreated) setTimeout(() => onCreated(x), 0); else location.hash = `#/p/${x.id}`; };
    // الرقم القومي متسجل؟ افتح ملفه على طول
    const ex = await getDoc(ref);
    if (ex.exists()) { toast("المريض ده متسجل قبل كده، اتفتح ملفه."); openExisting({ id: ex.id, ...ex.data() }); return; }
    // نفس الاسم متسجل؟ لازم تختار الملف أو تأكد إنه مريض مختلف
    if (!f.querySelector('input[name="dupOk"]')?.checked) {
      const dups = await findNameDuplicates(data.name, ref.id);
      if (dups.length) {
        showDuplicates(document.getElementById("pfDup"), dups, openExisting);
        return "فيه مريض متسجل بنفس الاسم. افتح ملفه، أو أكّد إنه مريض مختلف.";
      }
    }
    const counterRef = doc(db, "config", "counters");
    let existed = false;
    await runTransaction(db, async (tx) => {
      const ps = await tx.get(ref);
      if (ps.exists()) { existed = true; return; }
      const cs = await tx.get(counterRef);
      const mr = (cs.exists() ? cs.data().mr || 1000 : 1000) + 1;
      tx.set(counterRef, { mr }, { merge: true });
      tx.set(ref, { ...data, medicalId: `MR-${mr}`, admissionsCount: 0, currentAdmissionId: null, visits: [], ...meta() });
    });
    toast(existed ? "المريض ده متسجل قبل كده، اتفتح ملفه." : "تم تسجيل المريض");
    const snap = await getDoc(ref);
    if (onCreated) setTimeout(() => onCreated({ id: ref.id, ...snap.data() }), 0);
    else location.hash = `#/p/${ref.id}`;
  });
  f.dataset.mode = "nid";
  f.querySelectorAll('input[name="mode"]').forEach((r) => (r.onchange = () => (f.dataset.mode = r.value)));
  f.elements.nid.oninput = async () => {
    f.elements.nid.value = f.elements.nid.value.replace(/\D/g, "");
    const info = document.getElementById("pfNidInfo");
    const pn = f.elements.nid.value.length === 14 ? parseNid(f.elements.nid.value) : null;
    info.textContent = pn ? `${fmtDate(pn.birthDate)}، ${ageText(pn.birthDate)}، ${genderText(pn.gender)}` : "";
    if (!pn) return;
    try {
      const s = await getDoc(doc(db, "patients", f.elements.nid.value));
      if (s.exists()) info.innerHTML = `المريض متسجل بالفعل: <strong>${esc(s.data().name)}</strong> (${esc(s.data().medicalId || "")}). الحفظ هيفتح ملفه.`;
    } catch {}
  };
}

function openPatientEdit(p) {
  const nb = p.idType === "newborn";
  formDialog("تعديل بيانات المريض", patientFormHtml(p, false), "حفظ التعديل", async (f) => {
    const phone = f.elements.phone.value.trim(), phone2 = f.elements.phone2.value.trim();
    for (const ph of [phone, phone2]) if (ph && !/^[0-9+\s-]{7,20}$/.test(ph)) return "رقم التليفون غير صحيح.";
    const upd = { address: f.elements.address.value.trim(), phone, phone2, updatedAt: serverTimestamp(), updatedBy: S.profile.uid };
    if (nb) { upd.motherName = f.elements.motherName.value.trim(); upd.name = `${p.gender === "male" ? "ابن" : "بنت"} ${upd.motherName}`; }
    else upd.name = f.elements.pname.value.trim();
    if (!upd.name.trim()) return "الاسم مطلوب.";
    upd.nameKey = nameKey(upd.name);
    await updateDoc(doc(db, "patients", p.id), upd);
    // تحديث الاسم على الدخول الحالي (لو الصلاحية تسمح)
    if (p.currentAdmissionId) updateDoc(doc(db, "admissions", p.currentAdmissionId), { patientName: upd.name }).catch(() => {});
    if (p.currentWardId) updateDoc(doc(db, "wardAdmissions", p.currentWardId), { patientName: upd.name }).catch(() => {});
    audit("تعديل بيانات مريض", { adm: { id: "", patientName: upd.name, unitId: "" }, before: { name: p.name, address: p.address || "", phone: p.phone || "", phone2: p.phone2 || "" } });
    toast("تم حفظ التعديل");
  });
}

/* ---------- البحث عن مريض ---------- */
async function searchPatients(q) {
  q = q.trim();
  if (!q) return [];
  const col = collection(db, "patients");
  let snaps = [];
  if (/^mr-?\d+$/i.test(q)) snaps = [await getDocs(query(col, where("medicalId", "==", "MR-" + q.replace(/\D/g, ""))))];
  else if (/^\d{14}$/.test(q)) {
    const one = await getDoc(doc(col, q));
    snaps = [await getDocs(query(col, where("motherNationalId", "==", q)))];
    if (one.exists()) return [{ id: one.id, ...one.data() }, ...snaps[0].docs.map((d) => ({ id: d.id, ...d.data() }))];
  } else if (/^[0-9+\s-]{7,20}$/.test(q)) {
    snaps = [await getDocs(query(col, where("phone", "==", q))), await getDocs(query(col, where("phone2", "==", q)))];
  } else {
    const k = nameKey(q);
    snaps = await Promise.all([getDocs(query(col, where("nameKey", ">=", k), where("nameKey", "<=", k + "\uf8ff"), orderBy("nameKey"), limit(30))),
      getDocs(query(col, where("name", ">=", q), where("name", "<=", q + "\uf8ff"), orderBy("name"), limit(30)))]);
  }
  const m = new Map();
  snaps.forEach((s) => s.docs.forEach((d) => m.set(d.id, { id: d.id, ...d.data() })));
  return [...m.values()];
}
const patientLine = (p) => `<strong>${esc(p.name)}</strong> <span class="ltr muted">${esc(p.medicalId || "")}</span>
  <span class="muted">${esc(ageText(p.birthDate, p.birthDateEstimated))}${p.nationalId ? `، ${esc(p.nationalId)}` : ""}</span>`;

// نافذة اختيار مريض (بحث + تسجيل جديد)
function pickPatient(title, onPick) {
  openDialog(`
    <div class="form">
      <header class="dlg-head"><h3>${title}</h3><p>ابحث بالرقم الطبي أو الرقم القومي أو التليفون أو أول الاسم.</p></header>
      <form class="add-row" id="ppF"><input name="q" autocomplete="off" autofocus placeholder="MR-1001 أو الرقم القومي أو الاسم"><button class="btn">بحث</button></form>
      <div id="ppRes"></div>
      <div class="actions"><button type="button" class="btn ghost" id="ppNew">تسجيل مريض جديد</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
    </div>`);
  const f = document.getElementById("ppF"), res = document.getElementById("ppRes");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    res.innerHTML = `<p class="muted">جاري البحث…</p>`;
    try {
      const list = await searchPatients(f.elements.q.value);
      res.innerHTML = list.length ? `<ul class="pick-list">${list.map((p) => `<li><button type="button" data-id="${p.id}">${patientLine(p)}</button></li>`).join("")}</ul>`
        : `<p class="muted">مفيش نتائج. تقدر تسجل المريض كجديد.</p>`;
      res.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => { closeDialog(); onPick(list.find((x) => x.id === b.dataset.id)); }));
    } catch (e) { res.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  document.getElementById("ppNew").onclick = () => openPatientForm((p) => onPick(p));
}

/* ---------- صفحة المرضى (بحث) ---------- */
function renderPatients() {
  const q0 = S.PQ || "";
  shell(`
  <div class="toolbar"><h2>المرضى</h2>${canEditAny() ? `<button class="btn" id="newPat">تسجيل مريض جديد</button>` : ""}</div>
  <form class="filters" id="pSearch">
    <label class="field grow"><span>بحث</span><input name="q" value="${esc(q0)}" placeholder="الرقم الطبي، أو الرقم القومي، أو التليفون، أو أول الاسم" autofocus></label>
    <button class="btn">بحث</button>
  </form>
  <div id="pRes">${q0 ? "" : `<div class="empty">اكتب في البحث عشان تلاقي المريض. البحث بالاسم بيدور على أول الاسم.</div>`}</div>`);
  document.getElementById("newPat")?.addEventListener("click", () => openPatientForm());
  const f = document.getElementById("pSearch"), res = document.getElementById("pRes");
  const run = async () => {
    S.PQ = f.elements.q.value.trim();
    if (!S.PQ) return;
    res.innerHTML = `<div class="loading">جاري البحث…</div>`;
    try {
      const list = await searchPatients(S.PQ);
      res.innerHTML = list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>الرقم الطبي</th><th>السن</th><th>الرقم القومي</th><th>التليفون</th><th>الحالة الآن</th><th></th></tr></thead>
        <tbody>${list.map((p) => `<tr><td><a href="#/p/${p.id}"><strong>${esc(p.name)}</strong></a></td><td class="ltr">${esc(p.medicalId || "—")}</td>
          <td>${esc(ageText(p.birthDate, p.birthDateEstimated)) || "—"}</td><td class="ltr">${esc(p.nationalId || (p.motherNationalId ? `الأم ${p.motherNationalId}` : "—"))}</td>
          <td class="ltr">${esc(p.phone || "—")}</td>
          <td>${p.currentAdmissionId ? `<span class="dis">في الرعاية</span>` : p.currentWardId ? `<span class="dis t-ward">في الداخلي</span>` : "—"}</td>
          <td class="nowrap">${(canEdit("icu") || canEdit("ward")) && !p.currentAdmissionId && !p.currentWardId
            ? `<button class="btn sm" data-admit="${p.id}">${(p.visits || []).length || p.admissionsCount || p.wardCount ? "دخول متكرر" : "دخول"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">مفيش نتائج.</div>`;
      res.querySelectorAll("[data-admit]").forEach((b) => (b.onclick = () => admitChoice(list.find((x) => x.id === b.dataset.admit))));
    } catch (e) { res.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); run(); };
  if (q0) run();
}

/* ---------- ملف المريض الشامل ---------- */
function renderPatientHub(pid) {
  shell(`<div class="loading">جاري التحميل…</div>`);
  const H = (S.H = { pid, p: null, icu: null, ward: null, ops: null, reps: null });
  const draw = () => { if (S.H === H && S.page === "hub" && H.p) drawHub(); };
  S.pageUnsubs.push(onSnapshot(doc(db, "patients", pid), async (snap) => {
    if (!snap.exists()) { shell(`<div class="empty">المريض غير موجود.</div>`); return; }
    H.p = { id: snap.id, ...snap.data() };
    draw();
    const load = async (col, where1, curId) => {
      if (isAdmin()) return (await getDocs(query(collection(db, col), where("patientId", "==", pid)))).docs.map((d) => ({ id: d.id, ...d.data() }));
      if (!curId) return [];
      try { const d = await getDoc(doc(db, col, curId)); return d.exists() ? [{ id: d.id, ...d.data() }] : []; } catch { return []; }
    };
    try {
      [H.icu, H.ward] = await Promise.all([load("admissions", null, H.p.currentAdmissionId), load("wardAdmissions", null, H.p.currentWardId)]);
      healVisits(H.p, H.icu, H.ward);
      H.ops = canSee("ops") ? (await getDocs(query(collection(db, "operations"), where("patientId", "==", pid)))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
      H.reps = canSee("reports") ? (await getDocs(query(collection(db, "medicalReports"), where("patientId", "==", pid)))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
      H.ds = canSee("reports") || isAdmin() ? (await getDocs(query(collection(db, "dischargeReports"), where("patientId", "==", pid)))).docs.map((d) => ({ id: d.id, ...d.data() })) : [];
    } catch (e) { console.error(e); }
    draw();
  }));
}

function drawHub() {
  const { p, icu, ward, ops } = S.H;
  const inside = p.currentAdmissionId || p.currentWardId;
  const sortD = (arr, k) => [...(arr || [])].sort((x, y) => toDate(y[k]) - toDate(x[k]));
  const icuRows = sortD(icu, "admitAt").map((a) => `<li><a href="#/patient/${a.id}"><strong>${fmtDate(a.admitAt)}</strong>
    <span>${esc(unitName(a.unitId))}</span><span class="ltr muted">${esc(a.admissionNumber || "")}</span>
    <span class="dis t-${a.status === "active" ? "improved" : a.dischargeType}">${a.status === "active" ? "موجود حالياً" : DIS_TYPES[a.dischargeType] || ""}</span>
    <span class="by-line">${stayDays(a)} يوم</span></a></li>`).join("");
  const wardRows = sortD(ward, "admitAt").map((a) => `<li><a href="#/w/${a.id}"><strong>${fmtDate(a.admitAt)}</strong>
    <span>${esc(wardById(a.deptId)?.name || a.deptId)}</span><span class="ltr muted">${esc(a.admissionNumber || "")}</span>
    <span class="dis t-${a.status === "active" ? "improved" : "ward"}">${a.status === "active" ? "موجود حالياً" : WARD_DIS[a.dischargeType] || ""}</span>
    <span class="by-line">${stayDays(a)} يوم</span></a></li>`).join("");
  const opRows = sortD(ops, "proposedAt").map((o) => `<li><a href="#/o/${o.id}"><strong>${fmtDateTime(o.proposedAt)}</strong>
    <span>${esc(o.operation)}</span><span class="muted">${esc(o.specialty || "")}</span>
    <span class="dis op-${o.status}">${OP_STATUS[o.status]}</span></a></li>`).join("");
  const loading = S.H.icu === null ? `<p class="by-line">جاري التحميل…</p>` : "";
  const note = isAdmin() ? "" : `<p class="by-line">الدخولات السابقة بتظهر للأدمن فقط.</p>`;
  shell(`
  <div class="file-head">
    <a class="back" href="#/patients">المرضى</a>
    <h1>${esc(p.name)}</h1>
    <div class="tags">${p.medicalId ? `<span class="tag mr">${esc(p.medicalId)}</span>` : ""}
      <span class="tag">${esc(ageText(p.birthDate, p.birthDateEstimated)) || "السن غير معروف"}</span>
      <span class="tag">${genderText(p.gender)}</span>
      ${p.currentAdmissionId ? `<span class="tag day">في الرعاية الآن</span>` : p.currentWardId ? `<span class="tag day">في الداخلي الآن</span>` : ""}</div>
    <div class="file-actions">
      ${canEditAny() ? `<button class="btn ghost" data-h="edit">تعديل البيانات</button>` : ""}
      ${canEditAny() ? `<button class="btn ghost" data-h="band">بطاقة تعريف</button>` : ""}
      ${canEdit("icu") && !inside ? `<button class="btn" data-h="icu">دخول رعاية</button>` : ""}
      ${canEdit("ward") && !inside ? `<button class="btn" data-h="ward">دخول داخلي</button>` : ""}
      ${canEdit("ops") ? `<button class="btn" data-h="op">حجز عملية</button>` : ""}
    </div>
  </div>
  <div class="file-grid">
    <section class="panel"><header><h2>البيانات</h2></header>
      <dl class="kv">
        <dt>الرقم الطبي</dt><dd class="ltr">${esc(p.medicalId || "—")}</dd>
        ${p.idType === "newborn" ? `<dt>اسم الأم</dt><dd>${esc(p.motherName)}</dd><dt>الرقم القومي للأم</dt><dd class="ltr">${esc(p.motherNationalId)}</dd>`
          : `<dt>الرقم القومي</dt><dd class="ltr">${esc(p.nationalId || "غير معروف")}</dd>`}
        <dt>تاريخ الميلاد</dt><dd>${p.birthDate ? fmtDate(p.birthDate) + (p.birthDateEstimated ? " (تقريبي)" : "") : "—"}</dd>
        <dt>العنوان</dt><dd>${esc(p.address || "—")}</dd>
        <dt>تليفون 1</dt><dd class="ltr">${esc(p.phone || "—")}</dd>
        <dt>تليفون 2</dt><dd class="ltr">${esc(p.phone2 || "—")}</dd>
      </dl>${visitsListHtml(p)}</section>
    <section class="panel"><header><h2>الرعاية المركزة</h2></header>${loading}
      ${icuRows ? `<ul class="prev-list">${icuRows}</ul>` : `<p class="muted">${S.H.icu === null ? "" : "لا يوجد"}</p>`}${note}</section>
    <section class="panel"><header><h2>الداخلي</h2></header>${loading}
      ${wardRows ? `<ul class="prev-list">${wardRows}</ul>` : `<p class="muted">${S.H.ward === null ? "" : "لا يوجد"}</p>`}${note}</section>
    ${canSee("reports") ? `<section class="panel"><header><h2>التقارير الطبية</h2>${canEdit("reports") ? `<button class="btn ghost sm" data-h="rep">كتابة تقرير</button>` : ""}</header>
      ${(S.H.reps || []).length ? `<ul class="prev-list">${[...S.H.reps].sort((x, y) => toDate(y.reportDate) - toDate(x.reportDate)).map((r) => `<li><a href="#/r/${r.id}">
        <strong>${fmtDate(r.reportDate)}</strong><span class="ltr muted">${esc(r.admissionNumber || "")}</span><span>${esc(r.doctorName)}</span></a></li>`).join("")}</ul>`
        : `<p class="muted">${S.H.reps === null ? "جاري التحميل…" : "لا يوجد"}</p>`}
      ${(S.H.ds || []).length ? `<h3 class="st-h" style="font-size:15px;margin-top:12px">تقارير الخروج والوفاة</h3><ul class="prev-list">${S.H.ds.map((r) => `<li><a href="#/ds/${r.id}">
        <strong>${fmtDate(r.dischargeAt)}</strong><span class="ltr muted">${esc(r.admissionNumber || "")}</span>
        <span class="dis ${r.kind === "death" ? "t-death" : ""}">${r.kind === "death" ? "وفاة" : "خروج"}</span></a></li>`).join("")}</ul>` : ""}</section>` : ""}
    ${canSee("ops") ? `<section class="panel"><header><h2>العمليات</h2></header>
      ${opRows ? `<ul class="prev-list">${opRows}</ul>` : `<p class="muted">${ops === null ? "جاري التحميل…" : "لا يوجد"}</p>`}</section>` : ""}
  </div>`);
  root.querySelector("main").onclick = (ev) => {
    const b = ev.target.closest("[data-h]"); if (!b) return;
    ({ edit: () => openPatientEdit(p), band: () => printWristbandFor(p, ""), icu: () => chooseIcuBed(p), ward: () => openWardAdmission(p), op: () => openOperation(null, p), rep: () => chooseAdmissionForReport(p) })[b.dataset.h]();
  };
}

// دخول رعاية من ملف المريض: اختيار الوحدة والسرير
async function chooseIcuBed(p) {
  const occ = await bedOccupancy();
  const list = visibleUnits().filter((u) => canWriteUnit(u.id));
  const free = (u) => Array.from({ length: u.beds }, (_, i) => i + 1).filter((n) => !occ[u.id]?.has(n));
  const opts = list.filter((u) => free(u).length);
  if (!opts.length) { toast("مفيش أسرّة فاضية في وحداتك.", true); return; }
  const f = formDialog(`دخول رعاية: ${esc(p.name)}`, `
    <div class="row2">
      <label class="field"><span>الوحدة</span><select name="unit">${opts.map((u) => `<option value="${u.id}">${esc(u.name)} (${free(u).length} فاضي)</option>`).join("")}</select></label>
      <label class="field"><span>السرير</span><select name="bed"></select></label>
    </div>`, "متابعة", async (f) => {
    const u = unitById(f.elements.unit.value), bed = Number(f.elements.bed.value);
    setTimeout(() => openAdmissionDialog(u, bed, p), 0);
  });
  const fill = () => { const u = unitById(f.elements.unit.value); f.elements.bed.innerHTML = free(u).map((n) => `<option value="${n}">${esc(u.bedLabel)} ${n}</option>`).join(""); };
  f.elements.unit.onchange = fill; fill();
}

async function bedOccupancy() {
  const occ = {};
  const snap = await getDocs(collection(db, "beds"));
  snap.forEach((d) => { const x = d.data(); (occ[x.unitId] ||= new Set()).add(x.bed); });
  return occ;
}

/* ---------- الداخلي: خريطة الأسرّة ---------- */
function renderWard(filter) {
  const list = wardUnits();
  if (!list.length) {
    shell(`<div class="empty">لسه مفيش أقسام داخلي متسجلة.${isAdmin() ? ` ضيفها من <a href="#/settings/wardunits">الإعدادات > أقسام الداخلي</a>.` : " كلّم الأدمن."}</div>`);
    return;
  }
  const shown = filter ? list.filter((u) => u.id === filter) : list;
  const active = S.wardActive || [];
  const st = (u) => { const o = active.filter((a) => a.deptId === u.id).length; return { o, t: u.beds }; };
  let to = 0, tt = 0; list.forEach((u) => { const s = st(u); to += s.o; tt += s.t; });
  const w = canEdit("ward");
  shell(`
  <nav class="unit-bar"><a href="#/ward" class="chip ${!filter ? "on" : ""}">كل الأقسام <b>${to}/${tt}</b></a>
    ${list.map((u) => { const s = st(u); return `<a href="#/ward/${u.id}" class="chip ${filter === u.id ? "on" : ""}">${esc(u.name)} <b>${s.o}/${s.t}</b></a>`; }).join("")}</nav>
  ${shown.map((u) => {
    const s = st(u), byBed = {};
    active.filter((a) => a.deptId === u.id).forEach((a) => (byBed[a.bed] = a));
    let tiles = "";
    for (let n = 1; n <= u.beds; n++) {
      const a = byBed[n];
      if (a) tiles += `<a class="bed occ ward" href="#/w/${a.id}"><span class="bed-no">سرير ${n}</span>
        <span class="bed-day"><b>${dayOfStay(a.admitAt)}</b><small>يوم</small></span>
        <span class="bed-name">${esc(a.patientName)}</span><span class="bed-meta">${esc(a.consultant || "")}</span></a>`;
      else if (w && S.wardActive) tiles += `<button class="bed free" data-dept="${u.id}" data-bed="${n}"><span class="bed-no">سرير ${n}</span><span class="bed-state">فارغ، سجّل دخول</span></button>`;
      else tiles += `<div class="bed free"><span class="bed-no">سرير ${n}</span><span class="bed-state">${S.wardActive ? "فارغ" : "…"}</span></div>`;
    }
    const pct = s.t ? Math.round((s.o / s.t) * 100) : 0;
    return `<section class="unit"><header class="unit-head"><h2><a href="#/ward/${u.id}">${esc(u.name)}</a></h2>
      <div class="unit-stats"><span><b>${s.o}</b> مشغول</span><span class="s-free"><b>${s.t - s.o}</b> فارغ</span><span>من <b>${s.t}</b></span></div>
      <div class="meter"><i style="width:${pct}%"></i></div></header><div class="beds">${tiles}</div></section>`;
  }).join("")}`);
  root.querySelectorAll("button.bed.free[data-dept]").forEach((b) => (b.onclick = () =>
    pickPatient(`دخول داخلي: ${esc(wardById(b.dataset.dept).name)}، سرير ${b.dataset.bed}`, (p) => openWardAdmission(p, b.dataset.dept, Number(b.dataset.bed)))));
}

/* ---------- دخول داخلي ---------- */
async function openWardAdmission(p, deptId, bed, extra = {}) {
  if (p.currentAdmissionId || p.currentWardId) { toast("المريض ده موجود حالياً في دخول تاني.", true); return; }
  let occ;
  try { occ = await bedOccupancy(); } catch (e) { toast(errText(e), true); return; }
  const free = (u) => Array.from({ length: u.beds }, (_, i) => i + 1).filter((n) => !occ[u.id]?.has(n));
  const opts = wardUnits().filter((u) => free(u).length || u.id === deptId);
  if (!opts.length) { toast("مفيش أسرّة فاضية في الداخلي.", true); return; }
  const s = S.settings;
  const f = formDialog(`دخول داخلي: ${esc(p.name)}`, `
    <p class="muted" style="margin:0">${esc(p.medicalId || "")}${p.nationalId ? `، ${esc(p.nationalId)}` : ""}</p>
    <div class="row2">
      <label class="field"><span>القسم</span><select name="dept">${opts.map((u) => `<option value="${u.id}" ${u.id === deptId ? "selected" : ""}>${esc(u.name)} (${free(u).length} فاضي)</option>`).join("")}</select></label>
      <label class="field"><span>السرير</span><select name="bed"></select></label>
    </div>
    <label class="field"><span>تاريخ ووقت الدخول</span><input name="admitAt" type="datetime-local" value="${toLocalInput(new Date())}" max="${toLocalInput(new Date())}"></label>
    <div class="row2">
      <label class="field"><span>استشاري الحالة</span><select name="consultant" data-autoresp>${optionsHtml(s.consultants || [], extra.consultant || "")}</select></label>
      <label class="field"><span>المعاملة المالية</span><select name="finance">${optionsHtml(listOf("financeTypes"), extra.finance || "")}</select></label>
    </div>
    <label class="field"><span>القسم المسؤول (القسم اللي الحالة تحت إشرافه)</span><select name="responsible">${optionsHtml(s.specialties || [], extra.responsible || respOf(extra.consultant))}</select></label>
    <div class="field"><span>الإشراف المشترك</span>${checksHtml("spec", s.specialties || [], extra.specialties || [])}</div>
    <label class="field"><span>التشخيص</span><textarea name="diagnosis" rows="2" class="ltr-auto">${esc(extra.diagnosis || "")}</textarea></label>`,
    "حفظ الدخول", async (f) => {
      const dept = f.elements.dept.value, b = Number(f.elements.bed.value);
      if (!dept || !b) return "اختر القسم والسرير.";
      const at = new Date(f.elements.admitAt.value);
      if (isNaN(at) || at > new Date(Date.now() + 5 * 60e3)) return "تاريخ الدخول غير صحيح.";
      if (!f.elements.consultant.value) return "اختر استشاري الحالة.";
      if (!f.elements.finance.value) return "اختر المعاملة المالية.";
      if ((s.specialties || []).length && !f.elements.responsible.value) return "اختر القسم المسؤول.";
      const id = await createWardAdmission(p, dept, b, at, {
        consultant: f.elements.consultant.value, finance: f.elements.finance.value, responsible: f.elements.responsible.value,
        specialties: checkedValues(f, "spec"), diagnosis: f.elements.diagnosis.value.trim(),
      });
      toast("تم تسجيل الدخول");
      location.hash = `#/w/${id}`;
    });
  const fill = () => { const u = wardById(f.elements.dept.value); f.elements.bed.innerHTML = free(u).map((n) => `<option value="${n}" ${n === bed ? "selected" : ""}>سرير ${n}</option>`).join(""); };
  f.elements.dept.onchange = fill; fill();
}

// بيتستخدم كمان من خروج الرعاية "تحويل للداخلي" (tx موجودة) أو لوحده
function wardAdmissionData(p, dept, bed, at, d, num, mr, source) {
  return {
    patientId: p.id, patientName: p.name, medicalId: mr || p.medicalId || "", nationalId: p.nationalId || "",
    gender: p.gender || "", birthDate: p.birthDate || "", birthDateEstimated: !!p.birthDateEstimated,
    deptId: dept, bed, admitAt: Timestamp.fromDate(at), admissionNumber: `${mr || p.medicalId || ""}-D${num}`, wardNo: num,
    consultant: d.consultant || "", responsible: d.responsible || "", specialties: d.specialties || [], finance: d.finance || "",
    financeHistory: d.finance ? [{ type: d.finance, from: isoDay(at), byName: S.profile.displayName }] : [],
    diagnosis: d.diagnosis || "", history: d.history || "", xrays: "", labs: "", requests: "",
    status: "active", ...(source || {}),
    deptAccess: deptAccessOf({ consultant: d.consultant, specialties: d.specialties, responsible: d.responsible }),
    createdBy: S.profile.uid, createdByName: S.profile.displayName, createdAt: serverTimestamp(),
  };
}

async function createWardAdmission(p, dept, bed, at, d) {
  const pRef = doc(db, "patients", p.id), bedRef = doc(db, "beds", `${dept}_${bed}`), cRef = doc(db, "config", "counters");
  const wRef = doc(collection(db, "wardAdmissions"));
  await runTransaction(db, async (tx) => {
    const bs = await tx.get(bedRef); if (bs.exists()) throw new Error("BED_TAKEN");
    const ps = await tx.get(pRef); const pd = ps.data();
    if (pd.currentAdmissionId || pd.currentWardId) throw new Error("PATIENT_ADMITTED");
    const cs = await tx.get(cRef); const c = { mr: 1000, ...(cs.exists() ? cs.data() : {}) };
    const num = (pd.wardCount || 0) + 1;
    let mr = pd.medicalId;
    if (!mr) { c.mr += 1; mr = `MR-${c.mr}`; tx.set(cRef, { mr: c.mr }, { merge: true }); }
    tx.set(bedRef, { unitId: dept, bed, admissionId: wRef.id, section: "ward", since: serverTimestamp() });
    tx.set(wRef, wardAdmissionData({ id: p.id, ...pd }, dept, bed, at, d, num, mr));
    tx.update(pRef, { currentWardId: wRef.id, medicalId: mr, wardCount: num,
      visits: arrayUnion(visitEntry("ward", wRef.id, `${mr}-D${num}`, Timestamp.fromDate(at), wardById(dept)?.name)) });
  });
  audit("دخول داخلي", { adm: { id: wRef.id, patientName: p.name, unitId: dept } });
  return wRef.id;
}

/* ---------- صفحة دخول الداخلي ---------- */
function renderWardAdmission(id) {
  shell(`<div class="loading">جاري التحميل…</div>`);
  const W = (S.W = { id, a: null, meds: [], p: null, notes: [], creqs: [], ops: [] });
  const draw = () => { if (S.W === W && S.page === "wadm" && W.a) drawWardAdmission(); };
  S.pageUnsubs.push(onSnapshot(doc(db, "wardAdmissions", id), (s) => {
    if (!s.exists()) { shell(`<div class="empty">الملف غير موجود.</div>`); return; }
    W.a = { id: s.id, ...s.data() };
    if (!W.pSub && !isDept()) { W.pSub = true; S.pageUnsubs.push(onSnapshot(doc(db, "patients", W.a.patientId), (ps) => { W.p = { id: ps.id, ...ps.data() }; draw(); }, () => {})); }
    draw();
  }, () => {
    if (isDept()) { toast("مبقاش ليك صلاحية على الحالة دي (تم الرد أو الحالة خرجت)"); location.hash = "#/"; return; }
    shell(`<div class="empty">ليس لديك صلاحية لعرض هذا الملف. الحالات اللي خرجت بتظهر للأدمن فقط. <a href="#/ward">ارجع للداخلي</a></div>`);
  }));
  S.pageUnsubs.push(onSnapshot(collection(db, "wardAdmissions", id, "opinions"), (s) => { W.ops = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {}));
  S.pageUnsubs.push(onSnapshot(collection(db, "wardAdmissions", id, "notes"), (s) => { W.notes = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {}));
  S.pageUnsubs.push(onSnapshot(consultsQ(id), (s) => { W.creqs = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {}));
  S.pageUnsubs.push(onSnapshot(collection(db, "wardAdmissions", id, "medlog"), (s) => {
    W.meds = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw();
  }, () => {}));
}

function medlogHtml(meds, canW, canGive = canW) {
  const rows = [...meds].sort((x, y) => toDate(y.createdAt || y.at) - toDate(x.createdAt || x.at));
  return `
  ${canW ? `<form class="med-add" data-medadd>
    <input name="drug" list="dlDrugs2" placeholder="اسم الدواء" class="ltr" autocomplete="off">
    <input name="dose" placeholder="الجرعة" class="ltr"><input name="schedule" placeholder="الموعد" class="ltr">
    <button class="btn sm">إضافة</button></form>
    <datalist id="dlDrugs2">${(S.settings.drugs || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : ""}
  ${rows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>الدواء</th><th>الجرعة</th><th>الموعد</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${rows.map((m) => `<tr><td class="ltr"><strong>${esc(m.drug)}</strong></td><td class="ltr">${esc(m.dose)}</td><td class="ltr">${esc(m.schedule)}</td>
      <td>${m.given ? `<span class="dis">تم</span> <span class="by-line">${fmtDateTime(m.givenAt)}، ${esc(m.givenByName || "")}</span>` : `<span class="wait">لم يُعطَ</span>`}</td>
      <td>${canGive && !m.given ? `<button class="btn ghost sm" data-given="${m.id}">تم الإعطاء</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">لا يوجد أدوية مسجلة.</p>`}`;
}
function bindMedlog(container, colPath) {
  const f = container.querySelector("[data-medadd]");
  if (f) f.onsubmit = async (ev) => {
    ev.preventDefault();
    const drug = f.elements.drug.value.trim();
    if (!drug) { toast("اكتب اسم الدواء", true); return; }
    try {
      await addDoc(collection(db, ...colPath, "medlog"), { drug, dose: f.elements.dose.value.trim(), schedule: f.elements.schedule.value.trim(),
        given: false, at: Timestamp.now(), ...meta() });
      toast("تمت إضافة الدواء");
    } catch (e) { toast(errText(e), true); }
  };
  container.querySelectorAll("[data-given]").forEach((b) => (b.onclick = async () => {
    try {
      await updateDoc(doc(db, ...colPath, "medlog", b.dataset.given), { given: true, givenAt: Timestamp.now(), givenBy: S.profile.uid, givenByName: S.profile.displayName });
    } catch (e) { toast(errText(e), true); }
  }));
}

function drawWardAdmission() {
  const { a, meds } = S.W;
  const u = wardById(a.deptId) || { name: a.deptId };
  const active = a.status === "active";
  const canW = canEdit("ward") && (active || isAdmin());
  const txt = (v) => (v ? `<div class="pre-wrap ltr-auto">${esc(v)}</div>` : `<span class="muted">—</span>`);
  shell(`
  <div class="file-head">
    <a class="back" href="${isDept() ? "#/" : `#/ward/${a.deptId}`}">${isDept() ? `قسم ${esc(S.profile.deptSpecialty)}` : esc(u.name)}</a>
    <h1>${isDept() ? esc(a.patientName) : `<a href="#/p/${a.patientId}" class="plain">${esc(a.patientName)}</a>`}</h1>
    <div class="tags">
      ${a.medicalId ? `<span class="tag mr">${esc(a.medicalId)}</span>` : ""}
      <span class="tag">${esc(u.name)}، سرير ${a.bed}</span>
      ${active ? `<span class="tag day">اليوم ${stayDays(a)} للإقامة</span>` : `<span class="tag archived">خرج: ${WARD_DIS[a.dischargeType] || ""}</span>`}
      ${a.source === "icu" ? `<a class="tag" href="#/patient/${a.sourceId}">محوّل من الرعاية</a>` : ""}
    </div>
    <div class="file-actions">
      ${canW ? `<button class="btn ghost" data-w="edit">تعديل</button>` : ""}
      ${active && canEdit("ward") ? `<button class="btn ghost" data-w="transfer">نقل</button><button class="btn danger" data-w="discharge">خروج</button>` : ""}
      ${canEditAny() ? `<button class="btn ghost" data-w="band">بطاقة تعريف</button>` : ""}
      ${canPrint() ? `<button class="btn ghost" data-w="print">طباعة / PDF</button>` : ""}
      ${canEdit("reports") ? `<button class="btn ghost" data-w="report">تقرير طبي</button>` : ""}
      ${isAdmin() ? `<button class="btn ghost del" data-w="del">حذف الدخول</button>` : ""}
    </div>
  </div>
  <div class="file-grid">
    <section class="panel"><header><h2>بيانات الدخول</h2></header>
      <dl class="kv">
        <dt>رقم الدخول</dt><dd class="ltr">${esc(a.admissionNumber || "—")}</dd>
        <dt>تاريخ الدخول</dt><dd>${fmtDateTime(a.admitAt)}</dd>
        <dt>أيام الإقامة</dt><dd>${stayDays(a)} يوم</dd>
        <dt>استشاري الحالة</dt><dd>${esc(a.consultant || "—")}</dd>
        <dt>الإشراف المشترك</dt><dd>${(a.specialties || []).map((x) => `<span class="pill">${esc(x)}</span>`).join("") || "—"}</dd>
        <dt>المعاملة المالية</dt><dd>${finInfoHtml(a, canW)}</dd>
        <dt>سجّل الدخول</dt><dd>${esc(a.createdByName || "")}</dd>
      </dl></section>
    ${a.status === "discharged" ? `<section class="panel dis-panel"><header><h2>بيانات الخروج</h2><button class="btn ghost sm" data-w="dsum">${a.dischargeType === "death" ? "تقرير الوفاة" : "تقرير الخروج"}</button></header>
      <dl class="kv"><dt>نوع الخروج</dt><dd><strong>${WARD_DIS[a.dischargeType] || ""}</strong></dd>
        <dt>وقت الخروج</dt><dd>${fmtDateTime(a.dischargeAt)}</dd>
        <dt>المعاملة المالية</dt><dd>${esc(finText(finBreakdown(a)))}</dd>
        ${a.dischargeInfo?.deathCause ? `<dt>سبب الوفاة</dt><dd>${esc(a.dischargeInfo.deathCause)}</dd>` : ""}
        ${a.dischargeInfo?.dept ? `<dt>القسم المحول إليه</dt><dd>${esc(a.dischargeInfo.dept)}</dd>` : ""}
        ${a.dischargeInfo?.notes ? `<dt>ملاحظات</dt><dd>${esc(a.dischargeInfo.notes)}</dd>` : ""}
        <dt>سجّل الخروج</dt><dd>${esc(a.dischargedByName || "")}</dd></dl></section>` : `
    <section class="panel"><header><h2>التشخيص والتاريخ المرضي</h2></header>
      <dl class="kv"><dt>التشخيص</dt><dd>${txt(a.diagnosis)}</dd><dt>التاريخ المرضي</dt><dd>${txt(a.history)}</dd></dl></section>`}
  </div>
  ${a.status === "discharged" ? `<section class="panel stack-gap"><header><h2>التشخيص والتاريخ المرضي</h2></header>
      <dl class="kv"><dt>التشخيص</dt><dd>${txt(a.diagnosis)}</dd><dt>التاريخ المرضي</dt><dd>${txt(a.history)}</dd></dl></section>` : ""}
  <section class="panel stack-gap"><header><h2>الطلبات</h2></header>
    <dl class="kv"><dt>أشعات مطلوبة</dt><dd>${txt(a.xrays)}</dd><dt>تحاليل مطلوبة</dt><dd>${txt(a.labs)}</dd><dt>عروض مطلوبة</dt><dd>${txt(a.requests)}</dd></dl></section>
  <section class="panel stack-gap" id="wMeds"><header><h2>سجل الأدوية</h2></header>${medlogHtml(meds, canW && active, active && (canEdit("ward") || isNurse("ward")))}</section>
  ${wardOpinionsHtml(S.W.ops || [], active && (canEdit("ward") || deptCanOpinion(a)))}
  ${wardNotesHtml(S.W.notes || [], active && (canEdit("ward") || isNurse("ward")))}
  <section class="panel stack-gap" id="wCreqs"><header><h2>طلبات الاستشارة</h2>${active && canEdit("ward") ? `<button class="btn ghost sm" data-w="consultReq">طلب استشارة</button>` : ""}</header>
    ${consultListHtml(S.W.creqs || [], true)}</section>
  ${wardMovesHtml(a)}
  ${S.W.p?.visits?.length ? `<section class="panel stack-gap">${visitsListHtml(S.W.p, a.id)}</section>` : ""}`);
  bindMedlog(document.getElementById("wMeds"), ["wardAdmissions", a.id]);
  bindWardNotes(a.id);
  bindConsultActions(document.getElementById("wCreqs"), S.W.creqs || []);
  root.querySelector("main").onclick = (ev) => {
    const b = ev.target.closest("[data-w],[data-act]"); if (!b) return;
    if (b.dataset.act === "finChange") return openFinanceChange(a, "wardAdmissions");
    if (b.dataset.act === "finDel") return deleteFinance(b.dataset.from, a, "wardAdmissions");
    ({ edit: () => openWardEdit(a), discharge: () => openWardDischarge(a), band: () => printWristbandFor({ ...a, name: a.patientName }, `${u.name}، سرير ${a.bed}`), print: () => printWard(a, meds),
      report: () => openReportForm({ type: "ward", adm: a }), del: () => deleteWardAdmission(a, meds), transfer: () => openWardTransfer(a), dsum: () => dischargeSummaryAction("ward"), consultReq: () => openConsultRequest("ward", a), opAdd: () => openWardOpinion(a) })[b.dataset.w]?.();
  };
}

function openWardEdit(a) {
  const s = S.settings;
  const chips = (k) => listOf(`historyOptions.${k}`).map((o) => `<button type="button" class="opt" data-f="history" data-v="${esc(o)}">${esc(o)}</button>`).join("");
  const hist = ["complaint", "pmh", "psh", "drugs", "allergy"].map(chips).join("");
  formDialog("تعديل بيانات الدخول", `
    <label class="field"><span>استشاري الحالة</span><select name="consultant" data-autoresp>${optionsHtml(s.consultants || [], a.consultant)}</select></label>
    <label class="field"><span>القسم المسؤول</span><select name="responsible">${optionsHtml(s.specialties || [], a.responsible || respOf(a.consultant))}</select></label>
    <div class="field"><span>الإشراف المشترك</span>${checksHtml("spec", [...new Set([...(s.specialties || []), ...(a.specialties || [])])], a.specialties || [])}</div>
    ${listOf("diagnoses").length ? `<label class="field"><span>اختر من قائمة التشخيصات</span><input name="dxPick" list="dlDxW" class="ltr" autocomplete="off">
      <datalist id="dlDxW">${listOf("diagnoses").map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>` : ""}
    <label class="field"><span>التشخيص</span><textarea name="diagnosis" rows="2" class="ltr-auto">${esc(a.diagnosis || "")}</textarea></label>
    <div class="field"><span>التاريخ المرضي</span><textarea name="history" rows="3" class="ltr-auto">${esc(a.history || "")}</textarea>
      ${hist ? `<div class="opt-chips">${hist}</div>` : ""}</div>
    <label class="field"><span>أشعات مطلوبة</span><textarea name="xrays" rows="2" class="ltr-auto">${esc(a.xrays || "")}</textarea></label>
    <label class="field"><span>تحاليل مطلوبة</span><textarea name="labs" rows="2" class="ltr-auto">${esc(a.labs || "")}</textarea></label>
    <label class="field"><span>عروض مطلوبة</span><textarea name="requests" rows="2" class="ltr-auto">${esc(a.requests || "")}</textarea></label>
`,
    "حفظ التعديل", async (f) => {
      if (!f.elements.consultant.value) return "اختر استشاري الحالة.";
      if ((s.specialties || []).length && !f.elements.responsible.value) return "اختر القسم المسؤول.";
      const upd = { consultant: f.elements.consultant.value, responsible: f.elements.responsible.value, specialties: checkedValues(f, "spec"), deptAccess: [],
        diagnosis: f.elements.diagnosis.value.trim(), history: f.elements.history.value.trim(),
        xrays: f.elements.xrays.value.trim(), labs: f.elements.labs.value.trim(), requests: f.elements.requests.value.trim(), ...upMeta() };
      upd.deptAccess = deptAccessOf({ ...a, ...upd });
      await updateDoc(doc(db, "wardAdmissions", a.id), upd);
      const { id, ...before } = a;
      audit("تعديل دخول داخلي", { adm: { id: a.id, patientName: a.patientName, unitId: a.deptId },
        before: { consultant: before.consultant, diagnosis: before.diagnosis, history: before.history } });
      toast("تم حفظ التعديل");
    });
  bindOptChips();
  const pick = document.querySelector('#gForm input[name="dxPick"]');
  if (pick) pick.onchange = () => { if (listOf("diagnoses").includes(pick.value.trim())) { appendTo(document.querySelector('#gForm textarea[name="diagnosis"]'), pick.value.trim()); pick.value = ""; } };
}

function openWardDischarge(a) {
  const f = formDialog(`خروج: ${esc(a.patientName)}`, `
    <fieldset class="seg seg-wrap">${Object.entries(WARD_DIS).map(([k, l], i) => `<label><input type="radio" name="dtype" value="${k}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    <label class="field"><span>وقت الخروج</span><input name="at" type="datetime-local" value="${toLocalInput(new Date())}" max="${toLocalInput(new Date())}"></label>
    <label class="field df d-death"><span>سبب الوفاة</span><textarea name="deathCause" rows="2"></textarea></label>
    <label class="field df d-otherDept"><span>القسم المحول إليه</span><input name="dept"></label>
    <label class="field"><span>ملاحظات (اختياري)</span><textarea name="notes" rows="2"></textarea></label>
    <div class="checks"><label><input type="checkbox" name="writeDs" checked> اكتب تقرير الخروج (أو الوفاة) بعد التأكيد</label></div>
    <p class="note">بعد الخروج السرير بيفضى والملف بيتقفل، ومش هيتعدل غير من الأدمن.${" "}في "تحويل للرعاية" هيتفتح ملف المريض عشان تسجل دخول الرعاية.</p>`,
    "تأكيد الخروج", async (f) => {
      const type = f.querySelector('input[name="dtype"]:checked').value;
      const at = new Date(f.elements.at.value);
      if (isNaN(at) || at > new Date(Date.now() + 5 * 60e3)) return "وقت الخروج غير صحيح.";
      if (at < toDate(a.admitAt)) return "وقت الخروج لازم يكون بعد وقت الدخول.";
      const info = { notes: f.elements.notes.value.trim() };
      if (type === "death") { info.deathCause = f.elements.deathCause.value.trim(); if (!info.deathCause) return "اكتب سبب الوفاة."; }
      if (type === "otherDept") { info.dept = f.elements.dept.value.trim(); if (!info.dept) return "اكتب القسم المحول إليه."; }
      const dsCtx = f.elements.writeDs.checked ? await buildDischargeContext("ward") : null;
      const wRef = doc(db, "wardAdmissions", a.id), pRef = doc(db, "patients", a.patientId), bRef = doc(db, "beds", `${a.deptId}_${a.bed}`);
      await runTransaction(db, async (tx) => {
        const cur = (await tx.get(wRef)).data();
        if (cur.status !== "active") throw new Error("ALREADY_OUT");
        const bs = await tx.get(bRef), ps = await tx.get(pRef);
        tx.update(wRef, { status: "discharged", dischargeAt: Timestamp.fromDate(at), dischargeType: type, dischargeInfo: info, deptAccess: [],
          dischargedBy: S.profile.uid, dischargedByName: S.profile.displayName, ...upMeta() });
        if (bs.exists() && bs.data().admissionId === a.id) tx.delete(bRef);
        if (ps.exists()) tx.update(pRef, { ...(ps.data().currentWardId === a.id ? { currentWardId: null } : {}), visits: visitsAfterDischarge(ps.data(), a.id, at, type) });
      });
      audit(`خروج داخلي: ${WARD_DIS[type]}`, { adm: { id: a.id, patientName: a.patientName, unitId: a.deptId }, details: info });
      toast(`تم تسجيل الخروج (${WARD_DIS[type]})`);
      const go = () => (location.hash = type === "icu" ? `#/p/${a.patientId}` : isAdmin() ? location.hash : `#/ward/${a.deptId}`);
      setTimeout(() => { go(); if (dsCtx) openDischargeSummary({ ...dsCtx, dis: { at: Timestamp.fromDate(at), type, info } }); }, 0);
    });
  const sync = () => (f.dataset.dtype = f.querySelector('input[name="dtype"]:checked').value);
  f.querySelectorAll('input[name="dtype"]').forEach((r) => (r.onchange = sync)); sync();
}

function printWard(a, meds) {
  const u = wardById(a.deptId) || { name: a.deptId };
  const row = (l, v) => (v ? `<dt>${l}</dt><dd class="pre ltr">${esc(v)}</dd>` : "");
  printDoc(`${a.patientName}`, `
    <h1>${esc(a.patientName)}</h1>
    <p class="sub">${esc(a.medicalId || "")}، دخول ${esc(a.admissionNumber || "")}، ${esc(u.name)} سرير ${a.bed}، ${fmtDateTime(a.admitAt)}، ${stayDays(a)} يوم إقامة
      ${a.status === "discharged" ? `، خرج ${fmtDateTime(a.dischargeAt)} (${WARD_DIS[a.dischargeType] || ""})` : ""}</p>
    <h2>بيانات الدخول</h2><dl class="kv">${row("استشاري الحالة", a.consultant)}${row("الإشراف المشترك", (a.specialties || []).join("، "))}
      ${row("المعاملة المالية", finText(finBreakdown(a)))}${row("التشخيص", a.diagnosis)}${row("التاريخ المرضي", a.history)}
      ${row("أشعات مطلوبة", a.xrays)}${row("تحاليل مطلوبة", a.labs)}${row("عروض مطلوبة", a.requests)}
      ${a.dischargeInfo?.deathCause ? row("سبب الوفاة", a.dischargeInfo.deathCause) : ""}${row("ملاحظات الخروج", a.dischargeInfo?.notes)}</dl>
    ${meds.length ? `<h2>سجل الأدوية</h2><table><thead><tr><th>الدواء</th><th>الجرعة</th><th>الموعد</th><th>الإعطاء</th></tr></thead><tbody>${meds.map((m) =>
      `<tr><td class="ltr">${esc(m.drug)}</td><td class="ltr">${esc(m.dose)}</td><td class="ltr">${esc(m.schedule)}</td><td>${m.given ? fmtDateTime(m.givenAt) : "لم يُعطَ"}</td></tr>`).join("")}</tbody></table>` : ""}
    <div class="sign"><span>توقيع الطبيب: ....................</span><span>توقيع الاستشاري: ....................</span></div>`, true);
}

function printWristbandFor(p, place) {
  printDoc(`بطاقة ${p.name}`, `
    <style>.ph{display:none}.card{border:2px solid #0E6B63;border-radius:10px;padding:14px 18px;width:88mm;margin:0 auto;text-align:center}
      .card .n{font-size:16pt;font-weight:700}.card .mr{font-size:22pt;font-weight:700;letter-spacing:2px;margin:8px 0;padding:6px;background:#EDF2F0;border-radius:8px;direction:ltr}
      .card .r{font-size:10.5pt}</style>
    <div class="card"><div class="n">${esc(p.name)}</div><div class="mr">${esc(p.medicalId || "")}</div>
      <div class="r">السن: ${esc(ageText(p.birthDate, p.birthDateEstimated)) || "—"}، ${genderText(p.gender)}</div>
      <div class="r">${p.nationalId ? `الرقم القومي: <span class="ltr">${esc(p.nationalId)}</span>` : p.motherName ? `الأم: ${esc(p.motherName)}` : ""}</div>
      ${place ? `<div class="r">${esc(place)}</div>` : ""}</div>`, false);
}

/* ---------- العمليات ---------- */
function renderOps() {
  const T = (S.O ||= { from: isoDay(new Date()), to: addDays(isoDay(new Date()), 7), status: "scheduled" });
  shell(`
  <div class="toolbar"><h2>العمليات</h2>${canEdit("ops") ? `<button class="btn" id="newOp">حجز عملية</button>` : ""}</div>
  <form class="filters" id="opF">
    <label class="field"><span>من</span><input type="date" name="from" value="${T.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${T.to}"></label>
    <label class="field"><span>الحالة</span><select name="status"><option value="">الكل</option>${Object.entries(OP_STATUS).map(([k, l]) => `<option value="${k}" ${T.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <button class="btn">عرض</button>
  </form>
  <div id="opBody"><div class="loading">جاري التحميل…</div></div>`);
  document.getElementById("newOp")?.addEventListener("click", () => pickPatient("حجز عملية", (p) => openOperation(null, p)));
  const f = document.getElementById("opF");
  const load = async () => {
    Object.assign(T, { from: f.elements.from.value, to: f.elements.to.value, status: f.elements.status.value });
    const body = document.getElementById("opBody");
    try {
      const snap = await getDocs(query(collection(db, "operations"), where("proposedAt", ">=", Timestamp.fromDate(new Date(T.from + "T00:00:00"))),
        where("proposedAt", "<=", Timestamp.fromDate(new Date(T.to + "T23:59:59"))), orderBy("proposedAt")));
      let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (T.status) rows = rows.filter((r) => r.status === T.status);
      let lastDay = "";
      body.innerHTML = rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>الميعاد</th><th>المريض</th><th>العملية</th><th>التخصص</th><th>الاستشاري</th><th>التخدير</th><th>النوع</th><th>الحالة</th></tr></thead>
        <tbody>${rows.map((o) => {
          const d = isoDay(toDate(o.proposedAt));
          const head = d !== lastDay ? `<tr class="day-row"><td colspan="8">${new Intl.DateTimeFormat("ar-EG", { weekday: "long" }).format(toDate(o.proposedAt))} ${fmtDate(d)}</td></tr>` : "";
          lastDay = d;
          return head + `<tr><td class="nowrap"><a href="#/o/${o.id}"><strong>${fmtTime(o.proposedAt)}</strong></a></td>
            <td><a href="#/o/${o.id}">${esc(o.patientName)}</a><div class="by-line ltr">${esc(o.medicalId || "")}</div></td>
            <td class="ltr-auto">${esc(o.operation)}</td><td>${esc(o.specialty || "")}</td><td>${esc(o.consultant || "")}</td><td>${esc(o.anesthesia || "")}</td>
            <td>${o.caseType === "طوارئ" ? `<span class="dis t-death">طوارئ</span>` : esc(o.caseType || "")}</td>
            <td><span class="dis op-${o.status}">${OP_STATUS[o.status]}</span></td></tr>`;
        }).join("")}</tbody></table></div>` : `<div class="empty">مفيش عمليات في الفترة دي.</div>`;
    } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); load(); };
  load();
}

function openOperation(o, p) {
  const s = S.settings;
  const x = o || {};
  formDialog(o ? "تعديل العملية" : `حجز عملية: ${esc(p.name)}`, `
    <div class="row2">
      <label class="field"><span>التخصص</span><select name="specialty">${optionsHtml(s.specialties || [], x.specialty || "")}</select></label>
      <label class="field"><span>نوع الحالة</span><select name="caseType">${optionsHtml(CASE_TYPES, x.caseType || "")}</select></label>
    </div>
    <label class="field"><span>التشخيص</span><input name="diagnosis" class="ltr-auto" list="dlDxO" value="${esc(x.diagnosis || "")}" autocomplete="off">
      <datalist id="dlDxO">${listOf("diagnoses").map((d) => `<option value="${esc(d)}">`).join("")}</datalist></label>
    <label class="field"><span>العملية</span><input name="operation" class="ltr-auto" list="dlOps" value="${esc(x.operation || "")}" autocomplete="off">
      <datalist id="dlOps">${listOf("operations").map((d) => `<option value="${esc(d)}">`).join("")}</datalist></label>
    <label class="field"><span>الميعاد المقترح (اليوم والساعة)</span><input name="proposedAt" type="datetime-local" value="${x.proposedAt ? toLocalInput(toDate(x.proposedAt)) : ""}"></label>
    <div class="row2">
      <label class="field"><span>استشاري الحالة</span><select name="consultant">${optionsHtml(s.consultants || [], x.consultant || "")}</select></label>
      <label class="field"><span>استشاري التخدير</span><select name="anesthesia">${optionsHtml(listOf("anesthesiaConsultants"), x.anesthesia || "")}</select></label>
    </div>
    <label class="field"><span>المعاملة المالية</span><select name="finance">${optionsHtml(listOf("financeTypes"), x.finance || "")}</select></label>
    <label class="field"><span>ملاحظات</span><textarea name="notes" rows="2">${esc(x.notes || "")}</textarea></label>`,
    o ? "حفظ التعديل" : "حجز العملية", async (f) => {
      const d = { specialty: f.elements.specialty.value, caseType: f.elements.caseType.value, diagnosis: f.elements.diagnosis.value.trim(),
        operation: f.elements.operation.value.trim(), consultant: f.elements.consultant.value, anesthesia: f.elements.anesthesia.value,
        finance: f.elements.finance.value, notes: f.elements.notes.value.trim() };
      if (!d.operation) return "اكتب اسم العملية.";
      if (!f.elements.proposedAt.value) return "حدد الميعاد المقترح.";
      d.proposedAt = Timestamp.fromDate(new Date(f.elements.proposedAt.value));
      if (o) {
        await updateDoc(doc(db, "operations", o.id), { ...d, ...upMeta() });
        audit("تعديل عملية", { adm: { id: o.id, patientName: o.patientName, unitId: "" }, before: { operation: o.operation, proposedAt: o.proposedAt } });
        toast("تم حفظ التعديل");
        return;
      }
      const cRef = doc(db, "config", "counters"), oRef = doc(collection(db, "operations")), pRef = doc(db, "patients", p.id);
      await runTransaction(db, async (tx) => {
        const cs = await tx.get(cRef), pd = (await tx.get(pRef)).data();
        const n = (pd.opsCount || 0) + 1;
        let mr = pd.medicalId;
        if (!mr) { mr = `MR-${(cs.exists() ? cs.data().mr || 1000 : 1000) + 1}`; tx.set(cRef, { mr: Number(mr.slice(3)) }, { merge: true }); }
        tx.set(oRef, { ...d, patientId: p.id, patientName: p.name, medicalId: mr, nationalId: p.nationalId || "",
          number: `${mr}-O${n}`, opNo: n, status: "scheduled", ...meta() });
        tx.update(pRef, { opsCount: n, medicalId: mr });
      });
      audit("حجز عملية", { adm: { id: oRef.id, patientName: p.name, unitId: "" } });
      toast("تم حجز العملية");
      location.hash = `#/o/${oRef.id}`;
    });
}

function renderOperation(id) {
  shell(`<div class="loading">جاري التحميل…</div>`);
  const O = (S.OP = { id, o: null, meds: [] });
  const draw = () => { if (S.OP === O && S.page === "op" && O.o) drawOperation(); };
  S.pageUnsubs.push(onSnapshot(doc(db, "operations", id), (s) => {
    if (!s.exists()) { shell(`<div class="empty">العملية غير موجودة.</div>`); return; }
    O.o = { id: s.id, ...s.data() }; draw();
  }, () => shell(`<div class="empty">ليس لديك صلاحية لعرض العمليات.</div>`)));
  S.pageUnsubs.push(onSnapshot(collection(db, "operations", id, "medlog"), (s) => { O.meds = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {}));
}

function drawOperation() {
  const { o, meds } = S.OP;
  const canW = canEdit("ops") && (o.status === "scheduled" || isAdmin());
  shell(`
  <div class="file-head">
    <a class="back" href="#/ops">العمليات</a>
    <h1>${esc(o.operation)}</h1>
    <div class="tags"><a class="tag" href="#/p/${o.patientId}"><strong>${esc(o.patientName)}</strong></a>
      ${o.medicalId ? `<span class="tag mr">${esc(o.medicalId)}</span>` : ""}<span class="tag mr">${esc(o.number || "")}</span>
      <span class="dis op-${o.status}">${OP_STATUS[o.status]}</span>
      ${o.caseType === "طوارئ" ? `<span class="tag hot">طوارئ</span>` : ""}</div>
    <div class="file-actions">
      ${canW ? `<button class="btn ghost" data-o="edit">تعديل</button>` : ""}
      ${canEdit("ops") && o.status === "scheduled" ? `<button class="btn" data-o="done">تم التنفيذ</button><button class="btn ghost del" data-o="cancel">إلغاء العملية</button>` : ""}
      ${canPrint() ? `<button class="btn ghost" data-o="print">طباعة</button>` : ""}
      ${isAdmin() ? `<button class="btn ghost del" data-o="del">حذف</button>` : ""}
    </div>
  </div>
  <div class="file-grid">
    <section class="panel"><header><h2>بيانات العملية</h2></header><dl class="kv">
      <dt>التخصص</dt><dd>${esc(o.specialty || "—")}</dd><dt>التشخيص</dt><dd class="ltr-auto">${esc(o.diagnosis || "—")}</dd>
      <dt>الميعاد المقترح</dt><dd>${fmtDateTime(o.proposedAt)}</dd>
      <dt>ميعاد التنفيذ</dt><dd>${o.doneAt ? fmtDateTime(o.doneAt) : "—"}</dd>
      <dt>استشاري الحالة</dt><dd>${esc(o.consultant || "—")}</dd><dt>استشاري التخدير</dt><dd>${esc(o.anesthesia || "—")}</dd>
      <dt>نوع الحالة</dt><dd>${esc(o.caseType || "—")}</dd><dt>المعاملة المالية</dt><dd>${esc(o.finance || "—")}</dd>
      ${o.notes ? `<dt>ملاحظات</dt><dd>${esc(o.notes)}</dd>` : ""}
      ${o.cancelReason ? `<dt>سبب الإلغاء</dt><dd>${esc(o.cancelReason)}</dd>` : ""}
      <dt>سجّل الحجز</dt><dd>${esc(o.createdByName || "")}</dd></dl></section>
    <section class="panel" id="oMeds"><header><h2>سجل أدوية العملية</h2></header>${medlogHtml(meds, canEdit("ops") && o.status !== "cancelled")}</section>
  </div>`);
  bindMedlog(document.getElementById("oMeds"), ["operations", o.id]);
  root.querySelector("main").onclick = (ev) => {
    const b = ev.target.closest("[data-o]"); if (!b) return;
    ({
      edit: () => openOperation(o),
      del: () => deleteOperation(o, meds),
      done: () => formDialog("تم تنفيذ العملية", `<label class="field"><span>ميعاد التنفيذ</span><input name="doneAt" type="datetime-local" value="${toLocalInput(new Date())}" max="${toLocalInput(new Date())}"></label>`,
        "حفظ", async (f) => {
          const d = new Date(f.elements.doneAt.value); if (isNaN(d)) return "حدد الميعاد.";
          await updateDoc(doc(db, "operations", o.id), { status: "done", doneAt: Timestamp.fromDate(d), ...upMeta() });
          audit("تنفيذ عملية", { adm: { id: o.id, patientName: o.patientName, unitId: "" } }); toast("تم التسجيل");
        }),
      cancel: () => formDialog("إلغاء العملية", `<label class="field"><span>سبب الإلغاء</span><input name="reason"></label>`, "إلغاء العملية", async (f) => {
        await updateDoc(doc(db, "operations", o.id), { status: "cancelled", cancelReason: f.elements.reason.value.trim(), ...upMeta() });
        audit("إلغاء عملية", { adm: { id: o.id, patientName: o.patientName, unitId: "" } }); toast("تم الإلغاء");
      }),
      print: () => printDoc(o.operation, `<h1>${esc(o.operation)}</h1><p class="sub">${esc(o.patientName)}، ${esc(o.medicalId || "")}، ${esc(o.number || "")}</p>
        <dl class="kv"><dt>التخصص</dt><dd>${esc(o.specialty || "")}</dd><dt>التشخيص</dt><dd>${esc(o.diagnosis || "")}</dd>
        <dt>الميعاد المقترح</dt><dd>${fmtDateTime(o.proposedAt)}</dd><dt>ميعاد التنفيذ</dt><dd>${o.doneAt ? fmtDateTime(o.doneAt) : "—"}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(o.consultant || "")}</dd><dt>استشاري التخدير</dt><dd>${esc(o.anesthesia || "")}</dd>
        <dt>نوع الحالة</dt><dd>${esc(o.caseType || "")}</dd><dt>المعاملة المالية</dt><dd>${esc(o.finance || "")}</dd></dl>`, true),
    })[b.dataset.o]();
  };
}

/* ---------- التنبيهات ---------- */
function notifications() {
  const out = [];
  const icuAll = Object.values(S.adm || {}).flat().filter(Boolean);
  icuAll.forEach((a) => {
    if (stayDays(a) > 7) out.push({ kind: "los", sec: "رعاية", name: a.patientName, los: stayDays(a), href: `#/patient/${a.id}` });
  });
  (S.wardActive || []).forEach((a) => {
    if (stayDays(a) > 7) out.push({ kind: "los", sec: "داخلي", name: a.patientName, los: stayDays(a), href: `#/w/${a.id}` });
  });
  const now = Date.now();
  (S.opsUpcoming || []).forEach((o) => {
    const t = toDate(o.proposedAt).getTime();
    if (t >= now - 3600e3 && t <= now + 24 * 3600e3) out.push({ kind: "op", name: o.patientName, op: o.operation, when: fmtDateTime(o.proposedAt), href: `#/o/${o.id}` });
  });
  (S.consultIn || []).forEach((c) => out.push({ kind: "cin", urgent: c.urgency === "عاجل", name: c.patientName, spec: c.specialty, place: c.place, href: "#/consults" }));
  (S.consultAnswered || []).forEach((c) => out.push({ kind: "cans", name: c.patientName, spec: c.specialty, by: c.answeredByName, href: "#/consults/mine" }));
  const order = { cin: 0, cans: 1, op: 2, los: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || (y.urgent ? 1 : 0) - (x.urgent ? 1 : 0));
}

function bellHtml() {
  const n = notifications();
  const urgent = n.some((x) => x.kind === "cin" && x.urgent);
  return `<div class="bell-wrap"><button class="bell ${urgent ? "urgent" : ""}" id="bellBtn" aria-label="التنبيهات" aria-expanded="false">🔔${n.length ? `<b>${n.length}</b>` : ""}</button>
    <div class="bell-panel hidden" id="bellPanel">${n.length ? n.map((x, i) =>
      x.kind === "cin" ? `<div class="nt cin ${x.urgent ? "urgent" : ""}"><a href="${x.href}">🩺 طلب استشارة ${esc(x.spec)}${x.urgent ? " (عاجل)" : ""}: <strong>${esc(x.name)}</strong></a><div>${esc(x.place)}</div></div>`
      : x.kind === "cans" ? `<div class="nt cans"><a href="${x.href}">✅ ${esc(x.by)} رد على استشارة ${esc(x.spec)} للمريض <strong>${esc(x.name)}</strong></a></div>`
      : x.kind === "op" ? `<div class="nt op"><a href="${x.href}">🔪 عملية <strong>${esc(x.op)}</strong> للمريض ${esc(x.name)}</a><div>${x.when}</div></div>`
      : `<div class="nt los"><a href="${x.href}">⚠️ (${x.sec}) <strong>${esc(x.name)}</strong> إقامته ${x.los} يوم</a></div>`).join("")
      : `<div class="nt">مفيش تنبيهات.</div>`}</div></div>`;
}
function bindBell() {
  const b = document.getElementById("bellBtn"), p = document.getElementById("bellPanel");
  if (!b) return;
  b.onclick = (ev) => { ev.stopPropagation(); p.classList.toggle("hidden"); b.setAttribute("aria-expanded", String(!p.classList.contains("hidden"))); S.bellOpen = !p.classList.contains("hidden"); };
  if (S.bellOpen) { p.classList.remove("hidden"); b.setAttribute("aria-expanded", "true"); }
  p.onclick = (ev) => ev.stopPropagation();
}
document.addEventListener("click", () => { const p = document.getElementById("bellPanel"); if (p && !p.classList.contains("hidden")) { p.classList.add("hidden"); S.bellOpen = false; } });

function refreshBell() {
  const w = document.querySelector(".bell-wrap");
  if (!w) return;
  w.outerHTML = bellHtml();
  bindBell();
}

// اشتراكات الداخلي والعمليات
let wardUnsub = null, opsUnsub = null;
function subscribeSections() {
  wardUnsub?.(); opsUnsub?.(); wardUnsub = opsUnsub = null;
  S.wardActive = null; S.opsUpcoming = [];
  if (canSee("ward")) wardUnsub = onSnapshot(query(collection(db, "wardAdmissions"), where("status", "==", "active")), (s) => {
    S.wardActive = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    liveRefresh();
  }, (e) => console.error("ward", e));
  if (canSee("ops")) opsUnsub = onSnapshot(query(collection(db, "operations"), where("status", "==", "scheduled")), (s) => {
    S.opsUpcoming = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    liveRefresh();
  }, (e) => console.error("ops", e));
}

/* ---------- الإعدادات: أقسام الداخلي ---------- */
function tabWardUnits(body) {
  let rows = wardUnits().map((u) => ({ ...u }));
  const occ = (id) => (S.wardActive || []).filter((a) => a.deptId === id);
  const draw = () => {
    body.innerHTML = `
    <div class="toolbar"><h2>أقسام الداخلي</h2><button class="btn ghost" id="addW">إضافة قسم</button></div>
    <div class="table-wrap"><table class="units-edit"><thead><tr><th>اسم القسم</th><th>عدد الأسرّة</th><th>مشغول حالياً</th><th></th></tr></thead>
      <tbody>${rows.map((u, i) => `<tr><td><input data-i="${i}" data-k="name" value="${esc(u.name)}"></td>
        <td><input data-i="${i}" data-k="beds" type="number" min="1" max="300" value="${u.beds}"></td><td>${occ(u.id).length}</td>
        <td>${occ(u.id).length ? "" : `<button class="btn ghost sm" data-del="${i}">حذف</button>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">لا يوجد أقسام. اضغط "إضافة قسم".</td></tr>`}</tbody></table></div>
    <div class="err" id="wuErr" style="margin-top:12px"></div>
    <div class="actions" style="margin-top:12px"><button class="btn" id="saveW">حفظ الأقسام</button></div>`;
    body.querySelectorAll("[data-k]").forEach((el) => (el.oninput = () => (rows[el.dataset.i][el.dataset.k] = el.type === "number" ? Number(el.value) : el.value)));
    body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { rows.splice(+b.dataset.del, 1); draw(); }));
    document.getElementById("addW").onclick = () => { rows.push({ id: "w" + Date.now().toString(36), name: "", beds: 10 }); draw(); };
    document.getElementById("saveW").onclick = async () => {
      const err = document.getElementById("wuErr");
      for (const u of rows) {
        u.name = String(u.name || "").trim();
        if (!u.name) { err.textContent = "كل قسم لازم يكون ليه اسم."; return; }
        if (!Number.isInteger(u.beds) || u.beds < 1) { err.textContent = `عدد الأسرّة في "${u.name}" غير صحيح.`; return; }
        const mx = Math.max(0, ...occ(u.id).map((a) => a.bed));
        if (u.beds < mx) { err.textContent = `مينفعش تقلل أسرّة "${u.name}" لأقل من ${mx}.`; return; }
      }
      try { await updateDoc(doc(db, "config", "settings"), { wardUnits: rows }); toast("تم حفظ الأقسام"); } catch (e) { err.textContent = errText(e); }
    };
  };
  draw();
}

/* =========================================================
   المرحلة 5ج: التقارير الطبية، الحذف، إيميل التنبيه، إحصائيات الداخلي والعمليات
   ========================================================= */

/* ---------- حذف الدخول الغلط (أدمن) ---------- */
async function deleteIcuAdmission() {
  const { adm: a, entries, vitals, meds } = S.P;
  if (!confirm(`حذف دخول الرعاية ${a.admissionNumber || ""} للمريض ${a.patientName} نهائياً؟\nهيتمسح معاه كل ملف المتابعة بتاعه.`)) return;
  if (!confirm("متأكد؟ الحذف مش بيرجع. نسخة من بيانات الدخول بتتحفظ في سجل التعديلات.")) return;
  try {
    const aRef = doc(db, "admissions", a.id), pRef = doc(db, "patients", a.patientId), bRef = doc(db, "beds", `${a.unitId}_${a.bed}`);
    await runTransaction(db, async (tx) => {
      const bs = await tx.get(bRef), ps = await tx.get(pRef);
      tx.delete(aRef);
      if (bs.exists() && bs.data().admissionId === a.id) tx.delete(bRef);
      if (ps.exists()) {
        const pd = ps.data(), upd = {};
        if (pd.currentAdmissionId === a.id) upd.currentAdmissionId = null;
        if (pd.visits) upd.visits = pd.visits.filter((v) => v.id !== a.id);
        if (a.admissionNo && a.admissionNo === pd.admissionsCount) upd.admissionsCount = Math.max(0, pd.admissionsCount - 1);
        if (Object.keys(upd).length) tx.update(pRef, upd);
      }
    });
    const subs = [...entries.map((x) => ["entries", x.id]), ...vitals.map((x) => ["vitals", x.id]), ...meds.map((x) => ["meds", x.id])];
    for (let i = 0; i < subs.length; i += 400) {
      const b = writeBatch(db);
      subs.slice(i, i + 400).forEach(([c, id]) => b.delete(doc(db, "admissions", a.id, c, id)));
      await b.commit();
    }
    audit("حذف دخول رعاية", { adm: a, before: a });
    toast("تم حذف الدخول");
    location.hash = `#/p/${a.patientId}`;
  } catch (e) { toast(errText(e), true); }
}

async function deleteWardAdmission(a, meds) {
  if (!confirm(`حذف دخول الداخلي ${a.admissionNumber || ""} للمريض ${a.patientName} نهائياً؟`)) return;
  if (!confirm("متأكد؟ الحذف مش بيرجع. نسخة من البيانات بتتحفظ في سجل التعديلات.")) return;
  try {
    const wRef = doc(db, "wardAdmissions", a.id), pRef = doc(db, "patients", a.patientId), bRef = doc(db, "beds", `${a.deptId}_${a.bed}`);
    await runTransaction(db, async (tx) => {
      const bs = await tx.get(bRef), ps = await tx.get(pRef);
      tx.delete(wRef);
      if (bs.exists() && bs.data().admissionId === a.id) tx.delete(bRef);
      if (ps.exists()) {
        const pd = ps.data(), upd = {};
        if (pd.currentWardId === a.id) upd.currentWardId = null;
        if (pd.visits) upd.visits = pd.visits.filter((v) => v.id !== a.id);
        if (a.wardNo && a.wardNo === pd.wardCount) upd.wardCount = Math.max(0, pd.wardCount - 1);
        if (Object.keys(upd).length) tx.update(pRef, upd);
      }
    });
    if (meds.length) { const b = writeBatch(db); meds.forEach((m) => b.delete(doc(db, "wardAdmissions", a.id, "medlog", m.id))); await b.commit(); }
    audit("حذف دخول داخلي", { adm: { id: a.id, patientName: a.patientName, unitId: a.deptId }, before: a });
    toast("تم حذف الدخول");
    location.hash = `#/p/${a.patientId}`;
  } catch (e) { toast(errText(e), true); }
}

async function deleteOperation(o, meds) {
  if (!confirm(`حذف العملية ${o.number || ""} (${o.operation}) نهائياً؟`)) return;
  try {
    const pRef = doc(db, "patients", o.patientId);
    await runTransaction(db, async (tx) => {
      const ps = await tx.get(pRef);
      tx.delete(doc(db, "operations", o.id));
      if (ps.exists() && o.opNo && o.opNo === ps.data().opsCount) tx.update(pRef, { opsCount: Math.max(0, o.opNo - 1) });
    });
    if (meds.length) { const b = writeBatch(db); meds.forEach((m) => b.delete(doc(db, "operations", o.id, "medlog", m.id))); await b.commit(); }
    audit("حذف عملية", { adm: { id: o.id, patientName: o.patientName, unitId: "" }, before: o });
    toast("تم حذف العملية");
    location.hash = `#/p/${o.patientId}`;
  } catch (e) { toast(errText(e), true); }
}

/* ---------- التقارير الطبية ---------- */
const REPORT_FIELDS = [["history", "التاريخ المرضي"], ["diagnosis", "التشخيص"], ["done", "ما تم"], ["required", "مطلوب"]];
function reportOptions(k) {
  if (k === "diagnosis") return listOf("diagnoses");
  if (k === "history") return [...new Set(HIST_OPT_FIELDS.flatMap((f) => listOf(`historyOptions.${f}`)))];
  return listOf(`reportOptions.${k}`);
}

// ctx: { type: "icu"|"ward", adm, pat? } لكتابة تقرير جديد، أو report لتعديل تقرير موجود
function openReportForm(ctx, report) {
  const r = report || {};
  let pre = {};
  if (!report) {
    const a = ctx.adm;
    if (ctx.type === "icu" && S.P?.adm?.id === a.id) {
      const h = S.P.entries.filter((e) => e.kind === "history").sort(desc)[0];
      pre.history = h ? HISTORY_FIELDS.filter(([k]) => h[k]).map(([k, l]) => `${l}: ${h[k]}`).join("\n") : "";
      pre.diagnosis = S.P.entries.filter((e) => e.kind === "diagnosis").sort(desc).map((e) => e.text).join("\n");
    } else if (ctx.type === "ward") { pre.history = a.history || ""; pre.diagnosis = a.diagnosis || ""; }
  }
  const val = (k) => esc(report ? r[k] || "" : pre[k] || "");
  const head = report ? r : (() => {
    const a = ctx.adm;
    return { patientName: a.patientName, medicalId: a.medicalId || ctx.pat?.medicalId || "", nationalId: a.nationalId || "",
      admissionNumber: a.admissionNumber || "", admitAt: a.admitAt, consultant: a.consultant || "", specialty: (a.specialties || []).join("، "),
      unitLabel: ctx.type === "icu" ? unitName(a.unitId) : wardById(a.deptId)?.name || "" };
  })();
  formDialog(report ? "تعديل التقرير الطبي" : "كتابة تقرير طبي", `
    <div class="info">${esc(head.patientName)}، ${esc(head.medicalId)}، دخول ${esc(head.admissionNumber)} (${fmtDate(head.admitAt)})، ${esc(head.unitLabel || "")}</div>
    ${REPORT_FIELDS.map(([k, l]) => {
      const opts = reportOptions(k);
      return `<div class="field"><label for="rp_${k}"><span>${l}</span></label>
        <textarea id="rp_${k}" name="${k}" rows="${k === "history" ? 4 : 3}" class="ltr-auto">${val(k)}</textarea>
        ${opts.length ? `<div class="opt-chips">${opts.slice(0, 60).map((o) => `<button type="button" class="opt" data-f="${k}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : ""}</div>`;
    }).join("")}`,
    report ? "حفظ التعديل" : "حفظ التقرير", async (f) => {
      const d = Object.fromEntries(REPORT_FIELDS.map(([k]) => [k, f.elements[k].value.trim()]));
      if (!d.diagnosis) return "اكتب التشخيص.";
      if (report) {
        await updateDoc(doc(db, "medicalReports", r.id), { ...d, ...upMeta() });
        audit("تعديل تقرير طبي", { adm: { id: r.admissionId, patientName: r.patientName, unitId: "" }, before: r });
        toast("تم حفظ التعديل");
        return;
      }
      const a = ctx.adm;
      const ref = await addDoc(collection(db, "medicalReports"), {
        ...d, patientId: a.patientId, patientName: head.patientName, medicalId: head.medicalId, nationalId: head.nationalId,
        admissionType: ctx.type, admissionId: a.id, admissionNumber: head.admissionNumber, admitAt: a.admitAt,
        consultant: head.consultant, specialty: head.specialty, unitLabel: head.unitLabel,
        doctorName: S.profile.displayName, reportDate: Timestamp.now(), ...meta(),
      });
      audit("كتابة تقرير طبي", { adm: { id: a.id, patientName: head.patientName, unitId: "" } });
      toast("تم حفظ التقرير");
      location.hash = `#/r/${ref.id}`;
    });
  bindOptChips();
}

function renderReports() {
  const T = (S.R ||= { from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), q: "" });
  shell(reportsTabs("medical") + `
  ${canEdit("reports") ? `<div class="toolbar"><span></span><button class="btn" id="newRep">كتابة تقرير</button></div>` : ""}
  <form class="filters" id="rpF">
    <label class="field"><span>من</span><input type="date" name="from" value="${T.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${T.to}"></label>
    <label class="field grow"><span>بحث</span><input name="q" value="${esc(T.q)}" placeholder="الاسم، أو الرقم الطبي، أو رقم الدخول، أو الطبيب، أو التشخيص"></label>
    <button class="btn">بحث</button>
  </form>
  <div id="rpBody"><div class="loading">جاري التحميل…</div></div>`);
  document.getElementById("newRep")?.addEventListener("click", () => pickPatient("تقرير طبي لمريض", chooseAdmissionForReport));
  const f = document.getElementById("rpF");
  const load = async () => {
    Object.assign(T, { from: f.elements.from.value, to: f.elements.to.value, q: f.elements.q.value.trim() });
    const body = document.getElementById("rpBody");
    try {
      const col = collection(db, "medicalReports");
      let rows;
      if (/^mr-?\d+$/i.test(T.q)) rows = (await getDocs(query(col, where("medicalId", "==", "MR-" + T.q.replace(/\D/g, ""))))).docs;
      else if (/^\d{14}$/.test(T.q)) rows = (await getDocs(query(col, where("nationalId", "==", T.q)))).docs;
      else rows = (await getDocs(query(col, where("reportDate", ">=", Timestamp.fromDate(new Date(T.from + "T00:00:00"))),
        where("reportDate", "<=", Timestamp.fromDate(new Date(T.to + "T23:59:59"))), orderBy("reportDate", "desc")))).docs;
      rows = rows.map((d) => ({ id: d.id, ...d.data() }));
      if (T.q && !/^mr-?\d+$/i.test(T.q) && !/^\d{14}$/.test(T.q)) {
        const q = T.q.toLowerCase();
        rows = rows.filter((r) => [r.patientName, r.admissionNumber, r.doctorName, r.diagnosis].some((x) => (x || "").toLowerCase().includes(q)));
      }
      rows.sort((x, y) => toDate(y.reportDate) - toDate(x.reportDate));
      body.innerHTML = rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>تاريخ الإصدار</th><th>المريض</th><th>رقم الدخول</th><th>التشخيص</th><th>الطبيب المعالج</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="nowrap"><a href="#/r/${r.id}">${fmtDateTime(r.reportDate)}</a></td>
          <td><a href="#/r/${r.id}"><strong>${esc(r.patientName)}</strong></a><div class="by-line ltr">${esc(r.medicalId || "")}</div></td>
          <td class="ltr">${esc(r.admissionNumber || "")}</td><td class="ltr-auto">${esc((r.diagnosis || "").split("\n")[0])}</td><td>${esc(r.doctorName)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">مفيش تقارير بالشروط دي.</div>`;
    } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); load(); };
  load();
}

// بعد اختيار المريض: اختيار الدخول اللي التقرير عنه
async function chooseAdmissionForReport(p) {
  const list = [];
  const push = (type, d) => list.push({ type, adm: { id: d.id, ...d.data() } });
  try {
    if (isAdmin()) {
      (await getDocs(query(collection(db, "admissions"), where("patientId", "==", p.id)))).forEach((d) => push("icu", d));
      (await getDocs(query(collection(db, "wardAdmissions"), where("patientId", "==", p.id)))).forEach((d) => push("ward", d));
    } else {
      if (p.currentAdmissionId) { try { const d = await getDoc(doc(db, "admissions", p.currentAdmissionId)); if (d.exists()) push("icu", d); } catch {} }
      if (p.currentWardId) { try { const d = await getDoc(doc(db, "wardAdmissions", p.currentWardId)); if (d.exists()) push("ward", d); } catch {} }
    }
  } catch (e) { toast(errText(e), true); return; }
  if (!list.length) { toast(isAdmin() ? "المريض ده ملوش أي دخول." : "مفيش دخول حالي للمريض ده تقدر تكتب عنه تقرير.", true); return; }
  if (list.length === 1) { openReportForm({ ...list[0], pat: p }); return; }
  list.sort((x, y) => toDate(y.adm.admitAt) - toDate(x.adm.admitAt));
  openDialog(`<div class="form"><header class="dlg-head"><h3>اختار الدخول</h3><p>${esc(p.name)}</p></header>
    <ul class="pick-list">${list.map((x, i) => `<li><button type="button" data-i="${i}"><strong>${fmtDate(x.adm.admitAt)}</strong>
      <span>${x.type === "icu" ? "رعاية: " + esc(unitName(x.adm.unitId)) : "داخلي: " + esc(wardById(x.adm.deptId)?.name || "")}</span>
      <span class="ltr muted">${esc(x.adm.admissionNumber || "")}</span>
      <span class="muted">${x.adm.status === "active" ? "حالياً" : "خرج"}</span></button></li>`).join("")}</ul>
    <div class="actions"><button type="button" class="btn ghost" data-close>إلغاء</button></div></div>`);
  dlgBody.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { closeDialog(); setTimeout(() => openReportForm({ ...list[+b.dataset.i], pat: p }), 0); }));
}

function renderReport(id) {
  shell(`<div class="loading">جاري التحميل…</div>`);
  S.pageUnsubs.push(onSnapshot(doc(db, "medicalReports", id), (s) => {
    if (S.page !== "report") return;
    if (!s.exists()) { shell(`<div class="empty">التقرير غير موجود. <a href="#/reports">التقارير الطبية</a></div>`); return; }
    const r = { id: s.id, ...s.data() };
    const mine = r.createdBy === S.profile.uid;
    shell(`
    <div class="file-head">
      <a class="back" href="#/reports">التقارير الطبية</a>
      <h1>تقرير طبي: <a href="#/p/${r.patientId}" class="plain">${esc(r.patientName)}</a></h1>
      <div class="tags"><span class="tag mr">${esc(r.medicalId || "")}</span><span class="tag mr">${esc(r.admissionNumber || "")}</span>
        <span class="tag">${fmtDateTime(r.reportDate)}</span><span class="tag">${esc(r.doctorName)}</span></div>
      <div class="file-actions">
        ${isAdmin() || (mine && canEdit("reports")) ? `<button class="btn ghost" data-r="edit">تعديل</button>` : ""}
        ${canPrint() ? `<button class="btn" data-r="print">طباعة / PDF</button>` : ""}
        ${isAdmin() ? `<button class="btn ghost del" data-r="del">حذف</button>` : ""}
      </div>
    </div>
    <section class="panel">
      <dl class="kv">
        <dt>الاسم</dt><dd>${esc(r.patientName)}</dd><dt>الرقم القومي</dt><dd class="ltr">${esc(r.nationalId || "—")}</dd>
        <dt>تاريخ الدخول</dt><dd>${fmtDate(r.admitAt)}، ${r.admissionType === "icu" ? "رعاية" : "داخلي"}${r.unitLabel ? `، ${esc(r.unitLabel)}` : ""}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(r.consultant || "—")}</dd><dt>التخصص</dt><dd>${esc(r.specialty || "—")}</dd>
        ${REPORT_FIELDS.map(([k, l]) => `<dt>${l}</dt><dd class="pre-wrap ltr-auto">${esc(r[k] || "—")}</dd>`).join("")}
        <dt>الطبيب المعالج</dt><dd>${esc(r.doctorName)}</dd>
      </dl>
    </section>`);
    root.querySelector("main").onclick = async (ev) => {
      const b = ev.target.closest("[data-r]"); if (!b) return;
      if (b.dataset.r === "edit") openReportForm(null, r);
      if (b.dataset.r === "print") printReport(r);
      if (b.dataset.r === "del" && confirm("حذف التقرير نهائياً؟")) {
        try { await deleteDoc(doc(db, "medicalReports", r.id)); audit("حذف تقرير طبي", { adm: { id: r.admissionId, patientName: r.patientName, unitId: "" }, before: r });
          toast("تم الحذف"); location.hash = "#/reports"; } catch (e) { toast(errText(e), true); }
      }
    };
  }, () => shell(`<div class="empty">ليس لديك صلاحية لعرض التقارير الطبية.</div>`)));
}

function printReport(r) {
  printDoc(`تقرير طبي - ${r.patientName}`, `
    <h1 style="text-align:center">تقرير طبي</h1>
    <table><tbody>
      <tr><th>الاسم</th><td>${esc(r.patientName)}</td><th>الرقم الطبي</th><td class="ltr">${esc(r.medicalId || "")}</td></tr>
      <tr><th>الرقم القومي</th><td class="ltr">${esc(r.nationalId || "")}</td><th>رقم الدخول</th><td class="ltr">${esc(r.admissionNumber || "")}</td></tr>
      <tr><th>تاريخ الدخول</th><td>${fmtDate(r.admitAt)}</td><th>القسم</th><td>${r.admissionType === "icu" ? "الرعاية المركزة" : "الداخلي"}${r.unitLabel ? `، ${esc(r.unitLabel)}` : ""}</td></tr>
      <tr><th>استشاري الحالة</th><td>${esc(r.consultant || "")}</td><th>التخصص</th><td>${esc(r.specialty || "")}</td></tr>
    </tbody></table>
    ${REPORT_FIELDS.map(([k, l]) => r[k] ? `<h2>${l}</h2><div class="pre ltr">${esc(r[k])}</div>` : "").join("")}
    <p class="sub" style="margin-top:14px">تاريخ الإصدار: ${fmtDateTime(r.reportDate)}</p>
    <div class="sign"><span>الطبيب المعالج: ${esc(r.doctorName)}</span><span>التوقيع: ....................</span></div>`, true);
}

/* ---------- إحصائيات الداخلي والعمليات + تفاصيل الرعاية ---------- */
function countBy(rows, fn) {
  const m = {};
  rows.forEach((r) => { const v = fn(r); (Array.isArray(v) ? (v.length ? v : ["غير محدد"]) : [v || "غير محدد"]).forEach((k) => (m[k] = (m[k] || 0) + 1)); });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
const statCard = (title, entries) => `<div class="st-card"><h4>${title}</h4>${entries.length
  ? `<table><tbody>${entries.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">لا يوجد</p>`}</div>`;

async function loadStatsExtra(start, end, effEnd, icuAll) {
  const box = document.getElementById("stExtra");
  if (!box) return;
  const inR = (d) => d && toDate(d) >= start && toDate(d) <= end;
  // الرعاية: تفاصيل
  const icuIn = icuAll.filter((a) => inR(a.admitAt));
  const icuActive = Object.values(S.adm).flat().filter(Boolean);
  let html = `<h3 class="st-h">الرعاية المركزة: تفاصيل الدخول في الفترة (${icuIn.length})</h3><div class="st-grid">
    ${statCard("حسب استشاري الحالة", countBy(icuIn, (a) => a.consultant))}
    ${statCard("حسب التخصصات المشتركة", countBy(icuIn, (a) => a.specialties || []))}
    ${statCard("حسب المعاملة المالية عند الدخول", countBy(icuIn, (a) => finHist(a)[0]?.type))}
    ${statCard("قرح الفراش (الحالات الموجودة حالياً)", countBy(icuActive, (a) => BEDSORE[a.clinical?.bedsore] || "غير مسجل"))}
    ${statCard("التنفس (الحالات الموجودة حالياً)", countBy(icuActive, (a) => RESP[a.clinical?.resp] || "غير مسجل"))}
    ${statCard("إقامة أكثر من 7 أيام (حسب شهر الدخول)", countBy(icuAll.filter((a) => stayDays(a) > 7 && inR(a.admitAt)), (a) => fmtDate(a.admitAt).slice(3)))}
  </div>`;
  box.innerHTML = html + `<div class="loading">جاري حساب الداخلي والعمليات…</div>`;
  S.T.special = { icuAll, wardAll: [] };
  try {
    const wSnap = await getDocs(query(collection(db, "wardAdmissions"), where("dischargeAt", ">=", Timestamp.fromDate(start)), orderBy("dischargeAt")));
    const wardAll = [...wSnap.docs.map((d) => ({ id: d.id, ...d.data() })), ...(S.wardActive || [])].filter((a) => toDate(a.admitAt) <= end);
    S.T.special.wardAll = wardAll;
    const wIn = wardAll.filter((a) => inR(a.admitAt));
    const wOut = wardAll.filter((a) => a.status === "discharged" && inR(a.dischargeAt));
    const los = wOut.reduce((s, a) => s + stayDays(a), 0);
    const deaths = wOut.filter((a) => a.dischargeType === "death").length;
    const wFin = {}; wardAll.forEach((a) => Object.entries(finBreakdown(a, S.T.from, isoDay(effEnd))).forEach(([k, n]) => (wFin[k] = (wFin[k] || 0) + n)));
    html += `<h3 class="st-h">الداخلي</h3>
      <div class="arc-sum"><span><b>${wIn.length}</b> دخول</span><span><b>${wOut.length}</b> خروج</span>
        <span><b>${deaths}</b> وفاة (${wOut.length ? Math.round((deaths / wOut.length) * 1000) / 10 : 0}%)</span>
        <span>متوسط الإقامة <b>${wOut.length ? Math.round((los / wOut.length) * 10) / 10 : 0}</b> يوم</span>
        <span><b>${wardAll.filter((a) => stayDays(a) > 7).length}</b> إقامة أكثر من 7 أيام</span></div>
      <div class="st-grid">
        ${statCard("حسب القسم", countBy(wIn, (a) => wardById(a.deptId)?.name))}
        ${statCard("حسب استشاري الحالة", countBy(wIn, (a) => a.consultant))}
        ${statCard("حسب الإشراف المشترك", countBy(wIn, (a) => a.specialties || []))}
        ${statCard("أيام المرضى حسب المعاملة المالية", Object.entries(wFin).sort((a, b) => b[1] - a[1]))}
        ${statCard("أنواع الخروج", countBy(wOut, (a) => WARD_DIS[a.dischargeType]))}
        ${statCard("إقامة أكثر من 7 أيام (حسب شهر الدخول)", countBy(wardAll.filter((a) => stayDays(a) > 7 && inR(a.admitAt)), (a) => fmtDate(a.admitAt).slice(3)))}
      </div>`;
    const oSnap = await getDocs(query(collection(db, "operations"), where("proposedAt", ">=", Timestamp.fromDate(start)),
      where("proposedAt", "<=", Timestamp.fromDate(end)), orderBy("proposedAt")));
    const ops = oSnap.docs.map((d) => d.data());
    html += `<h3 class="st-h">العمليات (${ops.length})</h3><div class="st-grid">
      ${statCard("حسب الحالة", countBy(ops, (o) => OP_STATUS[o.status]))}
      ${statCard("حسب التخصص", countBy(ops, (o) => o.specialty))}
      ${statCard("حسب استشاري الحالة", countBy(ops, (o) => o.consultant))}
      ${statCard("حسب استشاري التخدير", countBy(ops, (o) => o.anesthesia))}
      ${statCard("حسب نوع الحالة", countBy(ops, (o) => o.caseType))}
      ${statCard("حسب المعاملة المالية", countBy(ops, (o) => o.finance))}
    </div>`;
    box.innerHTML = html;
  } catch (e) { box.innerHTML = html + `<div class="err">${esc(errText(e))}</div>`; }
}

// التقارير الخاصة: إقامة > 7 أيام (حالياً)، APACHE > 40 (حالياً)، الوفيات في الفترة
function printSpecialReports() {
  const T = S.T;
  const icuActive = Object.values(S.adm).flat().filter(Boolean);
  const wardActive = S.wardActive || [];
  const long = [...icuActive.map((a) => ({ n: a.patientName, mr: a.medicalId, sec: "رعاية: " + unitName(a.unitId), at: a.admitAt, los: stayDays(a), c: a.consultant })),
    ...wardActive.map((a) => ({ n: a.patientName, mr: a.medicalId, sec: "داخلي: " + (wardById(a.deptId)?.name || ""), at: a.admitAt, los: stayDays(a), c: a.consultant }))]
    .filter((x) => x.los > 7).sort((x, y) => y.los - x.los);
  const apache = icuActive.filter((a) => (a.clinical?.apache ?? -1) > 40).sort((x, y) => y.clinical.apache - x.clinical.apache);
  const sp = T.special || { icuAll: [], wardAll: [] };
  const start = new Date(T.from + "T00:00:00"), end = new Date(T.to + "T23:59:59");
  const inR = (d) => d && toDate(d) >= start && toDate(d) <= end;
  const deaths = [...sp.icuAll.filter((a) => a.dischargeType === "death" && inR(a.dischargeAt)).map((a) => ({ a, sec: "رعاية: " + unitName(a.unitId), cause: a.dischargeInfo?.deathCause })),
    ...sp.wardAll.filter((a) => a.dischargeType === "death" && inR(a.dischargeAt)).map((a) => ({ a, sec: "داخلي: " + (wardById(a.deptId)?.name || ""), cause: a.dischargeInfo?.deathCause }))]
    .sort((x, y) => toDate(x.a.dischargeAt) - toDate(y.a.dischargeAt));
  printDoc("تقارير خاصة", `
    <h1>تقارير خاصة</h1><p class="sub">الوفيات عن الفترة من ${fmtDate(T.from)} إلى ${fmtDate(T.to)}، والباقي للحالات الموجودة وقت الطباعة.</p>
    <h2>1) الحالات بإقامة أكثر من 7 أيام (${long.length})</h2>
    ${long.length ? `<table><thead><tr><th>المريض</th><th>الرقم الطبي</th><th>القسم</th><th>الدخول</th><th>الإقامة</th><th>الاستشاري</th></tr></thead><tbody>${long.map((x) =>
      `<tr><td>${esc(x.n)}</td><td class="ltr">${esc(x.mr || "")}</td><td>${esc(x.sec)}</td><td>${fmtDate(x.at)}</td><td>${x.los} يوم</td><td>${esc(x.c || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">لا يوجد</p>`}
    <h2>2) حالات APACHE II أكثر من 40 (${apache.length})</h2>
    ${apache.length ? `<table><thead><tr><th>المريض</th><th>الرقم الطبي</th><th>الوحدة</th><th>APACHE</th><th>التنفس</th><th>الإقامة</th></tr></thead><tbody>${apache.map((a) =>
      `<tr><td>${esc(a.patientName)}</td><td class="ltr">${esc(a.medicalId || "")}</td><td>${esc(unitName(a.unitId))}</td><td>${a.clinical.apache}</td><td>${esc(RESP_SHORT[a.clinical.resp] || "")}</td><td>${stayDays(a)} يوم</td></tr>`).join("")}</tbody></table>` : `<p class="muted">لا يوجد</p>`}
    <h2>3) الوفيات (${deaths.length})</h2>
    ${deaths.length ? `<table><thead><tr><th>المريض</th><th>الرقم الطبي</th><th>القسم</th><th>الدخول</th><th>الوفاة</th><th>الإقامة</th><th>السبب</th></tr></thead><tbody>${deaths.map((x) =>
      `<tr><td>${esc(x.a.patientName)}</td><td class="ltr">${esc(x.a.medicalId || "")}</td><td>${esc(x.sec)}</td><td>${fmtDate(x.a.admitAt)}</td><td>${fmtDateTime(x.a.dischargeAt)}</td><td>${stayDays(x.a)} يوم</td><td>${esc(x.cause || "")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">لا يوجد</p>`}`, true);
}

/* =========================================================
   المرحلة 6: اللوحة الرئيسية، أرشيف الداخلي والعمليات، نقل مريض الداخلي
   ========================================================= */
function liveRefresh() {
  if (S.page === "dashboard") renderDashboard();
  else if (S.page === "ward") renderWard(S.wardFilter);
  else if (S.page === "home") renderHome();
  else if (S.page === "board") renderBoard();
  else refreshBell();
}

/* ---------- اللوحة الرئيسية ---------- */
function renderHome() {
  const today = isoDay(new Date());
  const occCard = (title, href, groups) => {
    const tot = groups.reduce((s, g) => s + g.total, 0), occ = groups.reduce((s, g) => s + g.occ, 0);
    const pct = tot ? Math.round((occ / tot) * 100) : 0;
    return `<section class="panel home-card">
      <header><h2><a href="${href}" class="plain">${title}</a></h2><span class="big">${occ}<small>/${tot}</small></span></header>
      <div class="meter"><i style="width:${pct}%"></i></div>
      <p class="by-line">${tot - occ} سرير فاضي، إشغال ${pct}%</p>
      <ul class="mini">${groups.map((g) => `<li><a href="${g.href}">${esc(g.name)}</a><span>${g.occ}/${g.total}</span>${g.extra || ""}</li>`).join("")}</ul>
    </section>`;
  };
  let cards = "";
  const kpis = [];
  if (canSee("icu")) {
    const us = visibleUnits();
    const all = us.flatMap((u) => S.adm[u.id] || []);
    cards += occCard("الرعاية المركزة", "#/icu", us.map((u) => {
      const list = S.adm[u.id] || [];
      const vent = list.filter((a) => a.clinical?.resp === "vent").length;
      return { name: u.name, href: `#/unit/${u.id}`, occ: list.length, total: u.beds, extra: vent ? `<em>${vent} فنت</em>` : "" };
    }));
    kpis.push([all.filter((a) => a.clinical?.resp === "vent").length, "على جهاز تنفس"],
      [all.filter((a) => isoDay(toDate(a.admitAt)) === today).length, "دخول رعاية النهارده"]);
  }
  if (canSee("ward") && wardUnits().length) {
    const act = S.wardActive || [];
    cards += occCard("الداخلي", "#/ward", wardUnits().map((u) => ({ name: u.name, href: `#/ward/${u.id}`, occ: act.filter((a) => a.deptId === u.id).length, total: u.beds })));
    kpis.push([act.filter((a) => isoDay(toDate(a.admitAt)) === today).length, "دخول داخلي النهارده"]);
  }
  let opsHtml = "";
  if (canSee("ops")) {
    const todays = (S.opsUpcoming || []).filter((o) => isoDay(toDate(o.proposedAt)) === today).sort((x, y) => toDate(x.proposedAt) - toDate(y.proposedAt));
    const tomorrow = (S.opsUpcoming || []).filter((o) => isoDay(toDate(o.proposedAt)) === addDays(today, 1)).length;
    kpis.push([todays.length, "عمليات النهارده"]);
    opsHtml = `<section class="panel"><header><h2><a href="#/ops" class="plain">عمليات النهارده</a></h2><span class="by-line">بكرة: ${tomorrow}</span></header>
      ${todays.length ? `<ul class="mini ops">${todays.map((o) => `<li><a href="#/o/${o.id}"><strong>${fmtTime(o.proposedAt)}</strong> ${esc(o.operation)}</a>
        <span>${esc(o.patientName)}${o.caseType === "طوارئ" ? ` <em class="hot">طوارئ</em>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">مفيش عمليات مجدولة النهارده.</p>`}</section>`;
  }
  const ntf = notifications().filter((x) => x.kind === "los");
  const losHtml = `<section class="panel"><header><h2>إقامة أكثر من 7 أيام</h2><span class="big sm">${ntf.length}</span></header>
    ${ntf.length ? `<ul class="mini">${ntf.sort((x, y) => y.los - x.los).slice(0, 12).map((x) => `<li><a href="${x.href}">${esc(x.name)}</a><span>${x.sec}، ${x.los} يوم</span></li>`).join("")}</ul>`
      : `<p class="muted">لا يوجد.</p>`}</section>`;
  const lb = S.settings.lastBackupAt;
  const bkNote = isAdmin() && (!lb || Date.now() - toDate(lb) > 7 * 864e5)
    ? `<div class="note" style="margin-bottom:14px">${lb ? `آخر نسخة احتياطية كانت ${fmtDate(lb)}.` : "لسه متعملش أي نسخة احتياطية."} <a href="#/settings/backup">اعمل نسخة دلوقتي</a></div>` : "";
  shell(bkNote + `
  <div class="home-top">
    <form class="home-search" id="hSearch"><input name="q" placeholder="ابحث عن مريض: الرقم الطبي، أو الرقم القومي، أو التليفون، أو أول الاسم" autocomplete="off"><button class="btn">بحث</button></form>
    ${canEditAny() ? `<button class="btn ghost" id="hNew">تسجيل مريض جديد</button>` : ""}
    ${canSee("icu") || canSee("ward") ? `<a class="btn ghost" href="#/board">شاشة عرض الأسرّة</a>` : ""}
  </div>
  ${kpis.length ? `<div class="kpis">${kpis.map(([n, l]) => `<div class="kpi"><strong>${n}</strong><span>${l}</span></div>`).join("")}</div>` : ""}
  <div class="home-grid">${cards}${opsHtml}${losHtml}</div>`);
  const f = document.getElementById("hSearch");
  f.onsubmit = (ev) => { ev.preventDefault(); S.PQ = f.elements.q.value.trim(); location.hash = "#/patients"; };
  document.getElementById("hNew")?.addEventListener("click", () => openPatientForm());
}

/* ---------- أرشيف الداخلي والعمليات ---------- */
function archiveTabs(tab) {
  return `<nav class="tabs"><a href="#/archive" class="${tab === "icu" ? "on" : ""}">الرعاية المركزة</a>
    <a href="#/archive/ward" class="${tab === "ward" ? "on" : ""}">الداخلي</a>
    <a href="#/archive/ops" class="${tab === "ops" ? "on" : ""}">العمليات</a></nav>`;
}

function renderWardArchive() {
  const A = (S.AW ||= { from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), dept: "", type: "", q: "" });
  shell(archiveTabs("ward") + `
  <form class="filters" id="awF">
    <label class="field"><span>خروج من</span><input type="date" name="from" value="${A.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${A.to}"></label>
    <label class="field"><span>القسم</span><select name="dept"><option value="">كل الأقسام</option>${wardUnits().map((u) => `<option value="${u.id}" ${A.dept === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>
    <label class="field"><span>نوع الخروج</span><select name="type"><option value="">الكل</option>${Object.entries(WARD_DIS).map(([k, l]) => `<option value="${k}" ${A.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field grow"><span>بحث بالاسم أو الرقم القومي أو الرقم الطبي</span><input name="q" value="${esc(A.q)}"></label>
    <button class="btn">عرض</button>
  </form><div id="awBody"><div class="loading">جاري التحميل…</div></div>`);
  const f = document.getElementById("awF");
  const load = async () => {
    Object.assign(A, { from: f.elements.from.value, to: f.elements.to.value, dept: f.elements.dept.value, type: f.elements.type.value, q: f.elements.q.value.trim() });
    const body = document.getElementById("awBody");
    try {
      const col = collection(db, "wardAdmissions");
      let rows;
      if (/^mr-?\d+$/i.test(A.q)) rows = (await getDocs(query(col, where("medicalId", "==", "MR-" + A.q.replace(/\D/g, ""))))).docs;
      else if (/^\d{14}$/.test(A.q)) rows = (await getDocs(query(col, where("nationalId", "==", A.q)))).docs;
      else rows = (await getDocs(query(col, where("dischargeAt", ">=", Timestamp.fromDate(new Date(A.from + "T00:00:00"))),
        where("dischargeAt", "<=", Timestamp.fromDate(new Date(A.to + "T23:59:59"))), orderBy("dischargeAt", "desc")))).docs;
      rows = rows.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === "discharged");
      if (A.q && !/^mr-?\d+$/i.test(A.q) && !/^\d{14}$/.test(A.q)) rows = rows.filter((r) => (r.patientName || "").includes(A.q));
      if (A.dept) rows = rows.filter((r) => r.deptId === A.dept);
      if (A.type) rows = rows.filter((r) => r.dischargeType === A.type);
      rows.sort((x, y) => toDate(y.dischargeAt) - toDate(x.dischargeAt));
      body.innerHTML = rows.length ? `
        <div class="arc-sum"><span><b>${rows.length}</b> حالة</span>${Object.entries(WARD_DIS).map(([k, l]) => { const n = rows.filter((r) => r.dischargeType === k).length; return n ? `<span class="dis"><b>${n}</b> ${l}</span>` : ""; }).join("")}</div>
        <div class="table-wrap"><table><thead><tr><th>الاسم</th><th>رقم الدخول</th><th>القسم</th><th>الدخول</th><th>الخروج</th><th>الإقامة</th><th>نوع الخروج</th><th>المعاملة المالية</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td><a href="#/w/${r.id}"><strong>${esc(r.patientName)}</strong></a></td><td class="ltr">${esc(r.admissionNumber || "")}</td>
          <td>${esc(wardById(r.deptId)?.name || "")}</td><td>${fmtDate(r.admitAt)}</td><td>${fmtDateTime(r.dischargeAt)}</td><td>${stayDays(r)} يوم</td>
          <td>${WARD_DIS[r.dischargeType] || ""}</td><td>${esc(finText(finBreakdown(r)))}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">لا يوجد حالات بالشروط دي.</div>`;
    } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); load(); };
  load();
}

function renderOpsArchive() {
  const A = (S.AO ||= { from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), status: "", q: "" });
  shell(archiveTabs("ops") + `
  <form class="filters" id="aoF">
    <label class="field"><span>من</span><input type="date" name="from" value="${A.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${A.to}"></label>
    <label class="field"><span>الحالة</span><select name="status"><option value="">الكل</option>${Object.entries(OP_STATUS).map(([k, l]) => `<option value="${k}" ${A.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field grow"><span>بحث بالاسم أو العملية أو الرقم الطبي</span><input name="q" value="${esc(A.q)}"></label>
    <button class="btn">عرض</button>
  </form><div id="aoBody"><div class="loading">جاري التحميل…</div></div>`);
  const f = document.getElementById("aoF");
  const load = async () => {
    Object.assign(A, { from: f.elements.from.value, to: f.elements.to.value, status: f.elements.status.value, q: f.elements.q.value.trim() });
    const body = document.getElementById("aoBody");
    try {
      const col = collection(db, "operations");
      let rows = /^mr-?\d+$/i.test(A.q)
        ? (await getDocs(query(col, where("medicalId", "==", "MR-" + A.q.replace(/\D/g, ""))))).docs
        : (await getDocs(query(col, where("proposedAt", ">=", Timestamp.fromDate(new Date(A.from + "T00:00:00"))),
          where("proposedAt", "<=", Timestamp.fromDate(new Date(A.to + "T23:59:59"))), orderBy("proposedAt", "desc")))).docs;
      rows = rows.map((d) => ({ id: d.id, ...d.data() }));
      if (A.q && !/^mr-?\d+$/i.test(A.q)) { const q = A.q.toLowerCase(); rows = rows.filter((r) => [r.patientName, r.operation, r.diagnosis].some((x) => (x || "").toLowerCase().includes(q))); }
      if (A.status) rows = rows.filter((r) => r.status === A.status);
      rows.sort((x, y) => toDate(y.proposedAt) - toDate(x.proposedAt));
      body.innerHTML = rows.length ? `
        <div class="arc-sum"><span><b>${rows.length}</b> عملية</span>${Object.entries(OP_STATUS).map(([k, l]) => `<span class="dis op-${k}"><b>${rows.filter((r) => r.status === k).length}</b> ${l}</span>`).join("")}</div>
        <div class="table-wrap"><table><thead><tr><th>الميعاد</th><th>المريض</th><th>رقم العملية</th><th>العملية</th><th>التخصص</th><th>الاستشاري</th><th>التخدير</th><th>الحالة</th></tr></thead>
        <tbody>${rows.map((o) => `<tr><td class="nowrap">${fmtDateTime(o.doneAt || o.proposedAt)}</td><td><a href="#/o/${o.id}"><strong>${esc(o.patientName)}</strong></a></td>
          <td class="ltr">${esc(o.number || "")}</td><td class="ltr-auto">${esc(o.operation)}</td><td>${esc(o.specialty || "")}</td><td>${esc(o.consultant || "")}</td>
          <td>${esc(o.anesthesia || "")}</td><td><span class="dis op-${o.status}">${OP_STATUS[o.status]}</span></td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">لا يوجد عمليات بالشروط دي.</div>`;
    } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); load(); };
  load();
}

/* ---------- نقل مريض الداخلي ---------- */
async function openWardTransfer(a) {
  let occ;
  try { occ = await bedOccupancy(); } catch (e) { toast(errText(e), true); return; }
  const free = (u) => Array.from({ length: u.beds }, (_, i) => i + 1).filter((n) => !occ[u.id]?.has(n));
  const opts = wardUnits().filter((u) => free(u).length);
  if (!opts.length) { toast("مفيش أسرّة فاضية في الداخلي.", true); return; }
  const f = formDialog(`نقل: ${esc(a.patientName)}`, `
    <p class="muted" style="margin:0">حالياً في ${esc(wardById(a.deptId)?.name || "")}، سرير ${a.bed}</p>
    <div class="row2">
      <label class="field"><span>القسم</span><select name="dept">${opts.map((u) => `<option value="${u.id}" ${u.id === a.deptId ? "selected" : ""}>${esc(u.name)} (${free(u).length} فاضي)</option>`).join("")}</select></label>
      <label class="field"><span>السرير</span><select name="bed"></select></label>
    </div>
    <label class="field"><span>وقت النقل</span><input name="at" type="datetime-local" value="${toLocalInput(new Date())}" max="${toLocalInput(new Date())}"></label>
    <label class="field"><span>السبب (اختياري)</span><input name="reason"></label>`,
    "تأكيد النقل", async (f) => {
      const toDept = f.elements.dept.value, toBed = Number(f.elements.bed.value);
      if (!toDept || !toBed) return "اختر القسم والسرير.";
      const at = new Date(f.elements.at.value);
      if (isNaN(at) || at < toDate(a.admitAt)) return "وقت النقل غير صحيح.";
      const wRef = doc(db, "wardAdmissions", a.id), nb = doc(db, "beds", `${toDept}_${toBed}`);
      await runTransaction(db, async (tx) => {
        const cur = (await tx.get(wRef)).data();
        if (cur.status !== "active") throw new Error("ALREADY_OUT");
        if ((await tx.get(nb)).exists()) throw new Error("BED_TAKEN");
        const ob = doc(db, "beds", `${cur.deptId}_${cur.bed}`), obs = await tx.get(ob);
        if (obs.exists() && obs.data().admissionId === a.id) tx.delete(ob);
        tx.set(nb, { unitId: toDept, bed: toBed, admissionId: a.id, section: "ward", since: serverTimestamp() });
        tx.update(wRef, { deptId: toDept, bed: toBed, ...upMeta(),
          moves: arrayUnion({ fromUnit: cur.deptId, fromBed: cur.bed, toUnit: toDept, toBed, at: Timestamp.fromDate(at), byName: S.profile.displayName, reason: f.elements.reason.value.trim() }) });
      });
      audit("نقل داخلي", { adm: { id: a.id, patientName: a.patientName, unitId: toDept }, details: { from: `${wardById(a.deptId)?.name} ${a.bed}`, to: `${wardById(toDept)?.name} ${toBed}` } });
      toast(`تم النقل إلى ${wardById(toDept)?.name}، سرير ${toBed}`);
    });
  const fill = () => { const u = wardById(f.elements.dept.value); f.elements.bed.innerHTML = free(u).map((n) => `<option value="${n}">سرير ${n}</option>`).join(""); };
  f.elements.dept.onchange = fill; fill();
}

function wardMovesHtml(a) {
  if (!a.moves?.length) return "";
  return `<section class="panel stack-gap"><header><h2>سجل النقل</h2></header><ul class="entries">${[...a.moves].sort((x, y) => toDate(x.at) - toDate(y.at)).map((m) => `
    <li><div class="entry-head"><strong>${esc(wardById(m.fromUnit)?.name || m.fromUnit)}، سرير ${m.fromBed}</strong><span aria-hidden="true">←</span>
      <strong>${esc(wardById(m.toUnit)?.name || m.toUnit)}، سرير ${m.toBed}</strong><span class="by-line">${fmtDateTime(m.at)}، ${esc(m.byName)}</span></div>
      ${m.reason ? `<p>${esc(m.reason)}</p>` : ""}</li>`).join("")}</ul></section>`;
}

/* =========================================================
   تقرير الخروج (Discharge Summary) وتقرير الوفاة
   ========================================================= */
const CONDITIONS = ["Stable", "Improved", "Guarded", "Critical", "Against medical advice"];
const dsId = (type, id) => `${type}_${id}`;

// تجهيز بيانات التقرير من ملف المريض (بتتعمل قبل الخروج عشان البيانات تبقى في إيد البرنامج)
async function buildDischargeContext(type) {
  if (type === "icu") {
    const { adm: a, pat: p, entries, meds } = S.P;
    const dx = entries.filter((e) => e.kind === "diagnosis").sort(asc);
    const inv = entries.filter((e) => e.kind === "investigation" && e.result).sort(asc);
    const today = isoDay(new Date());
    const activeMeds = meds.filter((m) => !m.stopDate && !(medEnd(m) && medEnd(m) < today));
    return {
      type, adm: a, pat: p,
      pre: {
        admissionDx: (dx.find((e) => e.dxType === "initial") || dx[0])?.text || "",
        finalDx: [...dx].reverse().find((e) => e.dxType === "final")?.text || dx[dx.length - 1]?.text || "",
        investigations: inv.map((e) => `${e.name}: ${e.result}`).join("\n"),
        dischargeMeds: activeMeds.map((m) => { const d = currentDose(m); return [m.name, d.dose, d.frequency, m.route].filter(Boolean).join(" - "); }).join("\n"),
        procedures: await proceduresText(a),
      },
    };
  }
  const { a, meds } = S.W;
  const p = (await getDoc(doc(db, "patients", a.patientId)).catch(() => null))?.data() || {};
  const drugs = [...new Set(meds.map((m) => [m.drug, m.dose, m.schedule].filter(Boolean).join(" - ")))];
  return { type, adm: a, pat: p, pre: { admissionDx: a.diagnosis || "", finalDx: a.diagnosis || "", investigations: "", dischargeMeds: drugs.join("\n"), procedures: await proceduresText(a) } };
}
async function proceduresText(a) {
  if (!canSee("ops")) return "";
  try {
    const s = await getDocs(query(collection(db, "operations"), where("patientId", "==", a.patientId)));
    const from = toDate(a.admitAt);
    return s.docs.map((d) => d.data()).filter((o) => o.status === "done" && toDate(o.doneAt || o.proposedAt) >= from)
      .map((o) => `${fmtDate(o.doneAt || o.proposedAt)}: ${o.operation}`).join("\n");
  } catch { return ""; }
}

// ctx.adm لازم يكون فيه بيانات الخروج (بعد الخروج) أو نمررها في dis
function openDischargeSummary(ctx, existing, onDone) {
  const r = existing || {};
  const a = ctx?.adm || {};
  const dis = ctx?.dis || { at: a.dischargeAt, type: a.dischargeType, info: a.dischargeInfo || {} };
  const death = existing ? r.kind === "death" : dis.type === "death";
  const v = (k) => esc(existing ? r[k] ?? "" : ctx.pre?.[k] ?? "");
  const area = (k, l, rows = 3, hint = "") => `<label class="field"><span>${l}</span><textarea name="${k}" rows="${rows}" class="ltr">${v(k)}</textarea>${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
  const fields = death ? `
    ${area("admissionDx", "Admission diagnosis", 2)}
    ${area("immediateCause", "Immediate cause of death (سبب الوفاة المباشر)", 2)}
    ${area("antecedentCauses", "Antecedent causes (الأسباب المؤدية)", 2)}
    ${area("contributing", "Other contributing conditions (حالات مساعدة)", 2)}
    ${area("course", "Hospital course (سير الحالة)", 5)}
    <div class="row2">
      <label class="field"><span>CPR</span><select name="cpr">${optionsHtml(["Done", "Not done", "DNR"], existing ? r.cpr : "")}</select></label>
      <label class="field"><span>CPR duration (min)</span><input name="cprDuration" class="ltr" value="${v("cprDuration")}"></label>
    </div>
    ${area("notes", "Notes", 2)}`
    : `
    ${area("admissionDx", "Admission diagnosis (تشخيص الدخول)", 2)}
    ${area("finalDx", "Final diagnosis (التشخيص النهائي)", 2)}
    ${area("course", "Hospital course (ملخص سير الحالة)", 5)}
    ${area("procedures", "Procedures / Operations (العمليات والإجراءات)", 2)}
    ${area("investigations", "Key investigations (أهم التحاليل والأشعة)", 3, "اتملت من النتايج المسجلة. امسح اللي مش محتاجه.")}
    <label class="field"><span>Condition on discharge (حالة المريض عند الخروج)</span><input name="condition" class="ltr" list="dlCond" value="${v("condition")}" autocomplete="off">
      <datalist id="dlCond">${CONDITIONS.map((c) => `<option value="${c}">`).join("")}</datalist></label>
    ${area("dischargeMeds", "Discharge medications (علاج الخروج)", 4, "كل دواء في سطر: الاسم - الجرعة - عدد المرات - المدة")}
    ${area("instructions", "Instructions (التعليمات)", 2)}
    <div class="row2">
      <label class="field"><span>Follow-up date (ميعاد المتابعة)</span><input name="followUpDate" type="date" value="${v("followUpDate")}"></label>
      <label class="field"><span>Follow-up clinic (العيادة)</span><input name="followUpClinic" value="${v("followUpClinic")}"></label>
    </div>`;
  formDialog(death ? "تقرير الوفاة" : "تقرير الخروج", `
    <div class="info">${esc(existing ? r.patientName : a.patientName)}، ${esc(existing ? r.admissionNumber : a.admissionNumber || "")}</div>
    ${fields}`,
    existing ? "حفظ التعديل" : "حفظ التقرير", async (f) => {
      const keys = death ? ["admissionDx", "immediateCause", "antecedentCauses", "contributing", "course", "cpr", "cprDuration", "notes"]
        : ["admissionDx", "finalDx", "course", "procedures", "investigations", "condition", "dischargeMeds", "instructions", "followUpDate", "followUpClinic"];
      const d = Object.fromEntries(keys.map((k) => [k, (f.elements[k]?.value || "").trim()]));
      if (death && !d.immediateCause) return "اكتب سبب الوفاة المباشر.";
      if (!death && !d.finalDx) return "اكتب التشخيص النهائي.";
      if (existing) {
        await updateDoc(doc(db, "dischargeReports", r.id), { ...d, ...upMeta() });
        audit(death ? "تعديل تقرير وفاة" : "تعديل تقرير خروج", { adm: { id: r.admissionId, patientName: r.patientName, unitId: "" }, before: r });
        toast("تم حفظ التعديل");
        onDone?.(r.id);
        return;
      }
      const p = ctx.pat || {};
      const place = ctx.type === "icu" ? `${unitName(a.unitId)}، ${bedName(a.unitId, a.bed)}` : `${wardById(a.deptId)?.name || ""}، سرير ${a.bed}`;
      const disAt = toDate(dis.at) || new Date();
      const id = dsId(ctx.type, a.id);
      await setDoc(doc(db, "dischargeReports", id), {
        ...d, kind: death ? "death" : "discharge", admissionType: ctx.type, admissionId: a.id, patientId: a.patientId,
        patientName: a.patientName, medicalId: a.medicalId || p.medicalId || "", nationalId: a.nationalId || p.nationalId || "",
        age: ageText(p.birthDate || a.birthDate, p.birthDateEstimated), gender: p.gender || a.gender || "",
        admissionNumber: a.admissionNumber || "", place, consultant: a.consultant || "",
        admitAt: a.admitAt, dischargeAt: Timestamp.fromDate(disAt),
        los: stayDays({ admitAt: a.admitAt, status: "discharged", dischargeAt: Timestamp.fromDate(disAt) }),
        finance: finText(finBreakdown({ ...a, status: "discharged", dischargeAt: Timestamp.fromDate(disAt) })),
        dischargeType: (ctx.type === "icu" ? DIS_TYPES : WARD_DIS)[dis.type] || "", deathCause: dis.info?.deathCause || "",
        doctorName: S.profile.displayName, ...meta(),
      });
      audit(death ? "كتابة تقرير وفاة" : "كتابة تقرير خروج", { adm: { id: a.id, patientName: a.patientName, unitId: "" } });
      toast("تم حفظ التقرير");
      onDone?.(id);
    });
}

// زر "تقرير الخروج" في ملف الحالة بعد الخروج
async function dischargeSummaryAction(type) {
  const a = type === "icu" ? S.P.adm : S.W.a;
  try {
    const s = await getDoc(doc(db, "dischargeReports", dsId(type, a.id)));
    if (s.exists()) { location.hash = `#/ds/${s.id}`; return; }
  } catch {}
  const ctx = await buildDischargeContext(type);
  openDischargeSummary(ctx, null, (id) => (location.hash = `#/ds/${id}`));
}

function renderDischargeReport(id) {
  shell(`<div class="loading">جاري التحميل…</div>`);
  S.pageUnsubs.push(onSnapshot(doc(db, "dischargeReports", id), (s) => {
    if (S.page !== "ds") return;
    if (!s.exists()) { shell(`<div class="empty">التقرير غير موجود.</div>`); return; }
    const r = { id: s.id, ...s.data() };
    const death = r.kind === "death";
    const canW = isAdmin() || r.createdBy === S.profile.uid;
    const row = (l, k) => (r[k] ? `<dt>${l}</dt><dd class="pre-wrap ltr">${esc(r[k])}</dd>` : "");
    shell(`
    <div class="file-head">
      <a class="back" href="#/p/${r.patientId}">ملف المريض</a>
      <h1>${death ? "تقرير الوفاة" : "تقرير الخروج"}: ${esc(r.patientName)}</h1>
      <div class="tags"><span class="tag mr">${esc(r.medicalId)}</span><span class="tag mr">${esc(r.admissionNumber)}</span>
        <span class="tag">${esc(r.place)}</span><span class="tag">${fmtDate(r.admitAt)} ← ${fmtDate(r.dischargeAt)}، ${r.los} يوم</span></div>
      <div class="file-actions">
        ${canW ? `<button class="btn ghost" data-d="edit">تعديل</button>` : ""}
        ${canPrint() || canW ? `<button class="btn" data-d="print">طباعة / PDF</button>` : ""}
        ${isAdmin() ? `<button class="btn ghost del" data-d="del">حذف</button>` : ""}
      </div>
    </div>
    <section class="panel"><dl class="kv">
      <dt>نوع الخروج</dt><dd>${esc(r.dischargeType)}</dd><dt>المعاملة المالية</dt><dd>${esc(r.finance)}</dd>
      <dt>استشاري الحالة</dt><dd>${esc(r.consultant || "—")}</dd>
      ${death ? row("Admission diagnosis", "admissionDx") + row("Immediate cause", "immediateCause") + row("Antecedent causes", "antecedentCauses")
        + row("Contributing", "contributing") + row("Hospital course", "course") + row("CPR", "cpr") + row("CPR duration", "cprDuration") + row("Notes", "notes")
        : row("Admission diagnosis", "admissionDx") + row("Final diagnosis", "finalDx") + row("Hospital course", "course") + row("Procedures", "procedures")
        + row("Investigations", "investigations") + row("Condition", "condition") + row("Discharge medications", "dischargeMeds") + row("Instructions", "instructions")
        + (r.followUpDate || r.followUpClinic ? `<dt>Follow-up</dt><dd>${r.followUpDate ? fmtDate(r.followUpDate) : ""} ${esc(r.followUpClinic || "")}</dd>` : "")}
      <dt>الطبيب</dt><dd>${esc(r.doctorName)}، ${fmtDateTime(r.createdAt)}</dd>
    </dl></section>`);
    root.querySelector("main").onclick = async (ev) => {
      const b = ev.target.closest("[data-d]"); if (!b) return;
      if (b.dataset.d === "edit") openDischargeSummary(null, r);
      if (b.dataset.d === "print") printDischargeReport(r);
      if (b.dataset.d === "del" && confirm("حذف التقرير نهائياً؟")) {
        try { await deleteDoc(doc(db, "dischargeReports", r.id)); audit("حذف تقرير خروج", { adm: { id: r.admissionId, patientName: r.patientName, unitId: "" }, before: r });
          toast("تم الحذف"); location.hash = `#/p/${r.patientId}`; } catch (e) { toast(errText(e), true); }
      }
    };
  }, () => shell(`<div class="empty">ليس لديك صلاحية لعرض التقرير ده.</div>`)));
}

function printDischargeReport(r) {
  const death = r.kind === "death";
  const sec = (t, k) => (r[k] ? `<h2>${t}</h2><div class="pre">${esc(r[k])}</div>` : "");
  const meds = (r.dischargeMeds || "").split("\n").map((x) => x.trim()).filter(Boolean);
  printDoc(`${death ? "Death report" : "Discharge summary"} - ${r.patientName}`, `
    <div dir="ltr" style="text-align:left">
      <h1 style="text-align:center">${death ? "DEATH REPORT <span style='font-weight:400'>| تقرير وفاة</span>" : "DISCHARGE SUMMARY <span style='font-weight:400'>| تقرير خروج</span>"}</h1>
      <table><tbody>
        <tr><th>Name</th><td dir="rtl" style="text-align:right">${esc(r.patientName)}</td><th>MRN</th><td>${esc(r.medicalId)}</td></tr>
        <tr><th>Age / Sex</th><td dir="rtl" style="text-align:right">${esc(r.age || "")}، ${genderText(r.gender)}</td><th>Admission No.</th><td>${esc(r.admissionNumber)}</td></tr>
        <tr><th>National ID</th><td>${esc(r.nationalId || "—")}</td><th>Ward / Unit</th><td dir="rtl" style="text-align:right">${esc(r.place)}</td></tr>
        <tr><th>Admission</th><td>${fmtDateTime(r.admitAt)}</td><th>${death ? "Time of death" : "Discharge"}</th><td>${fmtDateTime(r.dischargeAt)}</td></tr>
        <tr><th>Length of stay</th><td>${r.los} day(s)</td><th>Consultant</th><td dir="rtl" style="text-align:right">${esc(r.consultant || "")}</td></tr>
        <tr><th>Discharge type</th><td dir="rtl" style="text-align:right">${esc(r.dischargeType)}</td><th>Financial</th><td dir="rtl" style="text-align:right">${esc(r.finance)}</td></tr>
      </tbody></table>
      ${death ? sec("Admission diagnosis", "admissionDx") + `<h2>Cause of death</h2><table><tbody>
          <tr><th style="width:34%">Immediate cause</th><td class="pre">${esc(r.immediateCause)}</td></tr>
          <tr><th>Antecedent causes</th><td class="pre">${esc(r.antecedentCauses || "—")}</td></tr>
          <tr><th>Other contributing conditions</th><td class="pre">${esc(r.contributing || "—")}</td></tr></tbody></table>`
        + sec("Hospital course", "course") + (r.cpr ? `<h2>Resuscitation</h2><p>CPR: ${esc(r.cpr)}${r.cprDuration ? `, ${esc(r.cprDuration)} min` : ""}</p>` : "") + sec("Notes", "notes")
      : sec("Admission diagnosis", "admissionDx") + sec("Final diagnosis", "finalDx") + sec("Hospital course", "course") + sec("Procedures / Operations", "procedures")
        + sec("Key investigations", "investigations") + (r.condition ? `<h2>Condition on discharge</h2><p>${esc(r.condition)}</p>` : "")
        + (meds.length ? `<h2>Discharge medications</h2><table><thead><tr><th>#</th><th>Medication</th></tr></thead><tbody>${meds.map((m, i) => `<tr><td style="width:28px">${i + 1}</td><td>${esc(m)}</td></tr>`).join("")}</tbody></table>` : "")
        + sec("Instructions", "instructions")
        + (r.followUpDate || r.followUpClinic ? `<h2>Follow-up</h2><p>${r.followUpDate ? fmtDate(r.followUpDate) : ""} ${esc(r.followUpClinic || "")}</p>` : "")}
      <div class="sign" style="direction:ltr"><span>Physician: ${esc(r.doctorName)}</span><span>Signature: ....................</span><span>Consultant: ....................</span></div>
    </div>`, true);
}

function renderDischargeReports() {
  const T = (S.RD ||= { from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), q: "", kind: "" });
  shell(reportsTabs("discharge") + `
  <form class="filters" id="dsF">
    <label class="field"><span>خروج من</span><input type="date" name="from" value="${T.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${T.to}"></label>
    <label class="field"><span>النوع</span><select name="kind"><option value="">الكل</option><option value="discharge" ${T.kind === "discharge" ? "selected" : ""}>تقرير خروج</option><option value="death" ${T.kind === "death" ? "selected" : ""}>تقرير وفاة</option></select></label>
    <label class="field grow"><span>بحث بالاسم أو الرقم الطبي أو التشخيص</span><input name="q" value="${esc(T.q)}"></label>
    <button class="btn">بحث</button>
  </form><div id="dsBody"><div class="loading">جاري التحميل…</div></div>`);
  const f = document.getElementById("dsF");
  const load = async () => {
    Object.assign(T, { from: f.elements.from.value, to: f.elements.to.value, q: f.elements.q.value.trim(), kind: f.elements.kind.value });
    const body = document.getElementById("dsBody");
    try {
      const col = collection(db, "dischargeReports");
      let rows = /^mr-?\d+$/i.test(T.q) ? (await getDocs(query(col, where("medicalId", "==", "MR-" + T.q.replace(/\D/g, ""))))).docs
        : (await getDocs(query(col, where("dischargeAt", ">=", Timestamp.fromDate(new Date(T.from + "T00:00:00"))),
          where("dischargeAt", "<=", Timestamp.fromDate(new Date(T.to + "T23:59:59"))), orderBy("dischargeAt", "desc")))).docs;
      rows = rows.map((d) => ({ id: d.id, ...d.data() }));
      if (T.q && !/^mr-?\d+$/i.test(T.q)) { const q = T.q.toLowerCase(); rows = rows.filter((r) => [r.patientName, r.finalDx, r.admissionDx, r.immediateCause].some((x) => (x || "").toLowerCase().includes(q))); }
      if (T.kind) rows = rows.filter((r) => r.kind === T.kind);
      body.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>الخروج</th><th>المريض</th><th>رقم الدخول</th><th>المكان</th><th>التشخيص</th><th>النوع</th><th>الطبيب</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="nowrap">${fmtDate(r.dischargeAt)}</td><td><a href="#/ds/${r.id}"><strong>${esc(r.patientName)}</strong></a></td>
          <td class="ltr">${esc(r.admissionNumber)}</td><td>${esc(r.place)}</td><td class="ltr-auto">${esc((r.finalDx || r.immediateCause || "").split("\n")[0])}</td>
          <td>${r.kind === "death" ? `<span class="dis t-death">وفاة</span>` : `<span class="dis">خروج</span>`}</td><td>${esc(r.doctorName)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">لا يوجد تقارير بالشروط دي.</div>`;
    } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; }
  };
  f.onsubmit = (ev) => { ev.preventDefault(); load(); };
  load();
}
function reportsTabs(tab) {
  return `<nav class="tabs"><a href="#/reports" class="${tab === "medical" ? "on" : ""}">التقارير الطبية</a>
    <a href="#/reports/discharge" class="${tab === "discharge" ? "on" : ""}">تقارير الخروج والوفاة</a></nav>`;
}

/* =========================================================
   تطبيق الموبايل (PWA) والنسخة الاحتياطية
   ========================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; refreshInstallBtn(); });
window.addEventListener("appinstalled", () => { installPrompt = null; refreshInstallBtn(); toast("تم تثبيت التطبيق"); });
function refreshInstallBtn() {
  const b = document.getElementById("installBtn");
  if (b) b.classList.toggle("hidden", !installPrompt);
}
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  refreshInstallBtn();
}

/* ---------- النسخة الاحتياطية (Excel) ---------- */
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => res(window.XLSX);
    s.onerror = () => rej(new Error("تعذر تحميل مكتبة Excel. تأكد من الإنترنت."));
    document.head.appendChild(s);
  });
}
const XL_HEAD = {
  _id: "المعرّف", patientName: "اسم المريض", name: "الاسم", medicalId: "الرقم الطبي", nationalId: "الرقم القومي",
  motherName: "اسم الأم", motherNationalId: "الرقم القومي للأم", birthDate: "تاريخ الميلاد", gender: "النوع", address: "العنوان",
  phone: "تليفون 1", phone2: "تليفون 2", admissionNumber: "رقم الدخول", admitAt: "تاريخ الدخول", dischargeAt: "تاريخ الخروج",
  dischargeType: "نوع الخروج", unitId: "الوحدة", deptId: "القسم", bed: "السرير", consultant: "استشاري الحالة",
  specialties: "التخصصات المشتركة", finance: "المعاملة المالية الحالية", financeHistory: "تاريخ المعاملة المالية",
  status: "الحالة", diagnosis: "التشخيص", history: "التاريخ المرضي", operation: "العملية", proposedAt: "الميعاد المقترح",
  doneAt: "ميعاد التنفيذ", anesthesia: "استشاري التخدير", specialty: "التخصص", caseType: "نوع الحالة", number: "الرقم",
  doctorName: "الطبيب", reportDate: "تاريخ التقرير", createdByName: "سجّله", createdAt: "وقت التسجيل", updatedAt: "آخر تعديل",
  updatedByName: "عدّله", dischargedByName: "سجّل الخروج", at: "الوقت", kind: "النوع", text: "النص", los: "أيام الإقامة",
};
const XL_DROP = new Set(["createdBy", "updatedBy", "dischargedBy", "resultBy", "givenBy", "adminUid", "logo", "birthDateEstimated", "isNewborn"]);
function xlDate(d) { return `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function xlVal(v) {
  if (v == null) return "";
  if (v?.toDate) return xlDate(v.toDate());
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? xlObj(x) : String(x))).join(" | ");
  if (typeof v === "object") return xlObj(v);
  return v;
}
const xlObj = (o) => Object.entries(o).filter(([k]) => !XL_DROP.has(k)).map(([k, x]) => `${k}: ${x?.toDate ? xlDate(x.toDate()) : typeof x === "object" && x ? JSON.stringify(x) : x}`).join("، ");
function xlRows(list, map = {}) {
  return list.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (XL_DROP.has(k)) continue;
      let val = map[k] ? map[k](v, r) : xlVal(v);
      if (typeof val === "string" && val.length > 32000) val = val.slice(0, 32000) + "…";
      o[XL_HEAD[k] || k] = val;
    }
    return o;
  });
}

function tabBackup(body) {
  const last = S.settings.lastBackupAt;
  body.innerHTML = `
  <div class="settings-block" style="max-width:640px">
    <div class="toolbar"><h2>نسخة احتياطية</h2></div>
    <p>بتنزل ملف Excel فيه كل بيانات البرنامج، كل نوع في شيت لوحده: المرضى، ودخول الرعاية، ودخول الداخلي، والعمليات، والتقارير الطبية، وتقارير الخروج، والمستخدمين (من غير كلمات المرور)، وآخر 2000 عملية في سجل التعديلات.</p>
    <p class="${last ? "muted" : "note"}">${last ? `آخر نسخة: ${fmtDateTime(last)}` : "لسه متعملش أي نسخة احتياطية."}</p>
    <div class="checks"><label><input type="checkbox" id="bkFull"> تضمين ملفات المتابعة كاملة (العلامات الحيوية، والعلاج، والتشخيصات، وسجلات الأدوية)</label></div>
    <p class="hint">الاختيار ده بيقرأ بيانات أكتر بكتير وبياخد وقت أطول، واستخدامه مرة في الأسبوع كفاية.</p>
    <div class="actions"><button class="btn" id="bkRun">تنزيل النسخة الاحتياطية</button></div>
    <div id="bkLog" class="by-line" style="margin-top:10px"></div>
  </div>`;
  document.getElementById("bkRun").onclick = async (ev) => {
    const btn = ev.currentTarget; btn.disabled = true;
    const log = (t) => (document.getElementById("bkLog").textContent = t);
    try { await runBackup(document.getElementById("bkFull").checked, log); }
    catch (e) { log(""); toast(e.message?.startsWith("تعذر") ? e.message : errText(e), true); }
    btn.disabled = false;
  };
}

async function runBackup(full, log) {
  log("جاري تحميل مكتبة Excel…");
  const XLSX = await loadXLSX();
  const get = async (name, label) => { log(`جاري قراءة ${label}…`); return (await getDocs(collection(db, name))).docs.map((d) => ({ _id: d.id, ...d.data() })); };
  const unitMap = { unitId: (v) => unitName(v), dischargeType: (v) => DIS_TYPES[v] || v || "", gender: (v) => genderText(v) };
  const wardMap = { deptId: (v) => wardById(v)?.name || v, dischargeType: (v) => WARD_DIS[v] || v || "", gender: (v) => genderText(v) };
  const patients = await get("patients", "المرضى");
  const icu = await get("admissions", "دخول الرعاية");
  const ward = await get("wardAdmissions", "دخول الداخلي");
  const ops = await get("operations", "العمليات");
  const reports = await get("medicalReports", "التقارير الطبية");
  const ds = await get("dischargeReports", "تقارير الخروج");
  const users = await get("users", "المستخدمين");
  log("جاري قراءة سجل التعديلات…");
  const audits = (await getDocs(query(collection(db, "audit"), orderBy("at", "desc"), limit(2000)))).docs.map((d) => ({ _id: d.id, ...d.data() }));
  const sheets = [
    ["المرضى", xlRows(patients, { gender: (v) => genderText(v) })],
    ["دخول الرعاية", xlRows(icu.map((a) => ({ ...a, los: stayDays(a), financeDays: finText(finBreakdown(a)) })), unitMap)],
    ["دخول الداخلي", xlRows(ward.map((a) => ({ ...a, los: stayDays(a), financeDays: finText(finBreakdown(a)) })), wardMap)],
    ["العمليات", xlRows(ops, { status: (v) => OP_STATUS[v] || v })],
    ["التقارير الطبية", xlRows(reports)],
    ["تقارير الخروج", xlRows(ds, { gender: (v) => genderText(v) })],
    ["المستخدمين", xlRows(users.map(({ sections, ...u }) => ({ ...u, sections: Object.entries(sections || {}).map(([k, v]) => `${SECTIONS[k] || k}: ${LEVELS[v] || v}`).join("، ") })))],
    ["سجل التعديلات", xlRows(audits)],
  ];
  if (full) {
    const sub = { entries: [], vitals: [], meds: [], wardMeds: [], opMeds: [] };
    for (let i = 0; i < icu.length; i++) {
      const a = icu[i];
      log(`جاري قراءة ملفات المتابعة (${i + 1} من ${icu.length})…`);
      for (const k of ["entries", "vitals", "meds"]) {
        (await getDocs(collection(db, "admissions", a._id, k))).forEach((d) => sub[k].push({ admissionNumber: a.admissionNumber || a._id, patientName: a.patientName, ...d.data() }));
      }
    }
    for (let i = 0; i < ward.length; i++) {
      log(`جاري قراءة أدوية الداخلي (${i + 1} من ${ward.length})…`);
      (await getDocs(collection(db, "wardAdmissions", ward[i]._id, "medlog"))).forEach((d) => sub.wardMeds.push({ admissionNumber: ward[i].admissionNumber, patientName: ward[i].patientName, ...d.data() }));
    }
    for (let i = 0; i < ops.length; i++) {
      log(`جاري قراءة أدوية العمليات (${i + 1} من ${ops.length})…`);
      (await getDocs(collection(db, "operations", ops[i]._id, "medlog"))).forEach((d) => sub.opMeds.push({ number: ops[i].number, patientName: ops[i].patientName, ...d.data() }));
    }
    const vit = sub.vitals.map(({ values, ...r }) => ({ ...r, ...Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [`قراءة: ${k}`, v])) }));
    sheets.push(["رعاية - الحالة والتشخيص", xlRows(sub.entries)], ["رعاية - العلامات الحيوية", xlRows(vit)],
      ["رعاية - العلاج", xlRows(sub.meds)], ["داخلي - الأدوية", xlRows(sub.wardMeds)], ["عمليات - الأدوية", xlRows(sub.opMeds)]);
  }
  log("جاري تجهيز الملف…");
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ "": "لا يوجد بيانات" }]), name);
  const fname = `نسخة-احتياطية-${isoDay(new Date())}${full ? "-كاملة" : ""}.xlsx`;
  XLSX.writeFile(wb, fname);
  await updateDoc(doc(db, "config", "settings"), { lastBackupAt: Timestamp.now() });
  audit(full ? "نسخة احتياطية كاملة" : "نسخة احتياطية", { adm: { id: "", patientName: "", unitId: "" } });
  log(`تم تنزيل ${fname}. احفظه في مكان آمن برة الجهاز ده (Google Drive مثلاً).`);
}

/* =========================================================
   منع تكرار المرضى، الدخول المتكرر، وسجل مرات الدخول
   ========================================================= */
// توحيد الاسم للمقارنة: أ/إ/آ = ا، ة = ه، ى = ي، من غير تشكيل ومسافات زيادة
function nameKey(n) {
  return String(n || "").replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه")
    .replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/\s+/g, " ").trim().toLowerCase();
}
async function findNameDuplicates(name, excludeId) {
  const key = nameKey(name);
  if (!key || key === nameKey("مجهول الهوية")) return [];
  const col = collection(db, "patients");
  const [a, b] = await Promise.all([getDocs(query(col, where("nameKey", "==", key))), getDocs(query(col, where("name", "==", String(name).trim())))]);
  const m = new Map();
  [a, b].forEach((s) => s.docs.forEach((d) => { if (d.id !== excludeId) m.set(d.id, { id: d.id, ...d.data() }); }));
  return [...m.values()];
}
// بيعرض المرضى المسجلين بنفس الاسم جوه النموذج، ومعاهم زرار "استخدم الملف ده"
function showDuplicates(box, list, onUse) {
  box.innerHTML = `<div class="dup-box">
    <strong>فيه ${list.length === 1 ? "مريض متسجل" : `${list.length} مرضى متسجلين`} بنفس الاسم:</strong>
    <ul class="pick-list">${list.map((p) => `<li><button type="button" data-use="${p.id}">${patientLine(p)}
      ${p.currentAdmissionId ? `<span class="dis">في الرعاية الآن</span>` : p.currentWardId ? `<span class="dis t-ward">في الداخلي الآن</span>` : ""}
      <span class="use">استخدم الملف ده</span></button></li>`).join("")}</ul>
    <div class="checks"><label><input type="checkbox" name="dupOk"> ده مريض مختلف بنفس الاسم، سجّله ملف جديد</label></div></div>`;
  box.querySelectorAll("[data-use]").forEach((b) => (b.onclick = () => onUse(list.find((x) => x.id === b.dataset.use))));
}

const visitEntry = (type, id, number, admitAt, place) => ({ type, id, number: number || "", admitAt, place: place || "", dischargeAt: null, dischargeType: "" });
const visitsAfterDischarge = (pd, id, at, type) => (pd?.visits || []).map((v) => (v.id === id ? { ...v, dischargeAt: Timestamp.fromDate(at), dischargeType: type } : v));

function visitsListHtml(p, curId) {
  const v = [...(p?.visits || [])].sort((x, y) => toDate(y.admitAt) - toDate(x.admitAt));
  if (!v.length) return "";
  return `<div class="visit-hist"><h3>مرات الدخول (${v.length})</h3><ul class="prev-list">${v.map((x) => {
    const href = x.type === "icu" ? `#/patient/${x.id}` : `#/w/${x.id}`;
    const canOpen = x.id !== curId && (isAdmin() || !x.dischargeAt);
    const types = x.type === "icu" ? DIS_TYPES : WARD_DIS;
    const inner = `<strong>${fmtDate(x.admitAt)}</strong><span>${x.type === "icu" ? "رعاية" : "داخلي"}: ${esc(x.place)}</span>
      <span class="ltr muted">${esc(x.number)}</span>
      <span class="by-line">${x.dischargeAt ? `خروج ${fmtDate(x.dischargeAt)}، ${types[x.dischargeType] || ""}` : "موجود حالياً"}</span>
      ${x.id === curId ? `<span class="pill">الدخول ده</span>` : ""}`;
    return `<li>${canOpen ? `<a href="${href}">${inner}</a>` : `<div class="pv">${inner}</div>`}</li>`;
  }).join("")}</ul></div>`;
}

// إصلاح سجل الدخولات للمرضى القدام (الأدمن بس، من ملف المريض الشامل)
async function healVisits(p, icu, ward) {
  if (!isAdmin() || !icu || !ward) return;
  const built = [
    ...icu.map((a) => ({ ...visitEntry("icu", a.id, a.admissionNumber, a.admitAt, unitName(a.unitId)), dischargeAt: a.dischargeAt || null, dischargeType: a.dischargeType || "" })),
    ...ward.map((a) => ({ ...visitEntry("ward", a.id, a.admissionNumber, a.admitAt, wardById(a.deptId)?.name), dischargeAt: a.dischargeAt || null, dischargeType: a.dischargeType || "" })),
  ];
  const same = (p.visits || []).length === built.length && built.every((b) => (p.visits || []).some((v) => v.id === b.id && !!v.dischargeAt === !!b.dischargeAt));
  const upd = {};
  if (!same) upd.visits = built;
  if (!p.nameKey) upd.nameKey = nameKey(p.name);
  if (Object.keys(upd).length) await updateDoc(doc(db, "patients", p.id), upd).catch(() => {});
}

// زرار الدخول / الدخول المتكرر من نتايج البحث
function admitChoice(p) {
  if (p.currentAdmissionId || p.currentWardId) { toast("المريض ده موجود حالياً في دخول، ولازم يخرج الأول.", true); return; }
  const icu = canEdit("icu") && visibleUnits().some((u) => canWriteUnit(u.id));
  const ward = canEdit("ward") && wardUnits().length > 0;
  if (icu && !ward) return chooseIcuBed(p);
  if (ward && !icu) return openWardAdmission(p);
  const again = (p.visits || []).length || p.admissionsCount || p.wardCount;
  openDialog(`<div class="form"><header class="dlg-head"><h3>${again ? "دخول متكرر" : "دخول"}: ${esc(p.name)}</h3><p class="ltr">${esc(p.medicalId || "")}</p></header>
    ${visitsListHtml(p)}
    <div class="actions"><button class="btn" id="acIcu">دخول رعاية</button><button class="btn" id="acWard">دخول داخلي</button>
    <button type="button" class="btn ghost" data-close>إلغاء</button></div></div>`);
  document.getElementById("acIcu").onclick = () => { closeDialog(); setTimeout(() => chooseIcuBed(p), 0); };
  document.getElementById("acWard").onclick = () => { closeDialog(); setTimeout(() => openWardAdmission(p), 0); };
}

/* =========================================================
   المرحلة 9: التمريض، طلبات الاستشارة، تسليم الشيفت، شاشة العرض
   ========================================================= */
const NURSE_SECS = ["icu", "ward"];
const levelsFor = (sec) => (NURSE_SECS.includes(sec) ? { none: "مفيش دخول", read: "عرض فقط", nurse: "تمريض", write: "عرض وكتابة" } : LEVELS);
const levelLabel = (v) => ({ ...LEVELS, nurse: "تمريض" }[v] || v);
const isNurse = (sec) => lvl(sec) === "nurse";

// الرعاية: الطبيب أو التمريض يقدر يسجل علامات حيوية وملاحظات تمريض
function pCanNurse() {
  const a = S.P.adm;
  if (isAdmin()) return true;
  if (a.status !== "active") return false;
  return canWriteUnit(a.unitId) || (isNurse("icu") && (S.profile.units || []).includes(a.unitId));
}
function pCanEditN(t) {
  if (!pCanNurse()) return false;
  if (isAdmin()) return true;
  const d = toDate(t);
  return !!d && d >= earliestEditable();
}

/* ---------- ملاحظات التمريض (رعاية) ---------- */
function ptNursing() {
  const list = S.P.entries.filter((e) => e.kind === "nursing").sort(desc);
  return `
  <section class="panel">
    <header><h2>ملاحظات التمريض</h2>${pCanNurse() ? `<button class="btn ghost sm" data-act="nAdd">إضافة ملاحظة</button>` : ""}</header>
    ${list.length ? `<ul class="entries">${list.map((e) => `
      <li><div class="entry-head"><span class="pill">${shiftName(e.at)}</span><span class="by-line">${esc(e.createdByName)}، ${fmtDateTime(e.at)}</span>
        ${pCanEditN(e.at) && (isAdmin() || e.createdBy === S.profile.uid) ? `<button class="btn ghost sm" data-act="nEdit" data-id="${e.id}">تعديل</button>` : ""}</div>
        <p class="pre-wrap ltr-auto">${esc(e.text)}</p></li>`).join("")}</ul>` : `<p class="muted">لا يوجد ملاحظات.</p>`}
  </section>`;
}
function openNursingNote(e) {
  formDialog(e ? "تعديل ملاحظة التمريض" : "ملاحظة تمريض", `
    <label class="field"><span>الملاحظة</span><textarea name="text" rows="5" class="ltr-auto">${esc(e?.text || "")}</textarea></label>
    ${timeInput("at", "الوقت", e?.at || new Date())}`,
    e ? "حفظ التعديل" : "حفظ", async (f) => {
      const text = f.elements.text.value.trim();
      if (!text) return "اكتب الملاحظة.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      if (e) await pUpd(subRef("entries", e.id), { text, at: Timestamp.fromDate(at), ...upMeta() });
      else await addDoc(subRef("entries"), { kind: "nursing", text, at: Timestamp.fromDate(at), ...meta() });
      toast("تم الحفظ");
    }, e ? () => pDel(subRef("entries", e.id)) : null);
}

/* ---------- ملاحظات التمريض (داخلي) ---------- */
function wardNotesHtml(notes, canAdd) {
  const list = [...notes].sort(desc).slice(0, 30);
  return `<section class="panel stack-gap" id="wNotes"><header><h2>ملاحظات التمريض</h2></header>
    ${canAdd ? `<form class="add-row" data-noteadd><input name="text" placeholder="اكتب ملاحظة واضغط حفظ" autocomplete="off"><button class="btn sm">حفظ</button></form>` : ""}
    ${list.length ? `<ul class="entries">${list.map((n) => `<li><div class="entry-head"><span class="pill">${shiftName(n.at)}</span>
      <span class="by-line">${esc(n.createdByName)}، ${fmtDateTime(n.at)}</span></div><p class="pre-wrap ltr-auto">${esc(n.text)}</p></li>`).join("")}</ul>`
      : `<p class="muted">لا يوجد ملاحظات.</p>`}</section>`;
}
function bindWardNotes(aid) {
  const f = document.querySelector("#wNotes [data-noteadd]");
  if (!f) return;
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const text = f.elements.text.value.trim();
    if (!text) return;
    try { await addDoc(collection(db, "wardAdmissions", aid, "notes"), { text, at: Timestamp.now(), ...meta() }); toast("تم الحفظ"); }
    catch (e) { toast(errText(e), true); }
  };
}

/* ---------- طلبات الاستشارة ---------- */
const URGENCY = ["عادي", "عاجل"];
const CONSULT_STATUS = { pending: "منتظر", answered: "تم الرد", cancelled: "ملغي" };
const mySpecs = () => S.profile?.specialties || [];

function openConsultRequest(source, a) {
  const place = source === "icu" ? `${unitName(a.unitId)}، ${bedName(a.unitId, a.bed)}` : `${wardById(a.deptId)?.name || ""}، سرير ${a.bed}`;
  formDialog(`طلب استشارة: ${esc(a.patientName)}`, `
    <div class="row2">
      <label class="field"><span>التخصص المطلوب</span><select name="specialty">${optionsHtml(S.settings.specialties || [], "")}</select></label>
      <label class="field"><span>الأولوية</span><select name="urgency">${URGENCY.map((u) => `<option>${u}</option>`).join("")}</select></label>
    </div>
    <label class="field"><span>سبب الاستشارة والسؤال</span><textarea name="reason" rows="4" class="ltr-auto"></textarea></label>`,
    "إرسال الطلب", async (f) => {
      const specialty = f.elements.specialty.value, reason = f.elements.reason.value.trim();
      if (!specialty) return "اختر التخصص.";
      if (!reason) return "اكتب سبب الاستشارة.";
      await addDoc(collection(db, "consults"), {
        specialty, urgency: f.elements.urgency.value, reason, status: "pending", source, admissionId: a.id,
        patientId: a.patientId, patientName: a.patientName, medicalId: a.medicalId || "", place,
        diagnosis: source === "icu" ? S.P?.entries?.filter((e) => e.kind === "diagnosis").sort(desc)[0]?.text || "" : a.diagnosis || "",
        fromUid: S.profile.uid, fromName: S.profile.displayName, seenByRequester: true, createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, source === "icu" ? "admissions" : "wardAdmissions", a.id),
        { consultSpecs: arrayUnion(specialty), deptAccess: arrayUnion(specialty) }).catch(() => {});
      audit(`طلب استشارة ${specialty}`, { adm: { id: a.id, patientName: a.patientName, unitId: a.unitId || a.deptId } });
      toast("تم إرسال طلب الاستشارة");
    });
}

function consultListHtml(list, compact) {
  if (!list.length) return `<p class="muted">لا يوجد طلبات.</p>`;
  return `<ul class="entries">${[...list].sort((x, y) => toDate(y.createdAt) - toDate(x.createdAt)).map((c) => `
    <li class="consult ${c.status}">
      <div class="entry-head"><span class="pill">${esc(c.specialty)}</span>
        ${c.urgency === "عاجل" ? `<span class="dis t-death">عاجل</span>` : ""}
        <span class="dis ${c.status === "answered" ? "" : c.status === "pending" ? "op-scheduled" : "op-cancelled"}">${CONSULT_STATUS[c.status]}</span>
        ${compact ? "" : `${isDept() && c.status !== "pending" ? `<strong>${esc(c.patientName)}</strong>` : `<a href="${c.source === "icu" ? `#/patient/${c.admissionId}` : `#/w/${c.admissionId}`}"><strong>${esc(c.patientName)}</strong></a>`}<span class="muted">${esc(c.place)}</span>`}
        <span class="by-line">طلبه ${esc(c.fromName)}، ${fmtDateTime(c.createdAt)}</span>
        <span class="cs-acts">
          ${c.status === "pending" && (isAdmin() || mySpecs().includes(c.specialty)) ? `<button class="btn sm" data-cans="${c.id}">الرد</button>` : ""}
          ${c.status === "pending" && (isAdmin() || c.fromUid === S.profile.uid) ? `<button class="btn ghost sm del" data-ccan="${c.id}">إلغاء</button>` : ""}
        </span></div>
      <p class="ltr-auto"><strong>السؤال:</strong> ${pre(c.reason)}</p>
      ${c.answer ? `<p class="answer ltr-auto"><strong>الرد (${esc(c.answeredByName)}، ${fmtDateTime(c.answeredAt)}):</strong><br>${pre(c.answer)}</p>` : ""}
    </li>`).join("")}</ul>`;
}
function bindConsultActions(container, list) {
  container.querySelectorAll("[data-cans]").forEach((b) => (b.onclick = () => openConsultAnswer(list.find((x) => x.id === b.dataset.cans))));
  container.querySelectorAll("[data-ccan]").forEach((b) => (b.onclick = async () => {
    if (!confirm("إلغاء طلب الاستشارة؟")) return;
    try { await updateDoc(doc(db, "consults", b.dataset.ccan), { status: "cancelled", cancelledByName: S.profile.displayName, cancelledAt: serverTimestamp() });
      const cc = list.find((x) => x.id === b.dataset.ccan); if (cc) await revokeConsultAccess(cc);
      toast("تم الإلغاء"); }
    catch (e) { toast(errText(e), true); }
  }));
}
function openConsultAnswer(c) {
  formDialog(`الرد على استشارة ${esc(c.specialty)}`, `
    <div class="info"><strong>${esc(c.patientName)}</strong> ${esc(c.medicalId)}، ${esc(c.place)}${c.diagnosis ? `<br>التشخيص: ${esc(c.diagnosis)}` : ""}</div>
    <p class="ltr-auto"><strong>السؤال (${esc(c.fromName)}):</strong><br>${pre(c.reason)}</p>
    <label class="field"><span>الرأي والتوصيات</span><textarea name="answer" rows="6" class="ltr-auto"></textarea></label>`,
    "إرسال الرد", async (f) => {
      const answer = f.elements.answer.value.trim();
      if (!answer) return "اكتب الرد.";
      await updateDoc(doc(db, "consults", c.id), { status: "answered", answer, answeredBy: S.profile.uid, answeredByName: S.profile.displayName,
        answeredAt: serverTimestamp(), seenByRequester: false });
      await revokeConsultAccess(c);
      audit(`رد على استشارة ${c.specialty}`, { adm: { id: c.admissionId, patientName: c.patientName, unitId: "" } });
      toast("تم إرسال الرد");
    });
}

function renderConsults(tab = "in") {
  shell(`<nav class="tabs"><a href="#/consults" class="${tab === "in" ? "on" : ""}">الطلبات الواردة</a>
    ${isDept() ? "" : `<a href="#/consults/mine" class="${tab === "mine" ? "on" : ""}">طلباتي</a>`}</nav>
    ${tab === "in" && !isAdmin() && !mySpecs().length ? `<div class="note">حسابك مش متحدد له تخصص، فمش هيوصلك طلبات. الأدمن يحدده من الإعدادات > المستخدمين.</div>` : ""}
    <div id="csBody"><div class="loading">جاري التحميل…</div></div>`);
  const body = document.getElementById("csBody");
  const col = collection(db, "consults");
  const q = tab === "mine" ? (isDept() ? null : query(col, where("fromUid", "==", S.profile.uid)))
    : isAdmin() ? query(col, orderBy("createdAt", "desc"), limit(200))
    : mySpecs().length ? query(col, isDept() ? where("specialty", "==", S.profile.deptSpecialty) : where("specialty", "in", mySpecs().slice(0, 10))) : null;
  if (!q) { body.innerHTML = ""; return; }
  S.pageUnsubs.push(onSnapshot(q, async (s) => {
    const list = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    const pending = list.filter((c) => c.status === "pending"), rest = list.filter((c) => c.status !== "pending");
    body.innerHTML = `<h3 class="st-h">منتظر (${pending.length})</h3>${consultListHtml(pending)}
      <h3 class="st-h">السابق</h3>${consultListHtml(rest.sort((x, y) => toDate(y.createdAt) - toDate(x.createdAt)).slice(0, 60))}`;
    bindConsultActions(body, list);
    if (tab === "mine") {
      const unseen = list.filter((c) => c.status === "answered" && c.seenByRequester === false);
      for (const c of unseen) updateDoc(doc(db, "consults", c.id), { seenByRequester: true }).catch(() => {});
    }
  }, (e) => (body.innerHTML = `<div class="err">${esc(errText(e))}</div>`)));
}

// اشتراك التنبيهات: الطلبات المنتظرة لتخصصاتي، والردود الجديدة على طلباتي
let consultUnsubs = [];
function subscribeConsults() {
  consultUnsubs.forEach((u) => u()); consultUnsubs = [];
  S.consultIn = []; S.consultAnswered = [];
  if (!S.profile) return;
  const col = collection(db, "consults");
  if (mySpecs().length) consultUnsubs.push(onSnapshot(query(col, where("status", "==", "pending"), isDept() ? where("specialty", "==", S.profile.deptSpecialty) : where("specialty", "in", mySpecs().slice(0, 10))),
    (s) => { S.consultIn = s.docs.map((d) => ({ id: d.id, ...d.data() })); liveRefresh(); }, () => {}));
  if (!isDept()) consultUnsubs.push(onSnapshot(query(col, where("fromUid", "==", S.profile.uid), where("seenByRequester", "==", false)),
    (s) => { S.consultAnswered = s.docs.map((d) => ({ id: d.id, ...d.data() })); liveRefresh(); }, () => {}));
}

/* ---------- تسليم الشيفت ---------- */
const shiftKey = (d = new Date()) => { const s = shiftStart(d); return `${isoDay(s)}${s.getHours() === 9 ? "D" : "N"}`; };
function handoverOptions() {
  const o = [];
  visibleUnits().forEach((u) => o.push({ key: `icu:${u.id}`, name: u.name, type: "icu", id: u.id }));
  if (canSee("ward")) wardUnits().forEach((u) => o.push({ key: `ward:${u.id}`, name: u.name, type: "ward", id: u.id }));
  return o;
}
async function renderHandover(key) {
  const opts = handoverOptions();
  if (!opts.length) { shell(`<div class="empty">مفيش وحدات أو أقسام متاحة ليك.</div>`); return; }
  const sel = opts.find((o) => o.key === key) || opts[0];
  const cur = shiftKey(), prev = shiftKey(new Date(shiftStart().getTime() - 3600e3));
  shell(`
  <div class="toolbar"><h2>تسليم الشيفت</h2><button class="btn ghost" id="hoPrint">طباعة</button></div>
  <nav class="unit-bar">${opts.map((o) => `<a href="#/handover/${o.key}" class="chip ${o.key === sel.key ? "on" : ""}">${esc(o.name)}</a>`).join("")}</nav>
  <p class="muted">الشيفت الحالي: ${shiftName(new Date())} (من ${fmtDateTime(shiftStart())}). الملاحظات بتتحفظ لوحدها أول ما تخرج من الخانة.</p>
  <div id="hoBody"><div class="loading">جاري تجهيز التقرير…</div></div>`);
  const body = document.getElementById("hoBody");
  const list = sel.type === "icu" ? [...(S.adm[sel.id] || [])] : (S.wardActive || []).filter((a) => a.deptId === sel.id);
  list.sort((x, y) => x.bed - y.bed);
  const canNote = isAdmin() || (sel.type === "icu" ? canWriteUnit(sel.id) || isNurse("icu") : canEdit("ward") || isNurse("ward"));
  let rows;
  try {
    rows = await Promise.all(list.map(async (a) => {
      const r = { a };
      const col = sel.type === "icu" ? "admissions" : "wardAdmissions";
      const [n1, n0] = await Promise.all([getDoc(doc(db, "handover", `${a.id}_${cur}`)), getDoc(doc(db, "handover", `${a.id}_${prev}`))]);
      r.note = n1.exists() ? n1.data().text : ""; r.prevNote = n0.exists() ? n0.data().text : "";
      if (sel.type === "icu") {
        const [ent, vit, meds] = await Promise.all(["entries", "vitals", "meds"].map((k) => getDocs(collection(db, col, a.id, k))));
        const E = ent.docs.map((d) => d.data()), V = vit.docs.map((d) => d.data()).sort(desc), M = meds.docs.map((d) => d.data());
        r.dx = E.filter((e) => e.kind === "diagnosis").sort(desc)[0]?.text || "";
        r.pending = E.filter((e) => e.kind === "investigation" && !e.result).map((e) => e.name);
        r.lastV = V[0]; r.meds = M.filter((m) => !m.stopDate && !medEnded(m)).length;
      } else {
        const ml = await getDocs(collection(db, col, a.id, "medlog"));
        r.dx = a.diagnosis || ""; r.pending = [a.xrays, a.labs, a.requests].filter(Boolean);
        r.notGiven = ml.docs.filter((d) => !d.data().given).length;
      }
      return r;
    }));
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }
  const fields = sel.type === "icu" ? unitVitals(unitById(sel.id)).slice(0, 6) : [];
  const vitTxt = (v) => (v ? fields.filter((f) => v.values?.[f.key]).map((f) => `${f.label}: ${v.values[f.key]}`).join("، ") : "");
  S.HO = { sel, rows, vitTxt, cur };
  body.innerHTML = rows.length ? `<div class="table-wrap"><table class="ho">
    <thead><tr><th>السرير</th><th>المريض</th><th>التشخيص</th><th>الحالة</th><th>منتظر</th><th>ملاحظات الشيفت اللي فات</th><th>ملاحظات التسليم</th></tr></thead>
    <tbody>${rows.map((r) => { const a = r.a; return `<tr>
      <td class="nowrap"><strong>${a.bed}</strong></td>
      <td><a href="${sel.type === "icu" ? `#/patient/${a.id}` : `#/w/${a.id}`}"><strong>${esc(a.patientName)}</strong></a>
        <div class="by-line">${esc(ageText(a.birthDate, a.birthDateEstimated))}، ${genderText(a.gender)}، اليوم ${stayDays(a)}</div>
        <div class="by-line">${esc(a.consultant || "")}</div></td>
      <td class="ltr-auto">${pre(r.dx || "—")}</td>
      <td>${sel.type === "icu" ? `${a.clinical?.resp ? `<span class="pill">${RESP_SHORT[a.clinical.resp]}</span>` : ""}
        ${a.clinical?.apache != null ? `<span class="pill">APACHE ${a.clinical.apache}</span>` : ""}
        ${a.clinical?.consciousness ? `<span class="pill">${esc(a.clinical.consciousness)}</span>` : ""}
        ${Number(a.clinical?.bedsore) > 0 ? `<span class="pill">قرحة ${a.clinical.bedsore}</span>` : ""}
        <div class="by-line ltr-auto">${esc(vitTxt(r.lastV))}${r.lastV ? ` (${fmtTime(r.lastV.at)})` : ""}</div>
        ${r.lastV?.note ? `<div class="by-line ltr-auto">${esc(r.lastV.note)}</div>` : ""}
        <div class="by-line">${r.meds} علاج شغال</div>`
        : `${r.notGiven ? `<span class="wait">${r.notGiven} دواء لم يُعطَ</span>` : "—"}`}</td>
      <td class="ltr-auto">${r.pending.length ? r.pending.map((x) => `<div>${esc(x)}</div>`).join("") : "—"}</td>
      <td class="ltr-auto pre-wrap muted">${esc(r.prevNote || "")}</td>
      <td>${canNote ? `<textarea class="ho-note ltr-auto" data-aid="${a.id}" rows="3">${esc(r.note)}</textarea>` : `<div class="pre-wrap">${esc(r.note)}</div>`}</td>
    </tr>`; }).join("")}</tbody></table></div>` : `<div class="empty">مفيش مرضى في ${esc(sel.name)} دلوقتي.</div>`;
  body.querySelectorAll(".ho-note").forEach((t) => (t.onchange = async () => {
    try {
      await setDoc(doc(db, "handover", `${t.dataset.aid}_${cur}`), { admissionId: t.dataset.aid, shift: cur, text: t.value.trim(),
        updatedByName: S.profile.displayName, updatedBy: S.profile.uid, at: serverTimestamp() }, { merge: true });
      const r = rows.find((x) => x.a.id === t.dataset.aid); if (r) r.note = t.value.trim();
      toast("اتحفظت الملاحظة");
    } catch (e) { toast(errText(e), true); }
  }));
  document.getElementById("hoPrint").onclick = () => printHandover();
}
function printHandover() {
  const { sel, rows, vitTxt } = S.HO || {};
  if (!rows) return;
  printDoc(`تسليم شيفت ${sel.name}`, `
    <style>@page{size:A4 landscape;margin:10mm}</style>
    <h1>تسليم الشيفت: ${esc(sel.name)}</h1>
    <p class="sub">${shiftName(new Date())}، ${fmtDateTime(new Date())}، عدد المرضى ${rows.length}</p>
    <table><thead><tr><th>سرير</th><th>المريض</th><th>التشخيص</th><th>الحالة</th><th>منتظر</th><th>ملاحظات التسليم</th></tr></thead><tbody>
    ${rows.map((r) => { const a = r.a; return `<tr><td>${a.bed}</td><td><strong>${esc(a.patientName)}</strong><br><small>${esc(ageText(a.birthDate, a.birthDateEstimated))}، اليوم ${stayDays(a)}، ${esc(a.consultant || "")}</small></td>
      <td class="pre ltr">${esc(r.dx || "")}</td>
      <td>${sel.type === "icu" ? `${esc(RESP_SHORT[a.clinical?.resp] || "")} ${a.clinical?.apache != null ? `APACHE ${a.clinical.apache}` : ""}<br><small>${esc(vitTxt(r.lastV))}</small>` : r.notGiven ? `${r.notGiven} دواء لم يُعطَ` : ""}</td>
      <td class="ltr">${r.pending.map(esc).join("<br>")}</td><td class="pre" style="min-width:160px">${esc(r.note || "")}</td></tr>`; }).join("")}
    </tbody></table>
    <div class="sign"><span>المُسلِّم: ....................</span><span>المُستلِم: ....................</span></div>`, false);
}

/* ---------- شاشة عرض الأسرّة ---------- */
function renderBoard() {
  const names = S.boardNames;
  const init = (n) => String(n || "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join(".");
  const tile = (a, n, cls, href) => a
    ? `<div class="bt occ ${cls}"><span class="bn">${n}</span><span class="bd">${dayOfStay(a.admitAt)}</span>
        <span class="bp">${esc(names ? a.patientName : init(a.patientName))}</span>${a.clinical?.resp === "vent" ? `<span class="bv">فنت</span>` : ""}</div>`
    : `<div class="bt free"><span class="bn">${n}</span></div>`;
  const group = (title, beds, byBed, cls) => {
    let t = ""; for (let n = 1; n <= beds; n++) t += tile(byBed[n], n, cls);
    const occ = Object.keys(byBed).length;
    return `<section class="bg"><header><h2>${esc(title)}</h2><span><b>${occ}</b>/${beds} <em>${beds - occ} فاضي</em></span></header><div class="bgrid">${t}</div></section>`;
  };
  let html = "";
  visibleUnits().forEach((u) => { const m = {}; (S.adm[u.id] || []).forEach((a) => (m[a.bed] = a)); html += group(u.name, u.beds, m, "icu"); });
  if (canSee("ward")) wardUnits().forEach((u) => { const m = {}; (S.wardActive || []).filter((a) => a.deptId === u.id).forEach((a) => (m[a.bed] = a)); html += group(u.name, u.beds, m, "ward"); });
  root.innerHTML = `<div class="board">
    <header class="board-top"><strong>${esc(S.settings.hospitalName)}</strong><span id="bClock">${fmtDateTime(new Date())}</span>
      <span class="board-acts"><button id="bNames">${names ? "إخفاء الأسماء" : "إظهار الأسماء"}</button><button id="bFull">ملء الشاشة</button><a href="#/">خروج</a></span></header>
    <div class="board-grid">${html || `<div class="empty">مفيش وحدات متاحة.</div>`}</div></div>`;
  document.getElementById("bNames").onclick = () => { S.boardNames = !S.boardNames; renderBoard(); };
  document.getElementById("bFull").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
}
setInterval(() => { const c = document.getElementById("bClock"); if (c) c.textContent = fmtDateTime(new Date()); }, 30e3);

/* =========================================================
   حسابات الأقسام: صفحة لكل قسم فيها حالاته والإشراف المشترك والعروض
   ========================================================= */
const isDept = () => S.profile?.role === "dept";
const respOf = (consultant) => S.settings?.consultantSpecs?.[consultant] || "";
// القسم المسؤول: اللي اتحدد صراحة على الحالة، وإلا قسم الاستشاري
const ownerOf = (a) => a.responsible || respOf(a.consultant);
// الأقسام اللي ليها حق تشوف الحالة: المسؤول + الإشراف المشترك + أقسام اتطلب منها عرض لسه منتظر
const deptAccessOf = (a) => [...new Set([ownerOf(a), ...(a.specialties || []), ...(a.consultSpecs || [])].filter(Boolean))];
// حساب القسم مبيقدرش يقرأ غير عروض قسمه، فالاستعلام لازم يكون مقيد بقسمه
const consultsQ = (admId) => isDept()
  ? query(collection(db, "consults"), where("admissionId", "==", admId), where("specialty", "==", S.profile.deptSpecialty))
  : query(collection(db, "consults"), where("admissionId", "==", admId));
const patFromAdm = (a) => ({ name: a.patientName, medicalId: a.medicalId || "", nationalId: a.nationalId || "", idType: a.nationalId ? "nid" : "unknown",
  birthDate: a.birthDate || "", birthDateEstimated: !!a.birthDateEstimated, gender: a.gender || "", isNewborn: !!a.isNewborn, admissionsCount: a.admissionNo || 1 });

// بعد الرد على العرض (أو إلغائه) صلاحية القسم على الحالة بتنتهي، إلا لو هو المسؤول أو في الإشراف المشترك أو فيه عرض تاني منتظر
async function revokeConsultAccess(c) {
  try {
    const pend = await getDocs(query(collection(db, "consults"), where("admissionId", "==", c.admissionId), where("specialty", "==", c.specialty), where("status", "==", "pending")));
    if (pend.docs.some((d) => d.id !== c.id)) return;
    const ref = doc(db, c.source === "icu" ? "admissions" : "wardAdmissions", c.admissionId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const a = snap.data();
    const consultSpecs = (a.consultSpecs || []).filter((x) => x !== c.specialty);
    await updateDoc(ref, { consultSpecs, deptAccess: deptAccessOf({ ...a, consultSpecs }) });
  } catch (e) { console.error("revoke", e); }
}

// اسم الطبيب: الحساب الشخصي بياخد اسمه، والمشترك بيسأل عن الاسم
function applyDeptDoctor() {
  if (!isDept()) return;
  S.profile.baseName = S.profile.displayName;
  if (!S.profile.shared) { S.profile.doctorName = S.profile.displayName; return; }
  const d = sessionStorage.getItem("deptDoctor_" + S.profile.uid) || "";
  S.profile.doctorName = d;
  S.profile.displayName = d ? `${S.profile.baseName} (${d})` : S.profile.baseName;
  if (!d) setTimeout(askDeptDoctor, 0);
}
function askDeptDoctor() {
  if (!isDept() || !S.profile.shared || dlg.open) return;
  openDialog(`<form class="form" id="ddF"><header class="dlg-head"><h3>مين بيستخدم الحساب؟</h3>
      <p>ده حساب مشترك لقسم ${esc(S.profile.deptSpecialty)}. اكتب اسمك عشان يتسجل مع أي حاجة تكتبها.</p></header>
    <label class="field"><span>اسم الطبيب</span><input name="doc" required autofocus placeholder="د. …" value="${esc(S.profile.doctorName || "")}"></label>
    <div class="err" id="ddErr"></div><div class="actions"><button class="btn">متابعة</button></div></form>`);
  dlg.oncancel = (e) => { if (!S.profile.doctorName) e.preventDefault(); };
  document.getElementById("ddF").onsubmit = (ev) => {
    ev.preventDefault();
    const v = ev.target.elements.doc.value.trim();
    if (v.length < 3) { document.getElementById("ddErr").textContent = "اكتب اسمك."; return; }
    sessionStorage.setItem("deptDoctor_" + S.profile.uid, v);
    S.profile.doctorName = v;
    S.profile.displayName = `${S.profile.baseName} (${v})`;
    dlg.oncancel = null;
    closeDialog(); S._lastHash = null; route();
  };
}
const deptCanOpinion = (a) => isDept() && a.status === "active" && (a.deptAccess || []).includes(S.profile.deptSpecialty);

// لما تختار استشاري في الداخلي، القسم المسؤول بيتملا لوحده لو الاستشاري متحدد له قسم
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!t.matches?.('select[name="consultant"][data-autoresp]')) return;
  const r = respOf(t.value), sel = t.form?.elements?.responsible;
  if (r && sel && !sel.value) sel.value = r;
});

/* ---------- الصفحة الرئيسية للقسم ---------- */
function renderDeptHome(spec) {
  const specs = S.settings.specialties || [];
  if (!spec) spec = isDept() ? S.profile.deptSpecialty : specs[0];
  if (!spec) { shell(`<div class="empty">مفيش تخصصات متسجلة في الإعدادات.</div>`); return; }
  const D = (S.D = { spec, icu: null, ward: null, cons: null });
  shell(`<div class="loading">جاري التحميل…</div>`);
  const draw = () => { if (S.D === D && S.page === "dept") drawDeptHome(); };
  const q = (col) => query(collection(db, col), where("deptAccess", "array-contains", spec));
  S.pageUnsubs.push(onSnapshot(q("admissions"), (s) => { D.icu = s.docs.map((d) => ({ id: d.id, _t: "icu", ...d.data() })).filter((a) => a.status === "active"); loadDx(D); draw(); },
    (e) => { D.icu = []; D.err = errText(e); draw(); }));
  S.pageUnsubs.push(onSnapshot(q("wardAdmissions"), (s) => { D.ward = s.docs.map((d) => ({ id: d.id, _t: "ward", ...d.data() })).filter((a) => a.status === "active"); draw(); },
    () => { D.ward = []; draw(); }));
  S.pageUnsubs.push(onSnapshot(query(collection(db, "consults"), where("specialty", "==", spec)), (s) => { D.cons = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); },
    () => { D.cons = []; draw(); }));
}
async function loadDx(D) {
  D.dx = D.dx || {};
  await Promise.all((D.icu || []).filter((a) => !(a.id in D.dx)).map(async (a) => {
    try {
      const s = await getDocs(collection(db, "admissions", a.id, "entries"));
      D.dx[a.id] = s.docs.map((d) => d.data()).filter((e) => e.kind === "diagnosis").sort(desc)[0]?.text || "";
    } catch { D.dx[a.id] = ""; }
  }));
  if (S.D === D && S.page === "dept") drawDeptHome();
}
function drawDeptHome() {
  const D = S.D, spec = D.spec, specs = S.settings.specialties || [];
  const loading = D.icu === null || D.ward === null || D.cons === null;
  const all = [...(D.icu || []), ...(D.ward || [])];
  const own = all.filter((a) => ownerOf(a) === spec);
  const ownWard = own.filter((a) => a._t === "ward"), ownIcu = own.filter((a) => a._t === "icu");
  const co = all.filter((a) => ownerOf(a) !== spec && (a.specialties || []).includes(spec));
  const pend = (D.cons || []).filter((c) => c.status === "pending");
  const urgent = pend.filter((c) => c.urgency === "عاجل").length;
  const done = (D.cons || []).filter((c) => c.status !== "pending").sort((x, y) => toDate(y.createdAt) - toDate(x.createdAt)).slice(0, 20);
  const longStay = own.filter((a) => stayDays(a) > 7).length;
  const avg = ownWard.length ? Math.round((ownWard.reduce((s, a) => s + stayDays(a), 0) / ownWard.length) * 10) / 10 : 0;
  const row = (a, showOwner) => `<tr>
    <td><a href="${a._t === "icu" ? `#/patient/${a.id}` : `#/w/${a.id}`}"><strong>${esc(a.patientName)}</strong></a><div class="by-line ltr">${esc(a.medicalId || "")}</div></td>
    <td>${a._t === "icu" ? `رعاية: ${esc(unitName(a.unitId))}، ${esc(bedName(a.unitId, a.bed))}` : `${esc(wardById(a.deptId)?.name || "")}، سرير ${a.bed}`}</td>
    <td>${esc(ageText(a.birthDate, a.birthDateEstimated))}</td>
    <td class="${stayDays(a) > 7 ? "wait" : ""}"><strong>${stayDays(a)}</strong> يوم</td><td>${esc(a.consultant || "")}</td>
    ${showOwner ? `<td>${esc(ownerOf(a) || "—")}</td>` : ""}
    <td class="ltr-auto">${esc(((a._t === "icu" ? D.dx?.[a.id] : a.diagnosis) || "").split("\n")[0])}</td>
    <td>${a._t === "icu" && a.clinical?.resp ? `<span class="pill">${RESP_SHORT[a.clinical.resp]}</span>` : ""}</td></tr>`;
  const table = (list, showOwner) => list.length ? `<div class="table-wrap"><table><thead><tr><th>المريض</th><th>المكان</th><th>السن</th><th>الإقامة</th><th>الاستشاري</th>${showOwner ? "<th>القسم المسؤول</th>" : ""}<th>التشخيص</th><th></th></tr></thead>
    <tbody>${[...list].sort((x, y) => toDate(x.admitAt) - toDate(y.admitAt)).map((a) => row(a, showOwner)).join("")}</tbody></table></div>` : `<p class="muted">لا يوجد.</p>`;
  shell(`
  ${isAdmin() ? `<nav class="unit-bar">${specs.map((x) => `<a href="#/dept/${encodeURIComponent(x)}" class="chip ${x === spec ? "on" : ""}">${esc(x)}</a>`).join("")}</nav>` : ""}
  <div class="toolbar"><h2>قسم ${esc(spec)}</h2>${isDept() && S.profile.shared ? `<button class="btn ghost sm" id="chDoc">تغيير اسم الطبيب (${esc(S.profile.doctorName || "")})</button>` : ""}</div>
  ${D.err ? `<div class="err">${esc(D.err)}</div>` : ""}
  ${pend.length ? `<div class="alert-bar ${urgent ? "urgent" : ""}">🩺 عندك <strong>${pend.length}</strong> ${pend.length === 1 ? "عرض منتظر" : "عروض منتظرة"}${urgent ? `، منهم <strong>${urgent}</strong> عاجل` : ""}.</div>` : ""}
  ${loading ? `<div class="loading">جاري التحميل…</div>` : ""}
  <div class="kpis">
    <div class="kpi"><strong>${ownWard.length}</strong><span>حالات القسم في الداخلي</span></div>
    ${ownIcu.length ? `<div class="kpi"><strong>${ownIcu.length}</strong><span>حالات القسم في الرعاية</span></div>` : ""}
    <div class="kpi"><strong>${co.length}</strong><span>إشراف مشترك</span></div>
    <div class="kpi ${urgent ? "hot" : ""}"><strong>${pend.length}</strong><span>عروض منتظرة</span></div>
    <div class="kpi"><strong>${avg}</strong><span>متوسط إقامة الداخلي (يوم)</span></div>
    ${longStay ? `<div class="kpi hot"><strong>${longStay}</strong><span>إقامة أكتر من 7 أيام</span></div>` : ""}
  </div>
  <section class="panel stack-gap" id="dPend"><header><h2>العروض المطلوبة من القسم (${pend.length})</h2></header>${consultListHtml(pend)}</section>
  <section class="panel stack-gap"><header><h2>حالات القسم في الداخلي (${ownWard.length})</h2></header>${table(ownWard, false)}</section>
  ${ownIcu.length ? `<section class="panel stack-gap"><header><h2>حالات القسم في الرعاية المركزة (${ownIcu.length})</h2></header>${table(ownIcu, false)}</section>` : ""}
  <section class="panel stack-gap"><header><h2>حالات الإشراف المشترك (${co.length})</h2></header>${table(co, true)}</section>
  <section class="panel stack-gap" id="dDone"><header><h2>آخر العروض المردود عليها</h2></header>${consultListHtml(done)}</section>`);
  bindConsultActions(document.getElementById("dPend"), D.cons || []);
  document.getElementById("chDoc")?.addEventListener("click", () => { sessionStorage.removeItem("deptDoctor_" + S.profile.uid); S.profile.doctorName = ""; askDeptDoctor(); });
}

/* ---------- آراء الإشراف المشترك في الداخلي ---------- */
function wardOpinionsHtml(list, canAdd) {
  return `<section class="panel stack-gap" id="wOps"><header><h2>آراء الإشراف المشترك</h2>${canAdd ? `<button class="btn ghost sm" data-w="opAdd">إضافة رأي</button>` : ""}</header>
    ${list.length ? `<ul class="entries">${[...list].sort(desc).map((e) => `<li><div class="entry-head"><span class="pill">${esc(e.specialty)}</span>
      ${e.doctor ? `<strong>${esc(e.doctor)}</strong>` : ""}<span class="by-line">${fmtDateTime(e.at)}</span></div><p class="pre-wrap ltr-auto">${esc(e.opinion)}</p></li>`).join("")}</ul>`
      : `<p class="muted">لا يوجد آراء مسجلة.</p>`}</section>`;
}
function openWardOpinion(a) {
  const fixed = isDept() ? S.profile.deptSpecialty : "";
  const specs = [...new Set([...(a.specialties || []), ...(S.settings.specialties || [])])];
  formDialog("رأي الإشراف المشترك", `
    <div class="row2">
      <label class="field"><span>التخصص</span>${fixed ? `<input value="${esc(fixed)}" disabled>` : `<select name="specialty">${optionsHtml(specs, "")}</select>`}</label>
      <label class="field"><span>اسم الطبيب</span><input name="doctor" value="${esc(S.profile.doctorName || S.profile.displayName)}"></label>
    </div>
    <label class="field"><span>الرأي والتوصيات</span><textarea name="opinion" rows="5" class="ltr-auto"></textarea></label>`,
    "حفظ الرأي", async (f) => {
      const specialty = fixed || f.elements.specialty.value, opinion = f.elements.opinion.value.trim();
      if (!specialty) return "اختر التخصص.";
      if (!opinion) return "اكتب الرأي.";
      await addDoc(collection(db, "wardAdmissions", a.id, "opinions"), { specialty, doctor: f.elements.doctor.value.trim(), opinion, at: Timestamp.now(), ...meta() });
      toast("تم حفظ الرأي");
    });
}

/* ---------- الإعدادات: الاستشاريين والأقسام ---------- */
function tabDeptMap(body) {
  const map = { ...(S.settings.consultantSpecs || {}) };
  const specs = S.settings.specialties || [];
  body.innerHTML = `
  <div class="toolbar"><h2>الاستشاريين والأقسام</h2></div>
  <p class="muted">حالات الداخلي ليها خانة <strong>القسم المسؤول</strong> بتتختار عند الدخول. هنا بتحدد قسم كل استشاري عشان الخانة دي تتملا لوحدها، وعشان حالات الرعاية (اللي ملهاش القسم المسؤول) تتنسب لقسم الاستشاري.</p>
  <div class="table-wrap"><table class="units-edit"><thead><tr><th>الاستشاري</th><th>القسم</th></tr></thead>
    <tbody>${(S.settings.consultants || []).map((c, i) => `<tr><td>${esc(c)}</td><td><select data-c="${i}">${optionsHtml(specs, map[c] || "", "بدون قسم")}</select></td></tr>`).join("")
      || `<tr><td colspan="2" class="muted">ضيف الاستشاريين الأول من الإعدادات > القوائم.</td></tr>`}</tbody></table></div>
  <div class="err" id="dmErr" style="margin-top:10px"></div>
  <div class="actions" style="margin-top:12px"><button class="btn" id="dmSave">حفظ وتحديث الحالات الحالية</button></div>
  <div class="note" style="margin-top:16px">عشان تعمل <strong>مستخدم لقسم</strong> (زي د. محمد حسن، قسم العظام): من المستخدمين أضف مستخدم، واختار نوع الحساب "حساب قسم"، وحدد القسم. لو هيستخدمه أكتر من طبيب علّم "حساب مشترك".</div>`;
  document.getElementById("dmSave").onclick = async (ev) => {
    const btn = ev.currentTarget; btn.disabled = true;
    const newMap = {};
    body.querySelectorAll("[data-c]").forEach((sel) => { const c = S.settings.consultants[+sel.dataset.c]; if (sel.value) newMap[c] = sel.value; });
    try {
      await updateDoc(doc(db, "config", "settings"), { consultantSpecs: newMap });
      S.settings.consultantSpecs = newMap;
      const n = await backfillDeptAccess();
      toast(`تم الحفظ، واتحدّثت ${n} حالة موجودة`);
    } catch (e) { document.getElementById("dmErr").textContent = errText(e); }
    btn.disabled = false;
  };
}
// تحديث صلاحيات الأقسام على الحالات الموجودة (أدمن): القسم المسؤول + الإشراف المشترك + العروض المنتظرة بس
async function backfillDeptAccess() {
  const [icu, ward, cons] = await Promise.all([
    getDocs(query(collection(db, "admissions"), where("status", "==", "active"))),
    getDocs(query(collection(db, "wardAdmissions"), where("status", "==", "active"))),
    getDocs(query(collection(db, "consults"), where("status", "==", "pending"))),
  ]);
  const pend = {};
  cons.docs.forEach((d) => { const c = d.data(); (pend[c.admissionId] ||= new Set()).add(c.specialty); });
  const norm = (arr) => JSON.stringify([...(arr || [])].sort());
  const todo = [];
  for (const d of [...icu.docs, ...ward.docs]) {
    const x = d.data(), consultSpecs = [...(pend[d.id] || [])];
    const acc = deptAccessOf({ ...x, consultSpecs });
    if (norm(acc) !== norm(x.deptAccess) || norm(consultSpecs) !== norm(x.consultSpecs)) todo.push([d.ref, { deptAccess: acc, consultSpecs }]);
  }
  for (let i = 0; i < todo.length; i += 400) {
    const b = writeBatch(db);
    todo.slice(i, i + 400).forEach(([ref, data]) => b.update(ref, data));
    await b.commit();
  }
  return todo.length;
}
