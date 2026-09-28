# نظام الرعاية المركزة: المرحلة 1

## الملفات
- `index.html`: الصفحة الرئيسية
- `css/style.css`: التصميم
- `js/app.js`: البرنامج
- `js/firebase-config.js`: إعدادات مشروع Firebase (لازم تعدله)
- `firestore.rules`: قواعد الأمان (تتلصق في Firebase)

## خطوات التشغيل

### 1. مشروع Firebase
1. من [console.firebase.google.com](https://console.firebase.google.com) اعمل مشروع جديد للمستشفى (منفصل عن مشروع العيادة).
2. **Build > Authentication > Get started**، وفعّل **Email/Password**.
3. **Build > Firestore Database > Create database**، اختار **Production mode** وأقرب منطقة (مثلاً `europe-west`).
4. من **Firestore > Rules** امسح الموجود والصق محتوى ملف `firestore.rules` كله، ودوس **Publish**.
5. من **Project settings > Your apps** أضف تطبيق **Web** (أيقونة `</>`)، وانسخ قيم `firebaseConfig` في ملف `js/firebase-config.js`.

### 2. الرفع على GitHub Pages
1. اعمل Repository جديد (مثلاً `zayed-icu`) وارفع كل الملفات بنفس ترتيب المجلدات.
2. **Settings > Pages**: اختار **Deploy from a branch**، والفرع `main` والمجلد `/ (root)`.
3. في Firebase: **Authentication > Settings > Authorized domains** أضف `اسمك.github.io`.

### 3. أول تشغيل
افتح رابط الموقع، هتظهر شاشة **تجهيز النظام لأول مرة**. سجل بيانات الأدمن (اسم المستخدم بالإنجليزي). الحساب ده بس اللي هيضيف باقي المستخدمين من **الإعدادات > المستخدمين**.

الوحدات الست بتتسجل تلقائياً بعدد أسرّتها، وتقدر تعدل أسماءها وعددها من **الإعدادات > الوحدات والأسرّة**. قبل ما الأطباء يبدأوا، أضف قائمة الاستشاريين والتخصصات من **الإعدادات > الاستشاريين والتخصصات**.

## ملاحظات
- الصلاحيات متطبقة في قاعدة البيانات نفسها، مش في الواجهة بس.
- الأدمن ميقدرش يغير كلمة مرور مستخدم تاني (قيد في Firebase المجاني). لو حد نسي كلمة المرور: أوقف حسابه واعمل له حساب جديد.
- متعطلش خيار التسجيل (sign-up) في Firebase Authentication، لأن إضافة المستخدمين من الإعدادات بتعتمد عليه. أي حد يعمل حساب من برة ملوش ملف مستخدم، فمش هيقدر يشوف أي بيانات.
