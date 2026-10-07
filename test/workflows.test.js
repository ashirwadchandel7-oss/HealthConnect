const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { utcSqlDate, addMinutes, decodeMedicalUpload } = require('../routes/healthcare');
const consultationBilling = require('../routes/consultations');

test('availability form values are strictly parsed as UTC minute timestamps', () => {
  assert.equal(utcSqlDate('2026-10-01T10:30'), '2026-10-01 10:30:00');
  assert.equal(utcSqlDate('not-a-time'), null);
  assert.equal(utcSqlDate('2026-02-30T10:30'), null);
});

test('slot duration arithmetic crosses hour and day boundaries in UTC', () => {
  assert.equal(addMinutes('2026-10-01 23:45:00', 30), '2026-10-02 00:15:00');
});

test('healthcare migration is additive and defines ownership and audit constraints', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../scripts/migrations/001_healthcare_workflows.sql'), 'utf8');
  for (const table of ['provider_profiles', 'provider_reviews', 'hospitals', 'doctor_availability', 'appointments', 'medical_records', 'prescriptions', 'notifications', 'audit_logs']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bTRUNCATE\b/i);
  assert.match(migration, /FOREIGN KEY \(patient_id\) REFERENCES users\(id\)/);
  assert.match(migration, /FOREIGN KEY \(actor_id\) REFERENCES users\(id\)/);
  const consentMigration = fs.readFileSync(path.join(__dirname, '../scripts/migrations/002_patient_assistance_consent.sql'), 'utf8');
  assert.match(consentMigration, /CREATE TABLE IF NOT EXISTS patient_assistance_consents/);
  assert.match(consentMigration, /FOREIGN KEY \(patient_id\) REFERENCES users\(id\)/);
});

test('every server-rendered POST form includes a CSRF token', () => {
  const viewsDir = path.join(__dirname, '../views');
  for (const file of fs.readdirSync(viewsDir).filter((name) => name.endsWith('.ejs'))) {
    const source = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    for (const match of source.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      if (/method\s*=\s*["']post["']/i.test(match[1])) {
        assert.match(match[2], /name=["']_csrf["']/, `${file} has a POST form without CSRF protection`);
      }
    }
  }
});

test('private medical uploads validate MIME signatures and enforce the 5 MB limit', () => {
  const pdf = Buffer.from('%PDF-1.7\nprivate test');
  const valid = decodeMedicalUpload(`data:application/pdf;base64,${pdf.toString('base64')}`);
  assert.equal(valid.mime, 'application/pdf');
  assert.equal(valid.extension, 'pdf');
  assert.equal(decodeMedicalUpload(`data:image/png;base64,${pdf.toString('base64')}`), null);
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
  assert.equal(decodeMedicalUpload(`data:application/pdf;base64,${oversized.toString('base64')}`), null);
});

test('doctor workspace migration adds private files, schedules, messages and affiliation review without dropping data', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../scripts/migrations/004_doctor_workspace.sql'), 'utf8');
  for (const table of ['doctor_weekly_schedule', 'doctor_unavailable_dates', 'doctor_hospital_affiliations', 'appointment_messages', 'account_preferences', 'provider_documents']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration, /ALTER TABLE prescriptions ADD COLUMN medicines_json/);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bTRUNCATE\b/i);
  assert.match(migration, /FOREIGN KEY \(doctor_id\) REFERENCES users\(id\)/);
  assert.match(migration, /FOREIGN KEY \(provider_user_id\) REFERENCES users\(id\)/);
});

test('weekly schedule edits ignore superseded blocked weekly slots and report bookable slot totals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/healthcare.js'), 'utf8');
  assert.match(source, /NOT \(source='weekly' AND slot_status='BLOCKED'\)/);
  assert.match(source, /availableNext7Days: availableSlots/);
  assert.match(source, /\$\{availableSlots\} bookable appointment slots are available over the next 7 days/);
});

