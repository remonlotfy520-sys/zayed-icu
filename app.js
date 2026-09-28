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

const DEFAULT_FINANCE = ["نفقة", "تأمين", "مجاني", "اقتصادي"];
const listOf = (key) => S.settings?.[key] ?? (key === "financeTypes" ? DEFAULT_FINANCE : []);

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
    PATIENT_ADMITTED: "المريض ده مسجل دخول حالياً في الرعاية، ولازم يخرج الأول.",
  };
  for (const k in map) if (code.includes(k)) return map[k];
  console.error(e);
  return "حصل خطأ غير متوقع: " + (e?.message || code);
}

const isAdmin = () => S.profile?.role === "admin";
const units = () => S.settings?.units || [];
const unitById = (id) => units().find((u) => u.id === id);
function visibleUnits() {
  if (isAdmin()) return units();
  const mine = S.profile?.units || [];
  return units().filter((u) => mine.includes(u.id));
}
const canWriteUnit = (unitId) =>
  isAdmin() || (S.profile?.access === "write" && (S.profile?.units || []).includes(unitId));

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
  if (!user) { route(); return; }
  route();
  profileUnsub = onSnapshot(doc(db, "users", user.uid), async (snap) => {
    if (!snap.exists() || snap.data().active !== true) {
      S.loginMsg = "الحساب ده غير مفعّل. كلّم الأدمن.";
      await signOut(auth);
      return;
    }
    S.profile = { uid: user.uid, ...snap.data() };
    subscribeAdmissions();
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
      if (S.page === "dashboard") renderDashboard();
    }, (e) => console.error("admissions", u.id, e)));
  }
}

