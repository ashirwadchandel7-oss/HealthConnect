require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('node:fs/promises');
const cryptoCsrf = crypto;

const app = express();
const isProd = process.env.NODE_ENV === 'production';
if (isProd) app.set('trust proxy', 1);

// Keep TiDB's TLS certificate verification enabled.
const dbSsl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined;
const dbOptions = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'healthconnect_bharat',
  ssl: dbSsl,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 2,
  idleTimeout: 240000,
  enableKeepAlive: false,
  charset: 'utf8mb4',
};

const pool = mysql.createPool(dbOptions);
const mailer =
  process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      })
    : null;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const liveKitUrl = process.env.LIVEKIT_URL || '';
let liveKitConnectSource = null;
try {
  const parsedLiveKitUrl = new URL(liveKitUrl);
  liveKitConnectSource = `${parsedLiveKitUrl.protocol}//${parsedLiveKitUrl.host}`;
} catch {}
const helmetCspDefaults = helmet.contentSecurityPolicy.getDefaultDirectives();
delete helmetCspDefaults['script-src'];
delete helmetCspDefaults['connect-src'];
delete helmetCspDefaults['frame-src'];
delete helmetCspDefaults['img-src'];
delete helmetCspDefaults['media-src'];
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmetCspDefaults,
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      connectSrc: ["'self'", ...(liveKitConnectSource ? [liveKitConnectSource] : [])],
      frameSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
    },
  },
}));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const sessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 900000,
    expiration: 86400000,
  },
  pool
);

const originalSessionQuery = sessionStore.query.bind(sessionStore);

sessionStore.query = async (sql, params) => {
  try {
    return await originalSessionQuery(sql, params);
  } catch (error) {
    const retryableErrors = [
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'PROTOCOL_CONNECTION_LOST',
    ];

    if (!retryableErrors.includes(error.code)) {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    return originalSessionQuery(sql, params);
  }
};
app.use(
  session({
    name: 'hc.sid',
    secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 86400000,
    },
  })
);

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = cryptoCsrf.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path !== '/webhooks/livekit') {
    const submitted = typeof req.body._csrf === 'string' ? Buffer.from(req.body._csrf) : Buffer.alloc(0);
    const expected = Buffer.from(req.session.csrfToken);
    if (submitted.length !== expected.length || !cryptoCsrf.timingSafeEqual(submitted, expected)) {
      return res.status(403).send('This form expired or could not be verified. Reload the page and try again.');
    }
  }
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.notice = req.session.notice || null;
  res.locals.roles = roleLabels;
  res.locals.doctorQualifications = doctorQualifications;
  res.locals.doctorSpecialties = doctorSpecialties;
  res.locals.formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value instanceof Date ? value.toISOString() : `${String(value).replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  };
  delete req.session.notice;
  res.locals.year = new Date().getFullYear();
  next();
});

// Keep the website behind authentication. Only account access and verification
// pages are public; the signed LiveKit webhook is authenticated by its signature.
const publicAccountRoutes = new Set([
  'GET /',
  'GET /register', 'POST /register',
  'GET /login', 'POST /login',
  'GET /verify-email', 'POST /verify-email', 'POST /verify-email/resend',
  'GET /forgot-password', 'POST /forgot-password',
  'GET /forgot-password/reset', 'POST /forgot-password/reset',
]);
app.use((req, res, next) => {
  if (publicAccountRoutes.has(`${req.method} ${req.path}`)) return next();
  if (req.method === 'GET' && /^\/profile-images\/\d+$/.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/webhooks/livekit') return next();
  if (req.session.user) return next();
  return requireAuth(req, res, next);
});

// Doctor profile photos are public profile assets. Patient photos are private
// and may only be seen by the patient or a doctor connected through care.
app.get('/profile-images/:userId', readProfileImage);

const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please wait and try again.',
});

const roleLabels = {
  patient: 'Patient',
  doctor: 'Doctor',
  hospital: 'Hospital / Healthcare organization',
  admin: 'Administrator',
};

const doctorQualifications = [
  'MBBS', 'MD (Doctor of Medicine)', 'MS (Master of Surgery)', 'DNB',
  'DM (Super-specialty)', 'MCh (Super-specialty)', 'BDS', 'MDS',
  'BAMS', 'MD (Ayurveda)', 'BHMS', 'MD (Homeopathy)', 'BUMS',
  'BSMS', 'BNYS', 'PG Diploma in Medicine', 'PG Diploma in a Specialty',
  'Fellowship in a Medical Specialty', 'PhD in Medicine', 'Other recognised medical qualification',
];
const doctorSpecialties = [
  'Anaesthesiology', 'Cardiology', 'Cardiothoracic Surgery', 'Dentistry', 'Dermatology',
  'Emergency Medicine', 'Endocrinology', 'ENT / Otolaryngology', 'Family Medicine',
  'Gastroenterology', 'General Medicine', 'General Surgery', 'Geriatrics', 'Haematology',
  'Infectious Disease', 'Nephrology', 'Neurology', 'Neurosurgery',
  'Obstetrics & Gynaecology', 'Oncology', 'Ophthalmology', 'Orthopaedics', 'Paediatrics',
  'Pathology', 'Psychiatry', 'Pulmonology', 'Radiology', 'Rheumatology', 'Urology',
];

const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const phoneOk = (s) => /^\+?[1-9]\d{9,14}$/.test(s.replace(/[\s()-]/g, ''));

function decodeDoctorProfileImage(dataUrl) {
  const match = typeof dataUrl === 'string'
    ? dataUrl.match(/^data:image\/(jpe?g|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
    : null;
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const isJpeg = match[1] === 'jpg' || match[1] === 'jpeg';
  const validSignature = isJpeg
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : match[1] === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return validSignature ? { buffer, extension: isJpeg ? 'jpg' : match[1] } : null;
}

async function storePendingDoctorPhoto(dataUrl) {
  const image = decodeDoctorProfileImage(dataUrl);
  if (!image) throw new Error('Choose a valid JPG, JPEG, PNG or WebP photo no larger than 5 MB.');
  const fileName = `${crypto.randomBytes(18).toString('hex')}.${image.extension}`;
  const directory = path.join(__dirname, 'var', 'pending-doctor-photos');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), image.buffer, { flag: 'wx', mode: 0o600 });
  return fileName;
}

async function saveDoctorProfilePhoto(dataUrl, userId, userRole) {
  const image = decodeDoctorProfileImage(dataUrl);
  if (!image) throw new Error('Choose a valid JPG, JPEG, PNG or WebP photo no larger than 5 MB.');
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id < 1 || !['doctor', 'patient'].includes(userRole)) {
    throw new Error('The profile photo owner could not be verified. Please sign in again.');
  }
  const photoUrl = `/profile-images/${id}`;
  const mimeType = image.extension === 'jpg' || image.extension === 'jpeg'
    ? 'image/jpeg'
    : `image/${image.extension}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'INSERT INTO profile_images (user_id,mime_type,image_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),image_data=VALUES(image_data),updated_at=CURRENT_TIMESTAMP',
      [id, mimeType, image.buffer]
    );
    const [updated] = await connection.execute(
      'UPDATE users SET profile_image_url=? WHERE id=? AND role=?',
      [photoUrl, id, userRole]
    );
    if (!updated.affectedRows) throw new Error('The profile photo owner could not be verified. Please sign in again.');
    await connection.commit();
    return photoUrl;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function removeDoctorProfilePhoto(photoUrl) {
  const match = typeof photoUrl === 'string'
    ? photoUrl.match(/^\/uploads\/profiles\/([a-f0-9]{36}\.(?:jpg|png|webp))$/)
    : null;
  if (!match) return;
  await fs.unlink(path.join(__dirname, 'public', 'uploads', 'profiles', match[1])).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function readProfileImage(req, res) {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.sendStatus(404);
  try {
    const [owners] = await pool.execute('SELECT id,role FROM users WHERE id=? LIMIT 1', [userId]);
    const owner = owners[0];
    if (!owner) return res.sendStatus(404);

    const viewer = req.session.user || null;
    let allowed = owner.role === 'doctor' || Number(viewer?.id) === userId;
    if (!allowed && owner.role === 'patient' && viewer?.role === 'doctor') {
      const [appointments] = await pool.execute(
        'SELECT 1 FROM appointments WHERE doctor_id=? AND patient_id=? LIMIT 1',
        [viewer.id, userId]
      );
      if (appointments.length) allowed = true;
      if (!allowed) {
        const [consultations] = await pool.execute(
          'SELECT 1 FROM consultations WHERE doctor_id=? AND patient_id=? LIMIT 1',
          [viewer.id, userId]
        );
        allowed = consultations.length > 0;
      }
    }
    if (!allowed) return res.sendStatus(404);

    const [images] = await pool.execute(
      'SELECT mime_type,image_data FROM profile_images WHERE user_id=? LIMIT 1',
      [userId]
    );
    if (!images.length) return res.sendStatus(404);
    res.set('Content-Type', images[0].mime_type);
    res.set('Cache-Control', owner.role === 'doctor' ? 'public, max-age=300' : 'private, max-age=120');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(images[0].image_data);
  } catch (error) {
    console.error('Profile image load failed:', error.message);
    return res.sendStatus(404);
  }
}

const safeReturnPath = (value) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/dashboard';
  }
  try {
    const target = new URL(value, 'http://localhost');
    return target.origin === 'http://localhost' ? target.pathname + target.search + target.hash : '/dashboard';
  } catch {
    return '/dashboard';
  }
};