test('consultation pay-per-minute billing is server-side, proportional to seconds, and rounds up to a paisa', () => {
  assert.equal(consultationBilling.billableAmountPaise(5, 0), 0);
  assert.equal(consultationBilling.billableAmountPaise(5, 60), 500);
  assert.equal(consultationBilling.billableAmountPaise(5, 630), 5250);
  assert.equal(consultationBilling.billableAmountPaise(5, 1), 9);
  assert.equal(consultationBilling.billableAmountPaise(5, 7200), 60000);
});

test('consultation settlement keeps payment status in scope for its completion audit', () => {
  const source=fs.readFileSync(path.join(__dirname,'../routes/consultations.js'),'utf8');
  const settlement=source.slice(source.indexOf('async function settle('),source.indexOf("  get('/consultations'"));
  assert.match(settlement,/let paymentStatus;/);
  assert.match(settlement,/paymentStatus = actualSeconds > 0 \? 'PENDING' : 'NOT_REQUIRED'/);
  assert.match(settlement,/safeJson\(\{ actualSeconds: locked\.actual_seconds, amount: locked\.total_amount, paymentStatus \}\)/);
});

test('clinic appointments support cash and demo UPI, with doctor-owned QR and patient-owned PDF proof', () => {
  const migration=fs.readFileSync(path.join(__dirname,'../scripts/migrations/010_doctor_upi_payments.sql'),'utf8');
  const appointmentMigration=fs.readFileSync(path.join(__dirname,'../scripts/migrations/009_in_person_booking_payments.sql'),'utf8');
  assert.match(migration,/payment_method ENUM\('CASH','RAZORPAY','UPI'\)/);
  assert.match(appointmentMigration,/payment_status ENUM\('CASH_DUE','PENDING','PAID','FAILED','EXPIRED'\)/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS doctor_payment_profiles/);
  assert.match(migration,/mock_payment_reference/);
  const router=fs.readFileSync(path.join(__dirname,'../routes/healthcare.js'),'utf8');
  assert.match(router,/paymentMethod === 'CASH' \? 'CONFIRMED' : 'BOOKED'/);
  assert.match(router,/WHERE a\.id=\? AND a\.patient_id=\? AND a\.consultation_type='in_person' LIMIT 1/);
  assert.match(router,/payment_method !== 'UPI'/);
  assert.match(router,/payment_status='PAID'/);
  assert.match(router,/proof\.pdf/);
  const proof=fs.readFileSync(path.join(__dirname,'../views/appointment-confirmation.ejs'),'utf8');
  assert.match(proof,/data-print-proof/);
  assert.match(proof,/booking_reference/);
  assert.match(proof,/Download appointment proof PDF/);
});

test('consultation migration defines rates, participant ownership, payment idempotency and audit rows additively', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../scripts/migrations/006_online_consultations.sql'), 'utf8');
  for (const table of ['consultation_settings','doctor_online_consult_settings','doctor_online_schedule','consultations','consultation_payments','consultation_audit_events']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.match(migration,/rate_per_minute DECIMAL/);
  assert.match(migration,/UNIQUE KEY uq_consult_payment_once/);
  assert.match(migration,/FOREIGN KEY \(patient_id\) REFERENCES users\(id\)/);
  assert.match(migration,/FOREIGN KEY \(doctor_id\) REFERENCES users\(id\)/);
  assert.doesNotMatch(migration,/\bDROP\s+TABLE\b|\bTRUNCATE\b/i);
});