// تحديث عداد الأيام كل 5 دقائق
setInterval(() => { if (S.page === "dashboard") renderDashboard(); }, 5 * 60e3);

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
  const newKey = location.hash;
  // لو نفس الصفحة ومفيش غير تحديث بيانات، متعيدش فتح المستمعين
  if (S._lastHash === newKey && S.page && S.page !== "login" && S.page !== "setup") {
    if (S.page === "dashboard") renderDashboard();
    return;
  }
  S._lastHash = newKey;
  cleanupPage();

  if (page === "" || page === "unit") {
    S.page = "dashboard";
    S.unitFilter = page === "unit" ? parts[1] : null;
    renderDashboard();
  } else if (page === "patient" && parts[1]) {
    S.page = "patient";
    renderPatient(parts[1]);
  } else if (page === "archive" && isAdmin()) {
    S.page = "archive";
    renderArchive();
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
      <span><strong>${esc(s.hospitalName)}</strong><small>الرعاية المركزة</small></span>
    </a>
    <nav class="nav">
      <a href="#/" class="${S.page === "dashboard" ? "on" : ""}">الأسرّة</a>
      ${isAdmin() ? `<a href="#/archive" class="${S.page === "archive" ? "on" : ""}">الأرشيف</a>
      <a href="#/settings" class="${S.page === "settings" ? "on" : ""}">الإعدادات</a>` : ""}
    </nav>
    <div class="me">
      <span>${esc(p.displayName)}</span>
      <button class="btn ghost sm" data-act="pw">كلمة المرور</button>
      <button class="btn ghost sm" data-act="logout">خروج</button>
    </div>
  </header>
  <main class="page">${inner}</main>`;
  root.querySelector('[data-act="logout"]').onclick = () => { S._lastHash = null; signOut(auth); };
  root.querySelector('[data-act="pw"]').onclick = openPasswordDialog;
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
  if (sel && !shown.length) { location.hash = "#/"; return; }

  const stat = (u) => {
    const occ = (S.adm[u.id] || []).length;
    return { occ, free: Math.max(0, u.beds - occ), total: u.beds };
  };
  let tOcc = 0, tBeds = 0;
  list.forEach((u) => { const s = stat(u); tOcc += s.occ; tBeds += s.total; });

  const chips = `
    <nav class="unit-bar" aria-label="الوحدات">
      <a href="#/" class="chip ${!sel ? "on" : ""}">كل الوحدات <b>${tOcc}/${tBeds}</b></a>
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
function openAdmissionDialog(unit, bed) {
  const s = S.settings;
  const earliest = earliestEditable();
  const now = new Date();
  const mode0 = unit.newborn ? "newborn" : "nid";
  openDialog(`
  <form class="form" id="admForm" data-mode="${mode0}" novalidate>
    <header class="dlg-head"><h3>دخول حالة</h3><p>${esc(unit.name)}، ${esc(unit.bedLabel)} ${bed}</p></header>

    <fieldset class="seg">
      <label><input type="radio" name="mode" value="nid" ${mode0 === "nid" ? "checked" : ""}> رقم قومي</label>
      <label><input type="radio" name="mode" value="newborn" ${mode0 === "newborn" ? "checked" : ""}> مولود (بيانات الأم)</label>
      <label><input type="radio" name="mode" value="unknown"> بدون رقم قومي</label>
    </fieldset>

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
      <label class="field"><span>العنوان</span><input name="address"></label>
      <label class="field"><span>رقم التليفون</span><input name="phone" inputmode="tel" class="ltr"></label>
    </div>
    <div class="note" id="patientNote"></div>

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
        : `المريض ده دخل الرعاية قبل كده ${p.admissionsCount || 0} مرة. البيانات اتملت من ملفه.`;
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
    if (mode === "nid") {
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
    const uid = S.profile.uid;
    try {
      await runTransaction(db, async (tx) => {
        const bSnap = await tx.get(bedRef);
        if (bSnap.exists()) throw new Error("BED_TAKEN");
        const pSnap = await tx.get(patientRef);
        if (pSnap.exists() && pSnap.data().currentAdmissionId) throw new Error("PATIENT_ADMITTED");
        const count = (pSnap.exists() ? pSnap.data().admissionsCount || 0 : 0) + 1;
        const pData = { ...patient, admissionsCount: count, currentAdmissionId: admRef.id,
          updatedAt: serverTimestamp(), updatedBy: uid };
        if (!pSnap.exists()) { pData.createdAt = serverTimestamp(); pData.createdBy = uid; }
        tx.set(patientRef, pData, { merge: true });
        tx.set(bedRef, { unitId: unit.id, bed, admissionId: admRef.id, since: serverTimestamp() });
        tx.set(admRef, {
          patientId: patientRef.id, patientName: patient.name, gender: patient.gender,
          birthDate: patient.birthDate, birthDateEstimated: patient.birthDateEstimated,
          isNewborn: patient.isNewborn, nationalId: patient.nationalId || "",
          unitId: unit.id, bed, admitAt: Timestamp.fromDate(admitAt),
          consultant: f.consultant.value, specialties: checkedValues(f, "spec"), finance: f.finance.value,
          admissionNo: count, status: "active",
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
const INV_TYPES = { lab: "تحليل", radiology: "أشعة", other: "أخرى" };
const ROUTES = ["IV", "IM", "SC", "Oral", "NG tube", "Inhalation", "Topical", "Rectal", "Other"];
const FREQS = ["Once daily", "BID (q12h)", "TID (q8h)", "QID (q6h)", "q4h", "PRN", "STAT", "Continuous infusion"];
const PTABS = [
  ["info", "البيانات"],
  ["history", "التاريخ والتشخيص"],
  ["consult", "الإشراف المشترك"],
  ["inv", "الأشعة والتحاليل"],
  ["vitals", "العلامات الحيوية"],
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
    if (!P.subs) {
      P.subs = true;
      S.pageUnsubs.push(onSnapshot(doc(db, "patients", P.adm.patientId), (ps) => { P.pat = ps.data() || {}; draw(); }));
      for (const k of ["entries", "vitals", "meds"]) {
        S.pageUnsubs.push(onSnapshot(collection(db, "admissions", aid, k), (s) => {
          P[k] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
          draw();
        }, (e) => console.error(k, e)));
      }
    }
    draw();
  }, () => {
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

  const body = { info: ptInfo, history: ptHistory, consult: ptConsult, inv: ptInv, vitals: ptVitals, meds: ptMeds }[P.tab]();

  shell(`
  <div class="file-head">
    <a class="back" href="#/unit/${a.unitId}">${esc(unit.name)}</a>
    <h1>${esc(p.name || a.patientName)}</h1>
    <div class="tags">
      <span class="tag">${esc(unit.bedLabel)} ${a.bed}</span>
      ${active ? `<span class="tag day">اليوم ${stayDays(a)} للإقامة</span>` : `<span class="tag archived">في الأرشيف: ${DIS_TYPES[a.dischargeType] || "خرج"}</span>`}
      ${a.consultant ? `<span class="tag">${esc(a.consultant)}</span>` : ""}
    </div>
    ${active && canWriteUnit(a.unitId) ? `<div class="file-actions">
      <button class="btn ghost" data-act="transfer">نقل</button>
      <button class="btn danger" data-act="discharge">خروج</button></div>` : ""}
  </div>
  <nav class="ptabs" role="tablist">${PTABS.map(([k, t]) =>
    `<button role="tab" aria-selected="${P.tab === k}" data-act="tab" data-tab="${k}" class="${P.tab === k ? "on" : ""}">${t}${badge[k] ? `<b>${badge[k]}</b>` : ""}</button>`).join("")}</nav>
  <div class="ptab-body">${body}</div>
  <datalist id="dlDrugs">${(S.settings.drugs || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
  <datalist id="dlFreq">${FREQS.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`);

  root.querySelector("main").onclick = onPatientClick;
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
    case "dxEdit": openDx(ent()); break;
    case "cAdd": openConsult(); break;
    case "cEdit": openConsult(ent()); break;
    case "invAdd": openInv(); break;
    case "invEdit": openInvEdit(ent()); break;
    case "invResult": openInvResult(ent()); break;
    case "vAdd": openVitals(); break;
    case "vEdit": openVitals(P.vitals.find((x) => x.id === id)); break;
    case "mAdd": openMed(); break;
    case "mChange": openMedChange(med()); break;
    case "mStop": openMedStop(med()); break;
    case "mResume": resumeMed(med()); break;
    case "mDel": deleteMed(med()); break;
    case "transfer": openTransfer(); break;
    case "discharge": openDischarge(); break;
    case "prevAdm": loadPrevAdmissions(); break;
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
  const visits = p.admissionsCount || 1;
  const specs = (a.specialties || []).map((x) => `<span class="pill">${esc(x)}</span>`).join("") || `<span class="muted">لا يوجد</span>`;
  return `
  <div class="file-grid">
    <section class="panel">
      <header><h2>البيانات الأساسية</h2>${canW ? `<button class="btn ghost sm" data-act="editBasic">تعديل</button>` : ""}</header>
      <dl class="kv">
        <dt>الاسم</dt><dd>${esc(p.name)}</dd>
        ${idRows}
        <dt>السن</dt><dd>${esc(age) || "—"}</dd>
        <dt>النوع</dt><dd>${genderText(p.gender) || "—"}</dd>
        <dt>العنوان</dt><dd>${esc(p.address) || "—"}</dd>
        <dt>التليفون</dt><dd class="ltr">${esc(p.phone) || "—"}</dd>
      </dl>
      <div class="visits ${visits > 1 ? "repeat" : ""}">
        <span class="visits-icon" aria-hidden="true">${visits}</span>
        <span>${visits > 1 ? `دخل الرعاية ${visits} مرات، وده الدخول رقم ${a.admissionNo || visits}` : "أول دخول للرعاية"}</span>
      </div>
    </section>
    <section class="panel">
      <header><h2>بيانات الدخول</h2>${canW ? `<button class="btn ghost sm" data-act="editAdm">تعديل</button>` : ""}</header>
      <dl class="kv">
        <dt>تاريخ الدخول</dt><dd>${fmtDateTime(a.admitAt)}</dd>
        <dt>أيام الإقامة</dt><dd>${stayDays(a)} يوم</dd>
        <dt>الوحدة</dt><dd>${esc(unit.name)}، ${esc(unit.bedLabel)} ${a.bed}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(a.consultant) || "—"}</dd>
        <dt>المعاملة المالية</dt><dd>${esc(a.finance) || "—"}</dd>
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

  return `
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

function openHistory() {
  const cur = S.P.entries.filter((e) => e.kind === "history").sort(desc)[0];
  formDialog("التاريخ المرضي",
    HISTORY_FIELDS.map(([k, l]) => `<label class="field"><span>${l}</span><textarea name="${k}" rows="${k === "hpi" ? 4 : 2}">${esc(cur?.[k] || "")}</textarea></label>`).join("")
    + (cur ? `<p class="hint">الحفظ بيعمل نسخة جديدة، والنسخة الحالية بتفضل محفوظة في السجل.</p>` : ""),
    "حفظ التاريخ المرضي",
    async (f) => {
      const data = {};
      HISTORY_FIELDS.forEach(([k]) => (data[k] = f.elements[k].value.trim()));
      if (!Object.values(data).some(Boolean)) return "اكتب بيانات في خانة واحدة على الأقل.";
      await addDoc(subRef("entries"), { kind: "history", ...data, at: Timestamp.now(), ...meta() });
      toast("تم حفظ التاريخ المرضي");
    });
}

function openDx(e) {
  const t = e?.dxType || "initial";
  formDialog(e ? "تعديل التشخيص" : "إضافة تشخيص", `
    <fieldset class="seg">${Object.entries(DX_TYPES).map(([k, l]) =>
      `<label><input type="radio" name="dxType" value="${k}" ${k === t ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    <label class="field"><span>التشخيص</span><textarea name="text" rows="3" class="ltr-auto">${esc(e?.text || "")}</textarea></label>
    ${timeInput("at", "الوقت", e?.at || new Date())}`,
    e ? "حفظ التعديل" : "إضافة التشخيص",
    async (f) => {
      const text = f.elements.text.value.trim();
      if (!text) return "اكتب التشخيص.";
      const [at, er] = readTime(f.elements.at); if (er) return er;
      const data = { kind: "diagnosis", dxType: f.querySelector('input[name="dxType"]:checked').value, text, at: Timestamp.fromDate(at) };
      if (e) await pUpd(subRef("entries", e.id), { ...data, ...upMeta() });
      else await addDoc(subRef("entries"), { ...data, ...meta() });
      toast(e ? "تم حفظ التعديل" : "تمت إضافة التشخيص");
    },
    e ? () => pDel(subRef("entries", e.id)) : null);
}

/* ---------- الإشراف المشترك ---------- */
function ptConsult() {
  const list = S.P.entries.filter((e) => e.kind === "consult").sort(desc);
  return `
  <section class="panel">
    <header><h2>الإشراف المشترك ورأي التخصصات</h2>${pCanAdd() ? `<button class="btn ghost sm" data-act="cAdd">إضافة رأي</button>` : ""}</header>
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
  const specs = [...new Set([...(S.P.adm.specialties || []), ...(S.settings.specialties || [])])];
  formDialog(e ? "تعديل الرأي" : "إضافة رأي تخصص", `
    <div class="row2">
      <label class="field"><span>التخصص</span><select name="specialty">${optionsHtml(specs, e?.specialty || "")}</select></label>
      <label class="field"><span>اسم الطبيب</span><input name="doctor" value="${esc(e?.doctor || "")}"></label>
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
  const head = `<div class="toolbar"><h2>العلامات الحيوية وتطور الحالة</h2>${pCanAdd() ? `<button class="btn" data-act="vAdd">إضافة قراءة</button>` : ""}</div>`;
  if (!rs.length) return head + `<div class="empty">لا يوجد قراءات مسجلة. كل قراءة بتظهر كعمود بتاريخها ووقتها.</div>`;

  const groups = [];
  rs.forEach((r) => {
    const d = isoDay(toDate(r.at));
    if (groups.length && groups[groups.length - 1].day === d) groups[groups.length - 1].n++;
    else groups.push({ day: d, n: 1 });
  });
  const colHead = (r) => pCanEdit(r.at)
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
    <div class="row2">
      <label class="field"><span>استشاري الحالة</span><select name="consultant">${optionsHtml(s.consultants || [], a.consultant)}</select></label>
      <label class="field"><span>المعاملة المالية</span><select name="finance">${optionsHtml(listOf("financeTypes"), a.finance || "")}</select></label>
    </div>
    <div class="field"><span>التخصصات المشتركة</span>${checksHtml("spec", [...new Set([...(s.specialties || []), ...(a.specialties || [])])], a.specialties || [])}</div>
    <div class="err" id="aeErr"></div>
    <div class="actions"><button class="btn">حفظ التعديل</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("admEdit");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("aeErr");
    if (!f.consultant.value) { err.textContent = "اختر استشاري الحالة."; return; }
    if (!f.finance.value) { err.textContent = "اختر المعاملة المالية."; return; }
    const upd = { consultant: f.consultant.value, finance: f.finance.value, specialties: checkedValues(f, "spec"),
      updatedAt: serverTimestamp(), updatedBy: S.profile.uid };
    if (admin) {
      const d = new Date(f.admitAt.value);
      if (isNaN(d) || d > new Date()) { err.textContent = "تاريخ الدخول غير صحيح."; return; }
      upd.admitAt = Timestamp.fromDate(d);
    }
    try {
      await updateDoc(doc(db, "admissions", a.id), upd);
      audit("تعديل بيانات الدخول", { adm: a, before: { consultant: a.consultant || "", finance: a.finance || "",
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
  const tabs = [["users", "المستخدمين"], ["units", "الوحدات والأسرّة"], ["vitals", "خانات العلامات الحيوية"], ["lists", "القوائم"], ["hospital", "بيانات المستشفى"], ["audit", "سجل التعديلات"]];
  const nav = `<nav class="tabs">${tabs.map(([k, t]) => `<a href="#/settings/${k}" class="${tab === k ? "on" : ""}">${t}</a>`).join("")}</nav>`;
  shell(nav + `<div id="tabBody"><div class="loading">جاري التحميل…</div></div>`);
  const body = document.getElementById("tabBody");
  ({ users: tabUsers, units: tabUnits, vitals: tabVitalFields, lists: tabLists, hospital: tabHospital, audit: tabAudit }[tab] || tabUsers)(body);
}

/* ---------- المستخدمين ---------- */
async function tabUsers(body) {
  let list = [];
  try {
    const snap = await getDocs(collection(db, "users"));
    list = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "ar"));
  } catch (e) { body.innerHTML = `<div class="err">${esc(errText(e))}</div>`; return; }
  const unitNames = (ids) => (ids || []).map((id) => unitById(id)?.name).filter(Boolean).join("، ") || `<span class="muted">لا يوجد</span>`;
  body.innerHTML = `
  <div class="toolbar"><h2>المستخدمين (${list.length})</h2><button class="btn" id="addUser">إضافة مستخدم</button></div>
  <div class="table-wrap"><table>
    <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>النوع</th><th>الصلاحية</th><th>الوحدات</th><th>فترة التعديل</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${list.map((u) => `<tr>
      <td>${esc(u.displayName)}</td>
      <td class="ltr">${esc(u.username)}</td>
      <td>${u.role === "admin" ? "أدمن" : "طبيب"}</td>
      <td>${u.role === "admin" ? "كاملة" : u.access === "write" ? "عرض وكتابة" : "عرض فقط"}</td>
      <td>${u.role === "admin" ? "كل الوحدات" : unitNames(u.units)}</td>
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
  u = u || { role: "doctor", access: "write", units: [], editWindowHours: 12, active: true };
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
        <select name="role" ${self ? "disabled" : ""}><option value="doctor" ${u.role !== "admin" ? "selected" : ""}>طبيب</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>أدمن</option></select></label>
      <label class="field"><span>فترة التعديل</span>
        <select name="editWindowHours"><option value="12" ${u.editWindowHours !== 24 ? "selected" : ""}>12 ساعة (الشيفت الحالي)</option><option value="24" ${u.editWindowHours === 24 ? "selected" : ""}>24 ساعة (الشيفت الحالي واللي قبله)</option></select></label>
    </div>
    <div class="field doc-only"><span>الصلاحية</span>
      <fieldset class="seg">
        <label><input type="radio" name="access" value="write" ${u.access !== "read" ? "checked" : ""}> عرض وكتابة</label>
        <label><input type="radio" name="access" value="read" ${u.access === "read" ? "checked" : ""}> عرض فقط</label>
      </fieldset></div>
    <div class="field doc-only"><span>الوحدات المسموح بيها</span>
      <div class="checks">${units().map((x) => `<label><input type="checkbox" name="units" value="${x.id}" ${(u.units || []).includes(x.id) ? "checked" : ""}> ${esc(x.name)}</label>`).join("")}</div></div>
    ${isNew ? "" : `<div class="checks"><label><input type="checkbox" name="active" ${u.active ? "checked" : ""} ${self ? "disabled" : ""}> الحساب مفعّل</label></div>`}
    <div class="err" id="userErr"></div>
    <div class="actions"><button class="btn">${isNew ? "إضافة المستخدم" : "حفظ التعديل"}</button><button type="button" class="btn ghost" data-close>إلغاء</button></div>
  </form>`);
  const f = document.getElementById("userForm");
  const syncRole = () => f.querySelectorAll(".doc-only").forEach((el) => el.classList.toggle("hidden", f.role.value === "admin"));
  f.role.onchange = syncRole; syncRole();

  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("userErr");
    err.textContent = "";
    const role = self ? "admin" : f.role.value;
    const data = {
      displayName: f.displayName.value.trim(),
      role,
      access: role === "admin" ? "write" : f.querySelector('input[name="access"]:checked').value,
      units: role === "admin" ? [] : checkedValues(f, "units"),
      editWindowHours: Number(f.editWindowHours.value),
    };
    if (!data.displayName) { err.textContent = "اكتب اسم المستخدم الظاهر."; return; }
    if (role !== "admin" && !data.units.length) { err.textContent = "اختر وحدة واحدة على الأقل."; return; }
    const btn = f.querySelector("button.btn"); btn.disabled = true;
    try {
      if (isNew) {
        const username = f.username.value.trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw { message: "اسم المستخدم لازم يكون حروف إنجليزي وأرقام فقط (3 حروف على الأقل)." };
        if (f.password.value.length < 6) throw { code: "auth/weak-password" };
        const sa = secondaryAuth();
        const cred = await createUserWithEmailAndPassword(sa, `${username}@${USER_EMAIL_DOMAIN}`, f.password.value);
        await setDoc(doc(db, "users", cred.user.uid), { ...data, username, active: true,
          createdAt: serverTimestamp(), createdBy: S.profile.uid });
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
  body.innerHTML = block("financeTypes", "المعاملة المالية", "مثال: تعاقد شركة")
    + block("consultants", "الاستشاريين", "مثال: د. أحمد محمود")
    + block("specialties", "التخصصات المشتركة", "مثال: باطنة")
    + block("investigations", "التحاليل والأشعة الشائعة", "مثال: CBC")
    + block("drugs", "الأدوية الشائعة", "مثال: Ceftriaxone");
  const save = async (key, arr) => {
    try { await updateDoc(doc(db, "config", "settings"), { [key]: arr }); tabLists(body); }
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
const DIS_TYPES = { improved: "تحسن", death: "وفاة", ward: "تحويل للداخلي", transfer: "تحويل لمستشفى أخرى" };
const stayEnd = (a) => (a.status === "discharged" && a.dischargeAt ? toDate(a.dischargeAt) : new Date());
function stayDays(a) {
  const s = toDate(a.admitAt), e = stayEnd(a);
  if (!s) return 0;
  const s0 = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const e0 = new Date(e.getFullYear(), e.getMonth(), e.getDate());
  return Math.round((e0 - s0) / 86400000) + 1;
}
const unitName = (id) => unitById(id)?.name || id;
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
const KIND_LABEL = { history: "التاريخ المرضي", diagnosis: "تشخيص", consult: "رأي تخصص", investigation: "طلب أشعة/تحاليل" };
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
      <header><h2>بيانات الخروج</h2></header>
      <dl class="kv">
        <dt>نوع الخروج</dt><dd><strong>${DIS_TYPES[a.dischargeType] || ""}</strong></dd>
        <dt>${a.dischargeType === "death" ? "وقت الوفاة" : "وقت الخروج"}</dt><dd>${fmtDateTime(a.dischargeAt)}</dd>
        <dt>أيام الإقامة</dt><dd>${stayDays(a)} يوم</dd>
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
  if (isAdmin() && (P.pat.admissionsCount || 1) > 1) {
    const list = P.prev;
    html += `
    <section class="panel">
      <header><h2>الدخولات السابقة</h2>${list ? "" : `<button class="btn ghost sm" data-act="prevAdm">عرض</button>`}</header>
      ${list ? (list.length ? `<ul class="entries">${list.map((x) => `
        <li><div class="entry-head"><a href="#/patient/${x.id}"><strong>${fmtDate(x.admitAt)}</strong></a>
          <span>${esc(unitName(x.unitId))}</span>
          <span class="pill">${x.status === "active" ? "حالياً" : DIS_TYPES[x.dischargeType] || ""}</span>
          <span class="by-line">${stayDays(x)} يوم</span></div></li>`).join("")}</ul>` : `<p class="muted">لا يوجد.</p>`) : ""}
    </section>`;
  }
  return html ? `<div class="stack">${html}</div>` : "";
}

async function loadPrevAdmissions() {
  const P = S.P;
  try {
    const snap = await getDocs(query(collection(db, "admissions"), where("patientId", "==", P.adm.patientId)));
    P.prev = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.id !== P.adm.id)
      .sort((x, y) => toDate(y.admitAt) - toDate(x.admitAt));
    drawPatient();
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
    <label class="field df d-ward"><span>القسم الداخلي المحول إليه</span><input name="ward"></label>
    <label class="field df d-transfer"><span>اسم المستشفى</span><input name="hospital"></label>
    <label class="field df d-transfer"><span>سبب التحويل</span><textarea name="reason" rows="2"></textarea></label>
    <label class="field"><span>ملاحظات (اختياري)</span><textarea name="notes" rows="2"></textarea></label>
    <p class="note">بعد الخروج الملف بيتنقل للأرشيف والسرير بيفضى، والملف مش هيظهر غير للأدمن.</p>`,
    "تأكيد الخروج",
    async (f) => {
      const type = f.querySelector('input[name="dtype"]:checked').value;
      const [at, er] = readTime(f.elements.at); if (er) return er;
      if (at < toDate(a.admitAt)) return "وقت الخروج لازم يكون بعد وقت الدخول.";
      const info = { notes: f.elements.notes.value.trim() };
      if (type === "death") { info.deathCause = f.elements.deathCause.value.trim(); if (!info.deathCause) return "اكتب سبب الوفاة."; }
      if (type === "ward") { info.ward = f.elements.ward.value.trim(); if (!info.ward) return "اكتب القسم الداخلي."; }
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
        tx.update(aRef, {
          status: "discharged", dischargeAt: Timestamp.fromDate(at), dischargeType: type, dischargeInfo: info,
          dischargedBy: S.profile.uid, dischargedByName: S.profile.displayName, ...upMeta(),
        });
        if (bSnap.exists() && bSnap.data().admissionId === a.id) tx.delete(bedRef);
        if (pSnap.exists() && pSnap.data().currentAdmissionId === a.id)
          tx.update(pRef, { currentAdmissionId: null, lastDischargeAt: Timestamp.fromDate(at) });
      });
      audit(`خروج: ${DIS_TYPES[type]}`, { adm: a, details: info });
      toast(`تم تسجيل الخروج (${DIS_TYPES[type]})`);
      if (!isAdmin()) setTimeout(() => (location.hash = `#/unit/${a.unitId}`), 0);
    });
  const sync = () => (f.dataset.dtype = f.querySelector('input[name="dtype"]:checked').value);
  f.querySelectorAll('input[name="dtype"]').forEach((r) => (r.onchange = sync));
  sync();
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
  shell(`
  <div class="toolbar"><h2>الأرشيف</h2></div>
  <form class="filters" id="arcF">
    <label class="field"><span>خروج من</span><input type="date" name="from" value="${A.from}"></label>
    <label class="field"><span>إلى</span><input type="date" name="to" value="${A.to}"></label>
    <label class="field"><span>الوحدة</span><select name="unit"><option value="">كل الوحدات</option>${units().map((u) =>
      `<option value="${u.id}" ${A.unit === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>
    <label class="field"><span>نوع الخروج</span><select name="type"><option value="">الكل</option>${Object.entries(DIS_TYPES).map(([k, l]) =>
      `<option value="${k}" ${A.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field grow"><span>بحث بالاسم أو الرقم القومي</span><input name="q" value="${esc(A.q)}" placeholder="الرقم القومي بيدور في كل السنين"></label>
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
    if (/^\d{14}$/.test(A.q)) {
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
      <thead><tr><th>الاسم</th><th>الرقم القومي</th><th>الوحدة</th><th>الدخول</th><th>الخروج</th><th>الإقامة</th><th>نوع الخروج</th><th>المعاملة المالية</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><a href="#/patient/${r.id}"><strong>${esc(r.patientName)}</strong></a></td>
        <td class="ltr">${esc(r.nationalId) || `<span class="muted">—</span>`}</td>
        <td>${esc(unitName(r.unitId))}</td>
        <td>${fmtDate(r.admitAt)}</td>
        <td>${fmtDateTime(r.dischargeAt)}</td>
        <td>${stayDays(r)} يوم</td>
        <td><span class="dis t-${r.dischargeType}">${DIS_TYPES[r.dischargeType] || ""}</span></td>
        <td>${esc(r.finance) || "—"}</td></tr>`).join("")}</tbody>
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