const homePathForRole = (role) => ({ doctor: '/doctor/home', hospital: '/hospital/home', admin: '/admin' }[role] || '/dashboard');

const otpHash = (email, code, purpose) =>
  crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'development-only-change-this-secret')
    .update(`${email}:${purpose}:${code}`)
    .digest('hex');

const setNotice = (req, type, message) => {
  req.session.notice = { type, message };
};

function render(req, res, view, extra = {}) {
  res.render(view, {
    roles: view === 'register' ? Object.fromEntries(Object.entries(roleLabels).filter(([role]) => role !== 'admin')) : roleLabels,
    doctorQualifications,
    doctorSpecialties,
    otpTtlMinutes: Math.max(2, Number(process.env.OTP_TTL_MINUTES || 10)),
    localOtpMode: !mailer && !isProd,
    ...extra,
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    setNotice(req, 'error', 'Please sign in to continue.');
    const returnTo = safeReturnPath(req.originalUrl);
    return res.redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  if (req.session.user.role === 'health_worker' && req.path !== '/logout') {
    return res.status(403).render('not-found', { user: req.session.user, notice: null, year: new Date().getFullYear() });
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) return requireAuth(req, res, next);
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).render('not-found', { user: req.session.user, notice: null, year: new Date().getFullYear() });
    }
    next();
  };
}

