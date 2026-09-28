// نظام الرعاية المركزة: المرحلة 1
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp
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
      ${isAdmin() ? `<a href="#/settings" class="${S.page === "settings" ? "on" : ""}">الإعدادات</a>` : ""}
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
    <label class="field"><span>استشاري الحالة</span><select name="consultant">${optionsHtml(s.consultants || [], "")}</select></label>
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
          consultant: f.consultant.value, specialties: checkedValues(f, "spec"),
          admissionNo: count, status: "active",
          createdBy: uid, createdByName: S.profile.displayName, createdAt: serverTimestamp(),
        });
      });
      closeDialog();
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
function renderPatient(aid) {
  shell(`<div class="loading">جاري تحميل ملف المريض…</div>`);
  let adm = null, pat = null, patUnsub = null;
  const draw = () => { if (adm && pat) drawPatient(adm, pat); };
  S.pageUnsubs.push(onSnapshot(doc(db, "admissions", aid), (snap) => {
    if (!snap.exists()) { shell(`<div class="empty">الملف غير موجود. <a href="#/">ارجع للأسرّة</a></div>`); return; }
    adm = { id: snap.id, ...snap.data() };
    if (!patUnsub) {
      patUnsub = onSnapshot(doc(db, "patients", adm.patientId), (ps) => { pat = ps.data() || {}; draw(); });
      S.pageUnsubs.push(patUnsub);
    }
    draw();
  }, () => {
    shell(`<div class="empty">ليس لديك صلاحية لعرض هذا الملف. الحالات اللي خرجت بتظهر للأدمن فقط. <a href="#/">ارجع للأسرّة</a></div>`);
  }));
}

function drawPatient(a, p) {
  if (S.page !== "patient") return;
  const unit = unitById(a.unitId) || { name: a.unitId, bedLabel: "سرير" };
  const active = a.status === "active";
  const canW = active && canWriteUnit(a.unitId);
  const age = ageText(p.birthDate ?? a.birthDate, p.birthDateEstimated ?? a.birthDateEstimated);

  const idRows = p.idType === "newborn"
    ? `<dt>اسم الأم</dt><dd>${esc(p.motherName)}</dd><dt>الرقم القومي للأم</dt><dd class="ltr">${esc(p.motherNationalId)}</dd>
       <dt>تاريخ الولادة</dt><dd>${fmtDate(p.birthDate)}</dd>`
    : p.idType === "unknown"
      ? `<dt>الرقم القومي</dt><dd class="muted">غير معروف</dd>`
      : `<dt>الرقم القومي</dt><dd class="ltr">${esc(p.nationalId)}</dd><dt>تاريخ الميلاد</dt><dd>${fmtDate(p.birthDate)}</dd>`;

  const visits = p.admissionsCount || 1;
  const specs = (a.specialties || []).map((x) => `<span class="pill">${esc(x)}</span>`).join("") || `<span class="muted">لا يوجد</span>`;

  shell(`
  <div class="file-head">
    <a class="back" href="#/unit/${a.unitId}">${esc(unit.name)}</a>
    <h1>${esc(p.name || a.patientName)}</h1>
    <div class="tags">
      <span class="tag">${esc(unit.bedLabel)} ${a.bed}</span>
      ${active ? `<span class="tag day">اليوم ${dayOfStay(a.admitAt)} للإقامة</span>` : `<span class="tag archived">في الأرشيف</span>`}
    </div>
  </div>

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
        <dt>أيام الإقامة</dt><dd>${dayOfStay(a.admitAt)} يوم</dd>
        <dt>الوحدة</dt><dd>${esc(unit.name)}، ${esc(unit.bedLabel)} ${a.bed}</dd>
        <dt>استشاري الحالة</dt><dd>${esc(a.consultant) || "—"}</dd>
        <dt>التخصصات المشتركة</dt><dd>${specs}</dd>
        <dt>سجّل الدخول</dt><dd>${esc(a.createdByName)}</dd>
      </dl>
    </section>
  </div>

  <section class="panel">
    <header><h2>ملف المتابعة</h2></header>
    <p class="muted" style="margin:0">الأقسام دي هتتضاف في المرحلة الثانية:</p>
    <ul class="soon">
      <li>التاريخ المرضي</li><li>التشخيص</li><li>الإشراف المشترك ورأي التخصصات</li>
      <li>الأشعة والتحاليل</li><li>العلامات الحيوية وتطور الحالة</li><li>العلاج اليومي</li>
    </ul>
  </section>`);

  root.querySelector('[data-act="editBasic"]')?.addEventListener("click", () => openEditBasic(a, p));
  root.querySelector('[data-act="editAdm"]')?.addEventListener("click", () => openEditAdmission(a));
}

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
    if (admin) {
      const d = new Date(f.admitAt.value);
      if (isNaN(d) || d > new Date()) { err.textContent = "تاريخ الدخول غير صحيح."; return; }
      upd.admitAt = Timestamp.fromDate(d);
    }
    try { await updateDoc(doc(db, "admissions", a.id), upd); closeDialog(); toast("تم حفظ التعديل"); }
    catch (e) { err.textContent = errText(e); }
  };
}

/* =========================================================
   الإعدادات (أدمن)
   ========================================================= */
function renderSettings(tab) {
  const tabs = [["users", "المستخدمين"], ["units", "الوحدات والأسرّة"], ["lists", "الاستشاريين والتخصصات"], ["hospital", "بيانات المستشفى"]];
  const nav = `<nav class="tabs">${tabs.map(([k, t]) => `<a href="#/settings/${k}" class="${tab === k ? "on" : ""}">${t}</a>`).join("")}</nav>`;
  shell(nav + `<div id="tabBody"><div class="loading">جاري التحميل…</div></div>`);
  const body = document.getElementById("tabBody");
  ({ users: tabUsers, units: tabUnits, lists: tabLists, hospital: tabHospital }[tab] || tabUsers)(body);
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

/* ---------- القوائم ---------- */
function tabLists(body) {
  const block = (key, title, ph) => `
    <div class="settings-block">
      <div class="toolbar"><h2>${title}</h2></div>
      <div class="list-editor">
        <form class="add" data-key="${key}"><input placeholder="${ph}" required><button class="btn">إضافة</button></form>
        <div class="list-items">${(S.settings[key] || []).map((x, i) =>
          `<span>${esc(x)}<button type="button" data-key="${key}" data-i="${i}" aria-label="حذف ${esc(x)}">×</button></span>`).join("")
          || `<span class="muted" style="border:0;background:none">القائمة فاضية</span>`}</div>
      </div>
    </div>`;
  body.innerHTML = block("consultants", "الاستشاريين", "مثال: د. أحمد محمود") + block("specialties", "التخصصات المشتركة", "مثال: باطنة");
  const save = async (key, arr) => {
    try { await updateDoc(doc(db, "config", "settings"), { [key]: arr }); tabLists(body); }
    catch (e) { toast(errText(e), true); }
  };
  body.querySelectorAll("form.add").forEach((f) => (f.onsubmit = (ev) => {
    ev.preventDefault();
    const v = f.querySelector("input").value.trim();
    const arr = [...(S.settings[f.dataset.key] || [])];
    if (!v) return;
    if (arr.includes(v)) { toast("موجود بالفعل في القائمة", true); return; }
    arr.push(v);
    save(f.dataset.key, arr);
  }));
  body.querySelectorAll(".list-items button").forEach((b) => (b.onclick = () => {
    const arr = [...(S.settings[b.dataset.key] || [])];
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