test('LiveKit webhook verification rejects forged body and accepts a matching signed payload hash', () => {
  const crypto = require('node:crypto');
  const body = Buffer.from('{"event":"participant_joined"}');
  const secret = 'unit-test-livekit-secret';
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = b64({alg:'HS256',typ:'JWT'});
  const payload = b64({exp:Math.floor(Date.now()/1000)+60,sha256:crypto.createHash('sha256').update(body).digest('hex')});
  const signature = crypto.createHmac('sha256',secret).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${signature}`;
  assert.equal(consultationBilling.verifySignedBody(body,`Bearer ${token}`,secret),true);
  assert.equal(consultationBilling.verifySignedBody(Buffer.from('forged'),`Bearer ${token}`,secret),false);
});

test('demo payment mode creates unique clearly labeled demo transaction IDs', () => {
  const first=consultationBilling.makeDemoTransactionId();
  const second=consultationBilling.makeDemoTransactionId();
  assert.match(first,/^DEMO-TXN-\d{8}-[A-F0-9]{8}$/);
  assert.notEqual(first,second);
});

test('mock transaction migration records patient, doctor, status, amount, and one payment per consultation', () => {
  const migration=fs.readFileSync(path.join(__dirname,'../scripts/migrations/007_mock_consultation_payments.sql'),'utf8');
  assert.match(migration,/CREATE TABLE IF NOT EXISTS mock_consultation_transactions/);
  assert.match(migration,/UNIQUE\s+KEY|consultation_id BIGINT UNSIGNED NOT NULL UNIQUE/i);
  for(const status of ['PENDING','SUCCESS','FAILED','CANCELLED']) assert.match(migration,new RegExp(`'${status}'`));
  assert.match(migration,/FOREIGN KEY \(patient_id\) REFERENCES users\(id\)/);
  assert.match(migration,/FOREIGN KEY \(doctor_id\) REFERENCES users\(id\)/);
});

test('Razorpay is absent from active consultation routes and mock payment success is server controlled', () => {
  const source=fs.readFileSync(path.join(__dirname,'../routes/consultations.js'),'utf8');
  assert.doesNotMatch(source,/razorpay|RAZORPAY/i);
  assert.match(source,/req\.body\.action/);
  assert.match(source,/process\.env\.PAYMENT_MODE === 'MOCK'/);
  assert.match(source,/SELECT c\.\*,mt\.id AS transaction_pk/);
  assert.match(source,/UPDATE consultations SET status=\?,payment_status=\?/);
  assert.doesNotMatch(source,/req\.body\.(duration|totalAmount|finalAmount)/);
});

test('optional ICE configuration derives time-limited TURN REST credentials server-side', () => {
  const old={...process.env};
  try {
    process.env.WEBRTC_STUN_SERVER='stun:stun.example.test:3478';
    process.env.WEBRTC_TURN_SERVER='turn:turn.example.test:3478';
    process.env.WEBRTC_TURN_USERNAME='healthconnect-demo';
    process.env.WEBRTC_TURN_CREDENTIAL='turn-shared-secret';
    const config=consultationBilling.makeIceServers();
    assert.equal(config.length,2);
    assert.match(config[1].username,/^\d+:healthconnect-demo$/);
    assert.ok(config[1].credential);
    assert.notEqual(config[1].credential,'turn-shared-secret');
  } finally {
    for(const key of ['WEBRTC_STUN_SERVER','WEBRTC_TURN_SERVER','WEBRTC_TURN_USERNAME','WEBRTC_TURN_CREDENTIAL']) {
      if(old[key]===undefined) delete process.env[key]; else process.env[key]=old[key];
    }
  }
});

test('verified doctors can save their online availability before LiveKit is configured', () => {
  const route=fs.readFileSync(path.join(__dirname,'../routes/consultations.js'),'utf8');
  const view=fs.readFileSync(path.join(__dirname,'../views/consultations.ejs'),'utf8');
  const availability=route.slice(route.indexOf("post('/doctor/consultations/availability'"),route.indexOf("post('/doctor/consultations/schedule'"));
  const schedule=route.slice(route.indexOf("post('/doctor/consultations/schedule'"),route.indexOf("get('/consultations/new/:doctorId'"));
  assert.doesNotMatch(availability,/!isConfigured\(\)/);
  assert.doesNotMatch(schedule,/!isConfigured\(\)/);
  assert.match(view,/else \{ %>[\s\S]*Accept online consultation requests/);
  assert.match(view,/Patients can book after LiveKit video setup is complete/);
});

test('doctor directory always displays online consultation status and links to the doctor schedule', () => {
  const directory=fs.readFileSync(path.join(__dirname,'../views/doctors.ejs'),'utf8');
  const detail=fs.readFileSync(path.join(__dirname,'../views/doctor-detail.ejs'),'utf8');
  const consultations=fs.readFileSync(path.join(__dirname,'../views/consultations.ejs'),'utf8');
  assert.match(directory,/<section class="doctor-online-option" aria-label="Online consultation">/);
  assert.match(directory,/online_booking_enabled/);
  assert.match(directory,/doctor_online_enabled/);
  assert.match(directory,/admin_online_enabled/);
  assert.match(directory,/href="\/doctors\/<%= doctor\.id %>#online-consultation"/);
  assert.match(directory,/Request online consultation/);
  assert.match(detail,/id="online-consultation"/);
  assert.match(consultations,/adminOnlineEnabled/);
  assert.match(consultations,/Your patient-side request button will appear after you enable/);
});

test('doctor acceptance requires an exact India-time appointment and call access opens 15 minutes early', () => {
  const parse=consultationBilling.parseIndiaSchedule;
  const canJoin=consultationBilling.consultationCanJoin;
  assert.equal(parse('2026-02-30T10:00'),null);
  assert.equal(parse('bad'),null);
  assert.equal(parse('2026-10-05T10:00').toISOString(),'2026-10-05T04:30:00.000Z');
  const start=Date.parse('2026-10-05T04:30:00Z');
  assert.equal(canJoin('2026-10-05 04:30:00',start-16*60*1000),false);
  assert.equal(canJoin('2026-10-05 04:30:00',start-15*60*1000),true);
  assert.equal(canJoin('2026-10-05 04:30:00',start+2*60*60*1000+1),false);
  const migration=fs.readFileSync(path.join(__dirname,'../scripts/migrations/008_consultation_scheduling.sql'),'utf8');
  assert.match(migration,/ADD COLUMN scheduled_at DATETIME NULL/);
  const view=fs.readFileSync(path.join(__dirname,'../views/consultation-detail.ejs'),'utf8');
  assert.match(view,/name="scheduledAt"/);
  assert.match(view,/Appointment scheduled/);
  assert.match(view,/data-join-call/);
});

test('doctor dashboard reports actual LiveKit setup and links to availability controls', () => {
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const dashboard=fs.readFileSync(path.join(__dirname,'../views/dashboard.ejs'),'utf8');
  assert.match(server,/const videoConfigured=Boolean\(process\.env\.PAYMENT_MODE==='MOCK'&&process\.env\.LIVEKIT_URL&&process\.env\.LIVEKIT_API_KEY&&process\.env\.LIVEKIT_API_SECRET\)/);
  assert.doesNotMatch(server,/videoConfigured:false,doctorWorkspace/);
  assert.match(dashboard,/else if\(videoConfigured\)/);
  assert.match(dashboard,/href="\/consultations">Open online consultations/);
  assert.doesNotMatch(dashboard,/Online consultation service is not configured yet/);
});

test('doctor online availability and weekly hours expose saved state and explicit edit controls', () => {
  const route=fs.readFileSync(path.join(__dirname,'../routes/consultations.js'),'utf8');
  const view=fs.readFileSync(path.join(__dirname,'../views/consultations.ejs'),'utf8');
  const client=fs.readFileSync(path.join(__dirname,'../public/consultation-schedule.js'),'utf8');
  assert.match(route,/availabilitySaved:req\.query\.availability==='saved'/);
  assert.match(route,/scheduleSaved:req\.query\.schedule==='saved'/);
  assert.match(route,/res\.redirect\('\/consultations\?availability=saved#online-availability'\)/);
  assert.match(view,/data-editable-settings/);
  assert.match(view,/Edit availability/);
  assert.match(view,/Edit schedule/);
  assert.match(view,/Save schedule/);
  assert.match(client,/fields\.disabled = false/);
});

test('consultation handlers retain participant ownership checks and server-issued private room grants', () => {
  const source=fs.readFileSync(path.join(__dirname,'../routes/consultations.js'),'utf8');
  assert.match(source,/WHERE c\.public_id=\? AND \(c\.patient_id=\? OR c\.doctor_id=\?\)/);
  assert.match(source,/WHERE u\.id=\? AND u\.role='doctor' AND u\.account_status='active' AND p\.verification_status='VERIFIED'/);
  assert.match(source,/video:\{room:consultation\.room_name,roomJoin:true,canPublish:true,canSubscribe:true/);
  assert.doesNotMatch(source,/req\.body\.(duration|totalAmount|finalAmount)/);
});