async function sendCode(req, email, purpose) {
  const ttl = Math.max(2, Number(process.env.OTP_TTL_MINUTES || 10));
  const cooldown = otpCooldownSeconds(purpose);

  if (!mailer && isProd) {
    throw new Error('Email delivery is not configured. Add the Brevo SMTP settings before using account email flows.');
  }

  const [recent] = await pool.execute(
    'SELECT GREATEST(0, ? - TIMESTAMPDIFF(SECOND, created_at, NOW())) AS seconds_remaining FROM email_otps WHERE email=? AND purpose=? ORDER BY id DESC LIMIT 1',
    [cooldown, email, purpose]
  );

  const secondsRemaining = Number(recent[0]?.seconds_remaining || 0);
  if (secondsRemaining > 0) {
    const error = new Error(`Please wait ${secondsRemaining} seconds before requesting another code.`);
    error.code = 'OTP_COOLDOWN';
    error.retryAfterSeconds = secondsRemaining;
    throw error;
  }

  // A newly issued code replaces all earlier unused codes for this email and purpose.
  await pool.execute(
    'UPDATE email_otps SET consumed_at=NOW() WHERE email=? AND purpose=? AND consumed_at IS NULL',
    [email, purpose]
  );

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = otpHash(email, code, purpose);

  await pool.execute(
    'INSERT INTO email_otps (email,purpose,code_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL ? MINUTE))',
    [email, purpose, hash, ttl]
  );

  if (mailer) {
    try {
      const delivery = await mailer.sendMail({
        from: `${process.env.SMTP_FROM_NAME || 'HealthConnect Bharat'} <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
        to: email,
        subject: purpose === 'verify'
          ? 'Verify your HealthConnect Bharat account'
          : purpose === 'profile'
            ? 'Confirm your doctor profile changes'
            : 'Reset your HealthConnect Bharat password',
        text: `${purpose === 'profile' ? 'Confirm your doctor profile changes with this code' : 'Your verification code is'}: ${code}. It expires in ${ttl} minutes. If you did not request this, ignore this email.`,
      });
      const accepted = Array.isArray(delivery.accepted)
        && delivery.accepted.some((address) => String(address).toLowerCase() === email);
      if (!accepted) {
        const error = new Error('SMTP server did not accept this recipient address.');
        error.code = 'SMTP_RECIPIENT_REJECTED';
        throw error;
      }
      req.session.devOtp = null;
      return { delivery: 'email', messageId: delivery.messageId };
    } catch (e) {
      console.error('SMTP delivery failed:', e.code || 'UNKNOWN', e.message);
      req.session.devOtp = null;
      await pool.execute(
        'DELETE FROM email_otps WHERE email=? AND purpose=? AND code_hash=?',
        [email, purpose, hash]
      );
      const detail = String(e.message || '');
      const message = /525|unauthorized ip/i.test(detail)
        ? 'Brevo blocked this server IP (525 Unauthorized IP). Authorize the server IP in Brevo SMTP security settings, or turn off unknown-IP blocking for SMTP.'
        : /535|invalid login|authentication/i.test(detail)
          ? 'Brevo rejected the SMTP login. Check the SMTP Login and SMTP key configured in your hosting environment.'
          : /sender|from address/i.test(detail)
            ? 'Brevo rejected the sender address. Verify SMTP_FROM_EMAIL as a sender in Brevo.'
            : /timed? ?out|econnreset|econnrefused|esocket|network/i.test(`${e.code || ''} ${detail}`)
              ? 'The app could not reach Brevo SMTP. Check the hosting network and SMTP_HOST/SMTP_PORT settings, then retry.'
              : /account.*(inactive|suspend|disabled)|transactional.*(inactive|disabled|not active)/i.test(detail)
                ? 'Brevo transactional email is not active for this account. Check the Brevo account status and transactional email settings.'
            : 'Brevo could not accept the email. Check the SMTP error in the VS Code terminal and your Brevo account status.';
      const error = new Error(message);
      error.code = e.code || 'SMTP_DELIVERY_FAILED';
      throw error;
    }
  } else if (!isProd) {
    console.log(`[DEV OTP] ${purpose} ${email}: ${code}`);
    req.session.devOtp = code;
    return { delivery: 'console' };
  }
}

async function getResendWaitSeconds(email, purpose) {
  if (!email) return 0;
  const cooldown = otpCooldownSeconds(purpose);
  const [rows] = await pool.execute(
    'SELECT GREATEST(0, ? - TIMESTAMPDIFF(SECOND, created_at, NOW())) AS seconds_remaining FROM email_otps WHERE email=? AND purpose=? ORDER BY id DESC LIMIT 1',
    [cooldown, email, purpose]
  );
  if (!rows[0]) return 0;
  return Number(rows[0].seconds_remaining || 0);
}

function otpCooldownSeconds(purpose) {
  const configured = purpose === 'verify'
    ? process.env.OTP_VERIFY_COOLDOWN_SECONDS
    : process.env.OTP_COOLDOWN_SECONDS;
  const fallback = 120;
  const seconds = Number(configured || fallback);
  return Number.isFinite(seconds) ? Math.max(120, seconds) : fallback;
}

async function consumeCode(email, purpose, code, onSuccess) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT * FROM email_otps WHERE email=? AND purpose=? AND consumed_at IS NULL AND expires_at>NOW() ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [email, purpose]
    );
    const row = rows[0];

    if (!row) {
      await connection.rollback();
      return false;
    }

    const match = crypto.timingSafeEqual(
      Buffer.from(row.code_hash),
      Buffer.from(otpHash(email, code, purpose))
    );

    if (!match) {
      await connection.execute(
        'UPDATE email_otps SET consumed_at=IF(attempts+1>=?,NOW(),consumed_at), attempts=attempts+1 WHERE id=?',
        [Number(process.env.OTP_MAX_ATTEMPTS || 5), row.id]
      );
      await connection.commit();
      return false;
    }

    if (onSuccess) await onSuccess(connection);
    const [result] = await connection.execute(
      'UPDATE email_otps SET consumed_at=NOW() WHERE id=? AND consumed_at IS NULL',
      [row.id]
    );
    if (!result.affectedRows) throw new Error('This code has already been used. Request a new code.');

    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ==========================================
// 📌 रूट्स (ROUTES)
// ==========================================

// 1. होम पेज
app.get('/', async (req, res) => {
  let doctors = [];
  let directoryError = false;
  try {
    const [rows] = await pool.execute(
      "SELECT u.id,u.name,u.specialization,u.city,u.qualification,u.consultation_fee,u.profile_image_url FROM users u JOIN provider_profiles p ON p.user_id=u.id AND p.verification_status='VERIFIED' WHERE u.role='doctor' AND u.email_verified=1 AND u.account_status='active' AND LOWER(u.name)<>'aayush tyagi' ORDER BY u.created_at DESC LIMIT 3"
    );
    doctors = rows;
  } catch (e) {
    console.error(e.message);
    directoryError = true;
  }
  render(req, res, 'home', { doctors, directoryError });
});

// 2. रजिस्ट्रेशन (Register)
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  render(req, res, 'register', { roles: Object.fromEntries(Object.entries(roleLabels).filter(([role]) => role !== 'admin')), form: {}, error: null });
});

app.get('/healthcare', (req, res) => render(req, res, 'healthcare'));

app.post('/register', authLimit, async (req, res) => {
  const form = {
    name: (req.body.name || '').trim(),
    email: (req.body.email || '').trim().toLowerCase(),
    phone: (req.body.phone || '').trim(),
    role: req.body.role,
    organization: (req.body.organization || '').trim(),
    specialization: (req.body.specialization || '').trim(),
    city: (req.body.city || '').trim(),
    password: req.body.password || '',
  };
  let error = '';

  form.qualification = (req.body.qualification || '').trim();
  form.registrationNumber = (req.body.registrationNumber || '').trim();
  form.registrationAuthority = (req.body.registrationAuthority || '').trim();
  form.yearsExperience = (req.body.yearsExperience || '').trim();
  form.practiceAddress = (req.body.practiceAddress || '').trim();
  form.hospitalAddress = (req.body.hospitalAddress || '').trim();
  form.profileImageData = req.body.profileImageData || '';
  const qualificationChoices = Array.isArray(req.body.doctorQualifications)
    ? req.body.doctorQualifications
    : req.body.doctorQualifications ? [req.body.doctorQualifications] : [];
  const selectedDoctorQualifications = qualificationChoices
    .filter((item) => typeof item === 'string' && doctorQualifications.includes(item));
  const doctorQualificationsValid = form.role !== 'doctor' || (
    qualificationChoices.length >= 1 && qualificationChoices.length <= 3 &&
    new Set(qualificationChoices).size === qualificationChoices.length &&
    selectedDoctorQualifications.length === qualificationChoices.length
  );
  if (form.role === 'doctor') form.qualification = selectedDoctorQualifications.join(' · ');

  if (form.name.length < 2 || form.name.length > 100) {
    error = 'Enter your full name (2–100 characters).';
  } else if (!emailOk(form.email)) {
    error = 'Enter a valid email address.';
  } else if (!phoneOk(form.phone)) {
    error = 'Enter a valid phone number with country code if needed.';
  } else if (!roleLabels[form.role] || form.role === 'admin') {
    error = 'Choose a valid account type.';
  } else if (
    form.password.length < 10 ||
    !/[A-Za-z]/.test(form.password) ||
    !/[0-9]/.test(form.password)
  ) {
    error = 'Password must be at least 10 characters and include a letter and a number.';
  } else if (form.password !== req.body.confirmPassword) {
    error = 'Passwords do not match.';
  } else if (
    form.role === 'doctor' &&
    (!doctorSpecialties.includes(form.specialization) || !form.city || !form.qualification || !form.registrationNumber || !form.registrationAuthority || !doctorQualificationsValid)
  ) {
    error = 'Doctors must choose 1–3 listed qualifications, specialty, city, and provide their medical registration number.';
  } else if (form.role === 'doctor' && form.profileImageData && !decodeDoctorProfileImage(form.profileImageData)) {
    error = 'Profile photo must be a valid JPG, JPEG, PNG or WebP image no larger than 5 MB.';
  } else if (form.role === 'hospital' && (!form.organization || !form.city || !form.hospitalAddress)) {
    error = 'Healthcare organisations must provide a registered name, city and full address.';
  }

  if (error) return render(req, res, 'register', { form, error });

  try {
    const [existing] = await pool.execute('SELECT id,email_verified FROM users WHERE email=? LIMIT 1', [
      form.email,
    ]);
    if (existing[0]?.email_verified) {
      return render(req, res, 'register', {
        form,
        error: 'An account with this email already exists. Please sign in or reset your password.',
      });
    }

    const passwordHash = await bcrypt.hash(form.password, 12);
    const profileImageTempFile = form.role === 'doctor' && form.profileImageData
      ? await storePendingDoctorPhoto(form.profileImageData)
      : null;
    req.session.pendingRegistration = {
      name: form.name,
      email: form.email,
      phone: form.phone,
      role: form.role,
      organization: form.organization || null,
      specialization: form.specialization || null,
      qualification: form.qualification || null,
      registrationNumber: form.registrationNumber || null,
      city: form.city || null,
      registrationAuthority: form.registrationAuthority || null,
      yearsExperience: form.yearsExperience ? Number(form.yearsExperience) : null,
      practiceAddress: form.practiceAddress || null,
      state: (req.body.state || '').trim() || null,
      postalCode: (req.body.postalCode || '').trim() || null,
      hospitalAddress: form.hospitalAddress || null,
      hospitalLicence: (req.body.hospitalLicence || '').trim() || null,
      departments: (req.body.departments || '').trim() || null,
      services: (req.body.services || '').trim() || null,
      facilities: (req.body.facilities || '').trim() || null,
      accessibility: (req.body.accessibility || '').trim() || null,
      representativeName: (req.body.representativeName || '').trim() || null,
      profileImageTempFile,
      passwordHash,
    };
    req.session.pendingEmail = form.email;
    req.session.devOtp = null;
    const delivery = await sendCode(req, form.email, 'verify');
    setNotice(req, delivery?.delivery === 'console' ? 'info' : 'success', delivery?.delivery === 'console'
      ? 'Development mode: no email was sent. Your OTP is shown on this page and in the VS Code terminal.'
      : 'Brevo accepted your verification email for delivery. Check Inbox and Spam; delivery may take a short time.');
    return res.redirect('/verify-email');
  } catch (e) {
    console.error(e.message);
    if (req.session.pendingRegistration?.email === form.email) {
      return render(req, res, 'verify', {
        email: form.email,
        error: e.message,
        devOtp: req.session.devOtp,
        resendWaitSeconds: e.retryAfterSeconds || 0,
      });
    }
    return render(req, res, 'register', {
      form,
      error: e.code === 'ER_DUP_ENTRY'
        ? 'An account with this email already exists.'
        : 'Could not create your account right now. Please try again.',
    });
  }
});

// 3. ईमेल वेरिफिकेशन (Verify Email)
app.get('/verify-email', async (req, res) => {
  const pending = req.session.pendingRegistration;
  if (!pending) return res.redirect('/register');

  let resendWaitSeconds = 0;
  try {
    resendWaitSeconds = await getResendWaitSeconds(pending.email, 'verify');
  } catch (e) {
    console.error('Could not load verification resend timer:', e.message);
  }

  render(req, res, 'verify', {
    error: null,
    email: pending.email,
    devOtp: req.session.devOtp,
    resendWaitSeconds,
  });
});

app.post('/verify-email', authLimit, async (req, res) => {
  const pending = req.session.pendingRegistration;
  if (!pending) {
    setNotice(req, 'error', 'Your signup session expired. Please create your account again.');
    return res.redirect('/register');
  }

  const email = pending.email;
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) {
    return render(req, res, 'verify', {
      error: 'Enter the six-digit code sent to your email.',
      email,
      devOtp: req.session.devOtp,
      resendWaitSeconds: await getResendWaitSeconds(email, 'verify').catch(() => 0),
    });
  }

  let createdProfileImagePath = null;
  let createdProfileImageBuffer = null;
  let createdProfileImageMime = null;
  let newlyCreatedAccount = null;
  try {
    const verified = await consumeCode(email, 'verify', code, async (connection) => {
      if (pending.role === 'doctor' && (pending.profileImageTempFile || pending.profileImageData)) {
        if (!pending.profileImageTempFile && pending.profileImageData) {
          pending.profileImageTempFile = await storePendingDoctorPhoto(pending.profileImageData);
          delete pending.profileImageData;
        }
        if (!/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(pending.profileImageTempFile || '')) {
          throw new Error('The doctor photo is missing. Please return to sign up and choose a photo again.');
        }
        const pendingPhotoPath = path.join(__dirname, 'var', 'pending-doctor-photos', pending.profileImageTempFile);
        const imageBuffer = await fs.readFile(pendingPhotoPath);
        if (!imageBuffer.length || imageBuffer.length > 2 * 1024 * 1024) {
          throw new Error('The doctor photo is invalid. Please return to sign up and choose another photo.');
        }
        createdProfileImageBuffer = imageBuffer;
        const extension = path.extname(pending.profileImageTempFile).slice(1).toLowerCase();
        createdProfileImageMime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
      }
      const accountValues = [
        pending.name,
        pending.phone,
        pending.role,
        pending.organization,
        pending.specialization,
        pending.qualification,
        pending.registrationNumber,
        pending.city,
        pending.passwordHash,
        createdProfileImagePath,
        pending.role === 'patient' ? 'active' : 'pending',
        pending.email,
      ];
      const [legacyResult] = await connection.execute(
        'UPDATE users SET name=?,phone=?,role=?,organization=?,specialization=?,qualification=?,registration_number=?,city=?,password_hash=?,profile_image_url=?,email_verified=1,verified_at=NOW(),account_status=? WHERE email=? AND email_verified=0',
        accountValues
      );

      let userId;
      if (!legacyResult.affectedRows) {
        const [created] = await connection.execute(
          'INSERT INTO users (name,email,phone,role,organization,specialization,qualification,registration_number,city,password_hash,profile_image_url,email_verified,verified_at,account_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,NOW(),?)',
          [
            pending.name,
            pending.email,
            pending.phone,
            pending.role,
            pending.organization,
            pending.specialization,
            pending.qualification,
            pending.registrationNumber,
            pending.city,
            pending.passwordHash,
            createdProfileImagePath,
            pending.role === 'patient' ? 'active' : 'pending',
          ]
        );
        userId = created.insertId;
      } else {
        const [updated] = await connection.execute('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
        userId = updated[0]?.id;
      }
      if (createdProfileImageBuffer && userId) {
        createdProfileImagePath = `/profile-images/${userId}`;
        await connection.execute(
          'INSERT INTO profile_images (user_id,mime_type,image_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),image_data=VALUES(image_data),updated_at=CURRENT_TIMESTAMP',
          [userId, createdProfileImageMime, createdProfileImageBuffer]
        );
        await connection.execute('UPDATE users SET profile_image_url=? WHERE id=?', [createdProfileImagePath, userId]);
      }
      if (pending.role !== 'patient' && userId) {
          await connection.execute(
            'INSERT INTO provider_profiles (user_id,registration_authority,years_experience,practice_address,state,postal_code,verification_status) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE registration_authority=VALUES(registration_authority),years_experience=VALUES(years_experience),practice_address=VALUES(practice_address),state=VALUES(state),postal_code=VALUES(postal_code),verification_status=\'PENDING\',review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL',
            [userId,pending.registrationAuthority,pending.yearsExperience,pending.practiceAddress,pending.state,pending.postalCode,'PENDING']
          );
          if (pending.role === 'hospital') {
            await connection.execute(
              'INSERT INTO hospitals (user_id,registered_name,licence_number,address,state,postal_code,departments,services,facilities,accessibility,representative_name) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE registered_name=VALUES(registered_name),licence_number=VALUES(licence_number),address=VALUES(address),state=VALUES(state),postal_code=VALUES(postal_code),departments=VALUES(departments),services=VALUES(services),facilities=VALUES(facilities),accessibility=VALUES(accessibility),representative_name=VALUES(representative_name)',
              [userId,pending.organization,pending.hospitalLicence,pending.hospitalAddress || pending.city,pending.state,pending.postalCode,pending.departments,pending.services,pending.facilities,pending.accessibility,pending.representativeName || pending.name]
            );
          }
      }
      newlyCreatedAccount = {
        id: userId,
        name: pending.name,
        email: pending.email,
        role: pending.role,
        account_status: pending.role === 'patient' ? 'active' : 'pending',
      };
    });

    if (!verified) {
      return render(req, res, 'verify', {
        error: 'That code is invalid, expired, or has reached its attempt limit. Request a new code and try again.',
        email,
        devOtp: req.session.devOtp,
        resendWaitSeconds: await getResendWaitSeconds(email, 'verify').catch(() => 0),
      });
    }

    if (pending.profileImageTempFile) {
      await fs.unlink(path.join(__dirname, 'var', 'pending-doctor-photos', pending.profileImageTempFile)).catch(() => {});
    }
    req.session.pendingRegistration = null;
    req.session.pendingEmail = null;
    req.session.devOtp = null;
    const createdUser = newlyCreatedAccount;
    if (!createdUser) throw new Error('Verified account could not be loaded.');
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.user = {
      id: createdUser.id,
      name: createdUser.name,
      email: createdUser.email,
      role: createdUser.role,
      status: createdUser.account_status,
    };
    setNotice(req, 'success', 'Your email is verified and your account is ready. Welcome to HealthConnect Bharat.');
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    return res.redirect('/');
  } catch (e) {
    if (createdProfileImagePath?.startsWith('/uploads/profiles/')) {
      await fs.unlink(path.join(__dirname, 'public', createdProfileImagePath.slice(1))).catch(() => {});
    }
    console.error('Account verification failed:', e.message);
    const duplicate = e.code === 'ER_DUP_ENTRY';
    return render(req, res, 'verify', {
      error: duplicate
        ? 'An account with this email already exists. Please sign in or reset its password.'
        : 'We could not verify your account right now. Your code was not used; please try again.',
      email,
      devOtp: req.session.devOtp,
      resendWaitSeconds: await getResendWaitSeconds(email, 'verify').catch(() => 0),
    });
  }
});

app.post('/verify-email/resend', authLimit, async (req, res) => {
  const pending = req.session.pendingRegistration;
  if (!pending) {
    setNotice(req, 'error', 'Your signup session expired. Please create your account again.');
    return res.redirect('/register');
  }

  try {
    const delivery = await sendCode(req, pending.email, 'verify');
    setNotice(req, delivery?.delivery === 'console' ? 'info' : 'success', delivery?.delivery === 'console'
      ? 'Development mode: no email was sent. The new OTP is shown on this page and in the VS Code terminal.'
      : 'Brevo accepted your new verification email for delivery. Check Inbox and Spam.');
  } catch (e) {
    setNotice(req, 'error', e.message || 'Could not send a new code. Please try again.');
  }
  return res.redirect('/verify-email');
});

// 4. लॉगिन (Login)
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  render(req, res, 'login', { error: null, returnTo: safeReturnPath(req.query.next) });
});

app.post('/login', authLimit, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  try {
    const [rows] = await pool.execute(
      'SELECT id,name,email,role,password_hash,email_verified,account_status FROM users WHERE email=? LIMIT 1',
      [email]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return render(req, res, 'login', {
        error: 'Email or password is incorrect.',
        returnTo: safeReturnPath(req.body.next),
      });
    }
    if (!user.email_verified) {
      return render(req, res, 'login', {
        error: 'Verify your email before signing in.',
        returnTo: '',
      });
    }
    if (user.role === 'health_worker') {
      return render(req, res, 'login', {
        error: 'Health worker accounts are not supported on this website. Please contact support if you need help with your account.',
        returnTo: '',
      });
    }
    if (user.account_status === 'suspended') {
      return render(req, res, 'login', {
        error: 'This account is suspended. Please contact support.',
        returnTo: '',
      });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Could not start a secure session.');
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.account_status,
      };
      setNotice(
        req,
        'success',
        user.account_status === 'pending'
          ? 'Signed in. Your professional account is awaiting verification.'
          : 'Welcome back.'
      );
      req.session.save((saveError) => {
        if (saveError) {
          console.error('Login session save failed:', saveError.message);
          return res.status(500).send('Could not save your sign-in session. Please try again.');
        }
        res.redirect('/');
      });
    });
  } catch (e) {
    console.error(e.message);
    render(req, res, 'login', {
      error: 'The database is unavailable. Check your MySQL settings.',
      returnTo: '',
    });
  }
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error('Session logout failed:', error.message);
      return res.status(500).send('Could not sign out. Please try again.');
    }
    res.clearCookie('hc.sid');
    res.redirect('/');
  });
});

// 5. पासवर्ड भूल गए (Forgot Password)
app.get('/forgot-password', async (req, res) => {
  const step = req.query.step === 'reset' ? 'reset' : 'request';
  let resendWaitSeconds = 0;
  if (step === 'reset') {
    try {
      resendWaitSeconds = await getResendWaitSeconds(req.session.resetEmail, 'reset');
    } catch (e) {
      console.error('Could not load password reset timer:', e.message);
    }
  }
  render(req, res, 'forgot', {
    step,
    email: req.session.resetEmail || '',
    error: null,
    devOtp: req.session.devOtp,
    resendWaitSeconds,
  });
});

app.post('/forgot-password', authLimit, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!emailOk(email)) {
    return render(req, res, 'forgot', {
      step: 'request',
      email,
      error: 'Enter a valid email address.',
    });
  }

  try {
    req.session.resetEmail = email;
    const [rows] = await pool.execute(
      'SELECT id FROM users WHERE email=? AND email_verified=1',
      [email]
    );
    if (rows.length) {
      const delivery = await sendCode(req, email, 'reset');
      setNotice(req, delivery?.delivery === 'console' ? 'info' : 'success', delivery?.delivery === 'console'
        ? 'Development mode: no email was sent. If this account exists, its OTP is shown on this page and in the VS Code terminal.'
        : 'If the verified account exists, Brevo accepted the reset email for delivery. Check Inbox and Spam.');
    } else {
      req.session.devOtp = null;
      setNotice(req, isProd ? 'success' : 'info', isProd
        ? 'If the verified account exists, a reset email has been requested.'
        : 'Development mode: no email was sent. If the account exists, check the VS Code terminal for the local OTP.');
    }
    res.redirect('/forgot-password?step=reset');
  } catch (e) {
    const resendWaitSeconds = await getResendWaitSeconds(email, 'reset').catch(() => 0);
    render(req, res, 'forgot', {
      step: req.session.resetEmail === email ? 'reset' : 'request',
      email,
      error: e.message || 'Could not send a reset code. Please try again.',
      devOtp: req.session.devOtp,
      resendWaitSeconds,
    });
  }
});

app.get('/forgot-password/reset', async (req, res) => {
  if (!req.session.resetEmail) return res.redirect('/forgot-password');
  const resendWaitSeconds = await getResendWaitSeconds(req.session.resetEmail, 'reset').catch(() => 0);
  render(req, res, 'forgot', {
    step: 'reset',
    email: req.session.resetEmail || '',
    error: null,
    devOtp: req.session.devOtp,
    resendWaitSeconds,
  });
});

app.post('/forgot-password/reset', authLimit, async (req, res) => {
  const email = req.session.resetEmail || '';
  const code = (req.body.code || '').trim();
  const password = req.body.password || '';
  let error = '';

  if (!email) return res.redirect('/forgot-password');

  if (!/^\d{6}$/.test(code)) {
    error = 'Enter the six-digit code.';
  } else if (
    password.length < 10 ||
    !/[A-Za-z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    error = 'New password must be at least 10 characters and include a letter and a number.';
  } else if (password !== req.body.confirmPassword) {
    error = 'Passwords do not match.';
  }

  if (error) {
    return render(req, res, 'forgot', {
      step: 'reset',
      email,
      error,
      devOtp: req.session.devOtp,
      resendWaitSeconds: await getResendWaitSeconds(email, 'reset').catch(() => 0),
    });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    if (!(await consumeCode(email, 'reset', code, async (connection) => {
      const [result] = await connection.execute(
        'UPDATE users SET password_hash=? WHERE email=? AND email_verified=1',
        [passwordHash, email]
      );
      if (!result.affectedRows) throw new Error('No verified account matches this reset request.');
    }))) {
      return render(req, res, 'forgot', {
        step: 'reset',
        email,
        error: 'That code is invalid or expired.',
        devOtp: req.session.devOtp,
        resendWaitSeconds: await getResendWaitSeconds(email, 'reset').catch(() => 0),
      });
    }

    req.session.resetEmail = null;
    req.session.devOtp = null;
    setNotice(req, 'success', 'Password updated. Sign in with your new password.');
    res.redirect('/login');
  } catch (e) {
    render(req, res, 'forgot', {
      step: 'reset',
      email,
      error: 'We could not update the password right now. The code was not used; please try again.',
      devOtp: req.session.devOtp,
      resendWaitSeconds: await getResendWaitSeconds(email, 'reset').catch(() => 0),
    });
  }
});

// 6. डैशबोर्ड (Dashboard)
async function renderDashboard(req, res, doctorWorkspace = false, profileOnly = false, sectionOnly = null) {
  try {
    const userId = req.session.user.id;
    const role = req.session.user.role;
    const [rows] = await pool.execute('SELECT name,role,account_status,organization,specialization,qualification,registration_number,city,phone,email,email_verified,consultation_fee,profile_image_url,created_at FROM users WHERE id=?', [userId]);
    if (!rows.length) {
      req.session.destroy(() => {
        res.clearCookie('hc.sid');
        res.redirect('/login');
      });
      return;
    }
    const providerPromise = ['doctor','hospital'].includes(role) ? pool.execute('SELECT verification_status,review_reason,registration_authority,years_experience,practice_address,state,postal_code,bio FROM provider_profiles WHERE user_id=?', [userId]) : Promise.resolve([[]]);
    const doctorPaymentProfilePromise = role === 'doctor' ? pool.execute('SELECT upi_id,qr_image_url,updated_at FROM doctor_payment_profiles WHERE doctor_id=?', [userId]) : Promise.resolve([[]]);
    const appointmentsPromise = role === 'patient'
      ? pool.execute('SELECT a.*,da.location AS clinic_location,u.name AS doctor_name,u.specialization,u.qualification AS doctor_qualification,u.profile_image_url AS doctor_profile_image_url,(DATE(a.starts_at + INTERVAL 330 MINUTE)=DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE)) AS is_today,(a.starts_at>=UTC_TIMESTAMP() AND a.status IN (\'BOOKED\',\'CONFIRMED\')) AS is_upcoming FROM appointments a JOIN users u ON u.id=a.doctor_id LEFT JOIN doctor_availability da ON da.id=a.availability_id WHERE a.patient_id=? ORDER BY a.starts_at DESC LIMIT 100', [userId])
      : role === 'doctor' ? pool.execute("SELECT a.*,da.location AS clinic_location,u.name AS patient_name,u.profile_image_url AS patient_profile_image_url,(DATE(a.starts_at + INTERVAL 330 MINUTE)=DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE)) AS is_today,(a.starts_at>=UTC_TIMESTAMP() AND a.status IN ('BOOKED','CONFIRMED')) AS is_upcoming FROM appointments a JOIN users u ON u.id=a.patient_id LEFT JOIN doctor_availability da ON da.id=a.availability_id JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active' WHERE a.doctor_id=? ORDER BY a.starts_at DESC LIMIT 100", [userId]) : Promise.resolve([[]]);
    const [providerResult,appointmentsResult,records,prescriptions,notifications,availability,patientAvailableSlots,doctorPrescriptions,doctorStatsResult,doctorPatients,doctorRecords,doctorUpcoming,doctorMessages,doctorHospitals,doctorAffiliations,weeklySchedule,unavailableDates,patientMessages,doctorActivity,doctorPaymentProfileResult] = await Promise.all([
      providerPromise,
      appointmentsPromise,
      role === 'patient' ? pool.execute('SELECT id,title,notes,private_file_key,created_at FROM medical_records WHERE patient_id=? ORDER BY created_at DESC LIMIT 100',[userId]) : Promise.resolve([[]]),
      role === 'patient' ? pool.execute('SELECT p.id,p.issued_at,u.name AS doctor_name,u.specialization FROM prescriptions p JOIN users u ON u.id=p.doctor_id WHERE p.patient_id=? ORDER BY p.issued_at DESC LIMIT 100',[userId]) : Promise.resolve([[]]),
      pool.execute('SELECT id,category,title,message,read_at,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30',[userId]),
      role === 'doctor' ? pool.execute("SELECT a.id,a.starts_at,a.ends_at,a.consultation_type,a.location,a.slot_status FROM doctor_availability a JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active' WHERE a.doctor_id=? AND a.starts_at>UTC_TIMESTAMP() ORDER BY a.starts_at LIMIT 300",[userId]) : Promise.resolve([[]]),
      role === 'patient' ? pool.execute("SELECT a.id,a.starts_at,a.doctor_id,u.name AS doctor_name,u.specialization FROM doctor_availability a JOIN users u ON u.id=a.doctor_id JOIN provider_profiles p ON p.user_id=u.id WHERE a.slot_status='AVAILABLE' AND a.starts_at>UTC_TIMESTAMP() AND a.consultation_type='in_person' AND u.account_status='active' AND p.verification_status='VERIFIED' AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.doctor_id=a.doctor_id AND b.status IN ('BOOKED','CONFIRMED') AND b.starts_at<a.ends_at AND b.ends_at>a.starts_at) ORDER BY a.starts_at LIMIT 100",[]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute("SELECT pr.id,pr.appointment_id,pr.patient_id,pr.prescription_text,pr.medicines_json,pr.additional_notes,pr.issued_at,pr.amended_from,u.name AS patient_name FROM prescriptions pr JOIN users u ON u.id=pr.patient_id JOIN provider_profiles pp ON pp.user_id=pr.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active' WHERE pr.doctor_id=? ORDER BY pr.issued_at DESC LIMIT 100",[userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute(`SELECT COUNT(*) AS total,
        SUM(status='COMPLETED') AS completed,
        SUM(status='BOOKED') AS pending,
        SUM(DATE(starts_at + INTERVAL 330 MINUTE)=DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE) AND status IN ('BOOKED','CONFIRMED')) AS today,
        SUM(starts_at>UTC_TIMESTAMP() AND status IN ('BOOKED','CONFIRMED')) AS upcoming
        FROM appointments WHERE doctor_id=? AND EXISTS (SELECT 1 FROM provider_profiles p JOIN users d ON d.id=p.user_id AND d.account_status='active' WHERE p.user_id=? AND p.verification_status='VERIFIED')`,[userId,userId]) : Promise.resolve([[{total:0,completed:0,pending:0,today:0,upcoming:0}]]),
      role === 'doctor' ? pool.execute(`SELECT u.id,u.name,u.city,u.profile_image_url,COUNT(a.id) AS appointment_count,MAX(a.starts_at) AS last_appointment
        FROM appointments a JOIN users u ON u.id=a.patient_id JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active' WHERE a.doctor_id=?
        GROUP BY u.id,u.name,u.city ORDER BY last_appointment DESC LIMIT 100`,[userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute(`SELECT r.id,r.title,r.notes,r.private_file_key,r.created_at,u.name AS patient_name,a.id AS appointment_id
        FROM medical_records r JOIN appointments a ON a.id=r.appointment_id AND a.doctor_id=? JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active'
        JOIN users u ON u.id=r.patient_id WHERE r.created_by=? ORDER BY r.created_at DESC LIMIT 100`,[userId,userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute(`SELECT a.id,a.starts_at,a.ends_at,a.consultation_type,da.location,a.booking_reference,a.status,a.reason
        FROM appointments a LEFT JOIN doctor_availability da ON da.id=a.availability_id JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active'
        WHERE a.doctor_id=? AND a.starts_at>=UTC_TIMESTAMP() AND a.status IN ('BOOKED','CONFIRMED')
        ORDER BY starts_at LIMIT 5`,[userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute(`SELECT m.id,m.appointment_id,m.message,m.created_at,m.read_at,m.recipient_id,u.name AS participant_name,a.booking_reference
        FROM appointment_messages m JOIN appointments a ON a.id=m.appointment_id JOIN users u ON u.id=IF(m.sender_id=?,m.recipient_id,m.sender_id)
        JOIN provider_profiles pp ON pp.user_id=a.doctor_id AND pp.verification_status='VERIFIED' JOIN users du ON du.id=pp.user_id AND du.account_status='active'
        WHERE (m.sender_id=? OR m.recipient_id=?) AND a.doctor_id=? ORDER BY m.created_at DESC LIMIT 30`,[userId,userId,userId,userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute("SELECT u.id,h.registered_name FROM users u JOIN hospitals h ON h.user_id=u.id WHERE u.role='hospital' AND u.account_status='active' ORDER BY h.registered_name LIMIT 100") : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute(`SELECT af.id,af.status,h.registered_name FROM doctor_hospital_affiliations af JOIN hospitals h ON h.user_id=af.hospital_user_id WHERE af.doctor_id=? ORDER BY af.updated_at DESC`,[userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute('SELECT weekday,starts_at,ends_at,appointment_minutes,break_starts_at,break_ends_at FROM doctor_weekly_schedule WHERE doctor_id=? ORDER BY weekday',[userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute("SELECT id,DATE_FORMAT(unavailable_date,'%Y-%m-%d') AS unavailable_date,reason FROM doctor_unavailable_dates WHERE doctor_id=? AND unavailable_date>=DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE) ORDER BY unavailable_date LIMIT 60",[userId]) : Promise.resolve([[]]),
      role === 'patient' ? pool.execute(`SELECT m.id,m.appointment_id,m.sender_id,m.recipient_id,m.message,m.created_at,m.read_at,u.name AS participant_name,a.booking_reference
        FROM appointment_messages m JOIN appointments a ON a.id=m.appointment_id JOIN users u ON u.id=IF(m.sender_id=?,m.recipient_id,m.sender_id)
        WHERE (m.sender_id=? OR m.recipient_id=?) AND a.patient_id=? ORDER BY m.created_at DESC LIMIT 50`,[userId,userId,userId,userId]) : Promise.resolve([[]]),
      role === 'doctor' ? pool.execute('SELECT action,entity_type,entity_id,created_at FROM audit_logs WHERE actor_id=? ORDER BY created_at DESC LIMIT 8',[userId]) : Promise.resolve([[]]),
      doctorPaymentProfilePromise,
    ]);
    const appointments = appointmentsResult[0];
    for (const prescription of doctorPrescriptions[0]) {
      if (typeof prescription.medicines_json === 'string') {
        try { prescription.medicines = JSON.parse(prescription.medicines_json); } catch { prescription.medicines = []; }
      } else prescription.medicines = prescription.medicines_json || [];
    }
    const provider = providerResult[0][0] || null;
    const doctorStats = doctorStatsResult[0][0] || {total:0,completed:0,pending:0,today:0,upcoming:0};
    const doctorProfileCompletion = role === 'doctor'
      ? Math.round([rows[0].name, rows[0].profile_image_url, rows[0].specialization, rows[0].qualification, rows[0].registration_number, rows[0].city, provider?.registration_authority, provider?.years_experience, provider?.practice_address, rows[0].organization].filter(Boolean).length / 10 * 100)
      : 0;
    const videoConfigured=Boolean(process.env.PAYMENT_MODE==='MOCK'&&process.env.LIVEKIT_URL&&process.env.LIVEKIT_API_KEY&&process.env.LIVEKIT_API_SECRET);
    const medicalAiValues=[process.env.MEDICAL_AI_BASE_URL,process.env.MEDICAL_AI_API_KEY,process.env.MEDICAL_AI_MODEL].map(value=>String(value||'').trim());
    const medicalAiConfigured=medicalAiValues.every(value=>value&&!/(your[-_ ]|placeholder|replace[-_ ]|example|changeme)/i.test(value))&&/^https:\/\//i.test(medicalAiValues[0]);
    render(req,res,'dashboard',{profile:rows[0],provider:provider||null,appointments,records:records[0],prescriptions:prescriptions[0],notifications:notifications[0],availability:availability[0],patientAvailableSlots:patientAvailableSlots[0],doctorPrescriptions:doctorPrescriptions[0],doctorStats,doctorPatients:doctorPatients[0],doctorRecords:doctorRecords[0],doctorUpcoming:doctorUpcoming[0],doctorMessages:doctorMessages[0],patientMessages:patientMessages[0],doctorActivity:doctorActivity[0],doctorHospitals:doctorHospitals[0],doctorAffiliations:doctorAffiliations[0],weeklySchedule:weeklySchedule[0],unavailableDates:unavailableDates[0],doctorPaymentProfile:doctorPaymentProfileResult[0][0]||null,doctorProfileCompletion,doctorQualifications,doctorSpecialties,cancellationCutoffHours:Math.min(168,Math.max(0,Number(process.env.CANCELLATION_CUTOFF_HOURS||24))),videoConfigured,medicalAiConfigured,doctorWorkspace,profileOnly,sectionOnly});
  } catch (e) {
    console.error('Dashboard load failed:', e.message);
    res.status(503).send('Dashboard data is temporarily unavailable. Check that database migrations have been applied.');
  }
}

app.get('/profile', requireAuth, async (req, res) => {
  const role = req.session.user.role;
  if (role === 'patient' || role === 'doctor') return renderDashboard(req, res, false, true);
  if (role === 'hospital') return res.redirect('/hospital/home?view=profile#hospital-profile');
  try {
    const [rows] = await pool.execute('SELECT id,name,email,phone,city,account_status,email_verified FROM users WHERE id=? AND role=\'admin\' LIMIT 1', [req.session.user.id]);
    if (!rows.length) return res.status(404).render('not-found', { user: req.session.user, notice: null, csrfToken: res.locals.csrfToken, year: new Date().getFullYear() });
    return render(req, res, 'admin-profile', { profile: rows[0] });
  } catch (error) {
    console.error('Admin profile load failed:', error.message);
    return res.status(503).render('server-error', { user: req.session.user, notice: null, csrfToken: res.locals.csrfToken, year: new Date().getFullYear() });
  }
});

app.get('/settings', requireAuth, (req, res) => render(req, res, 'settings', { title: 'Settings | HealthConnect Bharat' }));
app.get('/my-appointments', requireAuth, (req, res) => {
  const role = req.session.user.role;
  if (role === 'patient') return renderDashboard(req, res, false, false, 'patient-appointments');
  if (role === 'doctor') return renderDashboard(req, res, true, false, 'doctor-appointments');
  if (role === 'hospital') return res.redirect('/hospital/home?section=appointments#hospital-appointments');
  if (role === 'admin') return res.redirect('/admin/consultations');
  return res.status(404).render('not-found');
});
app.get('/records', requireAuth, (req, res) => {
  const role = req.session.user.role;
  if (role === 'patient') return renderDashboard(req, res, false, false, 'patient-records');
  if (role === 'doctor') return renderDashboard(req, res, true, false, 'doctor-records');
  return res.status(404).render('not-found');
});
app.get('/health-assistant', requireRole('patient'), (req, res) => renderDashboard(req, res, false, false, 'patient-medical-assistant'));

app.get('/dashboard', requireAuth, (req, res) => {
  const roleHome = { admin: '/admin', hospital: '/hospital/home' };
  if (roleHome[req.session.user.role]) return res.redirect(roleHome[req.session.user.role]);
  if (req.session.user.role === 'doctor') return res.redirect('/profile');
  return renderDashboard(req, res, false);
});
app.get('/doctor/home', requireRole('doctor'), (req, res) => renderDashboard(req, res, true));

// 7. डॉक्टर्स लिस्ट (Doctors)
app.get('/doctors', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const city = typeof req.query.city === 'string' ? req.query.city.trim().slice(0, 100) : '';
  const lowerQuery = q.toLocaleLowerCase();
  const specialtyGroups = [
    ['cardiology', 'cardiologist'],
    ['paediatrics', 'pediatrics', 'paediatrician', 'pediatrician', 'child', 'children'],
  ];
  const matchingGroup = specialtyGroups.find((group) =>
    group.some((term) => lowerQuery.includes(term))
  );
  const searchTerms = [...new Set([q, ...(matchingGroup || [])].filter(Boolean))];
  const page=Math.max(1,Math.min(10000,Number.parseInt(req.query.page,10)||1)), pageSize=20, offset=(page-1)*pageSize;
  const filters = ["u.role='doctor'",'u.email_verified=1',"u.account_status='active'","p.verification_status='VERIFIED'"];
  const params = [];
  if(searchTerms.length){filters.push(`(${searchTerms.map(()=>'(u.name LIKE ? OR u.specialization LIKE ?)').join(' OR ')})`);searchTerms.forEach(term=>params.push(`%${term}%`,`%${term}%`));}
  if(city){filters.push('u.city LIKE ?');params.push(`%${city}%`);}

  try {
    const where=filters.join(' AND ');
    const [counts]=await pool.execute(`SELECT COUNT(*) AS total FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE ${where}`,params);
    const total=Number(counts[0].total);
    const [rows] = await pool.execute(`SELECT u.id,u.name,u.specialization,u.city,u.qualification,u.consultation_fee,u.profile_image_url,
      IF(COALESCE(os.enabled,0)=1 AND COALESCE(cs.enabled,0)=1 AND NOT EXISTS (SELECT 1 FROM consultations busy WHERE busy.doctor_id=u.id AND busy.status IN ('REQUESTED','ACCEPTED','PAYMENT_PENDING','READY','ACTIVE','SETTLING')) AND (NOT EXISTS (SELECT 1 FROM doctor_online_schedule x WHERE x.doctor_id=u.id AND x.enabled=1) OR EXISTS (SELECT 1 FROM doctor_online_schedule x WHERE x.doctor_id=u.id AND x.enabled=1 AND x.weekday=WEEKDAY(UTC_TIMESTAMP()+INTERVAL 330 MINUTE) AND TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)>=x.starts_at AND TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)<x.ends_at)),1,0) AS online_available,IF(COALESCE(os.enabled,0)=1 AND COALESCE(cs.enabled,0)=1,1,0) AS online_booking_enabled,COALESCE(os.enabled,0) AS doctor_online_enabled,COALESCE(cs.enabled,0) AS admin_online_enabled,cs.rate_per_minute AS online_rate
      FROM users u JOIN provider_profiles p ON p.user_id=u.id LEFT JOIN doctor_online_consult_settings os ON os.doctor_id=u.id LEFT JOIN consultation_settings cs ON cs.id=1
      WHERE ${where} ORDER BY u.name LIMIT ${pageSize} OFFSET ${offset}`,[...params]);
    if (rows.length) {
      const doctorIds = rows.map((doctor) => Number(doctor.id));
      const placeholders = doctorIds.map(() => '?').join(',');
      const [weeklyHours] = await pool.execute(
        `SELECT doctor_id,weekday,TIME_FORMAT(starts_at,'%H:%i') AS starts_at,TIME_FORMAT(ends_at,'%H:%i') AS ends_at,appointment_minutes FROM doctor_weekly_schedule WHERE doctor_id IN (${placeholders}) ORDER BY doctor_id,weekday`,
        doctorIds
      );
      const [openSlots] = await pool.execute(
        `SELECT a.id,a.doctor_id,a.starts_at,a.ends_at FROM doctor_availability a
         WHERE a.doctor_id IN (${placeholders}) AND a.slot_status='AVAILABLE'
         AND a.starts_at>=UTC_TIMESTAMP() AND a.starts_at<UTC_TIMESTAMP()+INTERVAL 7 DAY
         AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.doctor_id=a.doctor_id AND b.status IN ('BOOKED','CONFIRMED') AND b.starts_at<a.ends_at AND b.ends_at>a.starts_at)
         ORDER BY a.starts_at`,
        doctorIds
      );
      const hoursByDoctor = new Map();
      for (const hour of weeklyHours) {
        if (!hoursByDoctor.has(Number(hour.doctor_id))) hoursByDoctor.set(Number(hour.doctor_id), []);
        hoursByDoctor.get(Number(hour.doctor_id)).push(hour);
      }
      const slotsByDoctor = new Map();
      for (const slot of openSlots) {
        if (!slotsByDoctor.has(Number(slot.doctor_id))) slotsByDoctor.set(Number(slot.doctor_id), []);
        slotsByDoctor.get(Number(slot.doctor_id)).push(slot);
      }
      for (const doctor of rows) {
        doctor.weekly_hours = hoursByDoctor.get(Number(doctor.id)) || [];
        doctor.open_slots_this_week = slotsByDoctor.get(Number(doctor.id)) || [];
      }
    }
    const videoConfigured=Boolean(process.env.PAYMENT_MODE==='MOCK'&&process.env.LIVEKIT_URL&&process.env.LIVEKIT_API_KEY&&process.env.LIVEKIT_API_SECRET);
    return render(req, res, 'doctors', { doctors: rows, q, city, page,pageSize,total,hasNext:offset+rows.length<total,videoConfigured,directoryError: false });
  } catch (e) {
    console.error(e.message);
    res.status(503);
    return render(req, res, 'doctors', { doctors: [], q, city, page, total: 0, hasNext: false, videoConfigured:false, directoryError: true });
  }
});

// 8. अबाउट (About)
app.get('/about', (req, res) => render(req, res, 'about'));

require('./routes/consultations')({app,pool,requireAuth,requireRole,authLimit});
require('./routes/healthcare')({app,pool,requireAuth,requireRole,authLimit,setNotice,saveDoctorProfilePhoto,removeDoctorProfilePhoto,doctorQualifications,doctorSpecialties,sendCode,consumeCode,getResendWaitSeconds});
require('./routes/patient-medical-assistant')({app,requireRole,authLimit});

// 9. 404 - नॉट फाउंड
app.use((req, res) => {
  res.status(404).render('not-found', {
    user: req.session.user || null,
    notice: null,
    year: new Date().getFullYear(),
  });
});

// ==========================================
// 🚀 सर्वर स्टार्ट करना
// ==========================================
async function start() {
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (
    isProd &&
    (!sessionSecret ||
      sessionSecret === 'development-only-change-this-secret' ||
      sessionSecret.startsWith('replace-with-') ||
      Buffer.byteLength(sessionSecret) < 32)
  ) {
    throw new Error('Set a unique SESSION_SECRET of at least 32 bytes before production startup.');
  }

  await pool.query('SELECT 1');
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () =>
    console.log(`HealthConnect Bharat ready at http://localhost:${port}`)
  );
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. The website may already be running at http://localhost:${port}. Stop the other npm run dev terminal before starting another copy.`);
      pool.end().finally(() => process.exit(0));
      return;
    }
    console.error('Could not start the HTTP server:', error.message);
    process.exit(1);
  });
}

start().catch((e) => {
  console.error(
    'Startup failed. Confirm MySQL is running, the database exists, and DB_* values in .env are correct.\n' +
      e.message
  );
  process.exit(1);
});
