const crypto = require('node:crypto');
const express = require('express');

const paiseFor = (rupees) => Math.round(Number(rupees) * 100);
const mysqlDate = (value) => value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
const JOIN_EARLY_MINUTES = 15;
function parseIndiaSchedule(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - 330 * 60 * 1000);
  if (utc.getUTCFullYear() !== Number(year) || utc.getUTCMonth() !== Number(month) - 1 || utc.getUTCDate() !== Number(day)) return null;
  return utc;
}
function consultationCanJoin(scheduledAt, now = Date.now()) {
  if (!scheduledAt) return false;
  const start = mysqlDate(scheduledAt).getTime();
  return now >= start - JOIN_EARLY_MINUTES * 60 * 1000 && now <= start + 2 * 60 * 60 * 1000;
}
function billableAmountPaise(rateRupees, seconds) {
  const ratePaise = paiseFor(rateRupees);
  return Math.ceil((ratePaise * Math.max(0, Number(seconds) || 0)) / 60);
}
function demoControlsEnabled() { return process.env.PAYMENT_MODE === 'MOCK' && process.env.NODE_ENV !== 'production'; }
function makeDemoTransactionId() {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `DEMO-TXN-${day}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function makeIceServers() {
  const servers = [];
  const stunUrls = String(process.env.WEBRTC_STUN_SERVER || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (stunUrls.length) servers.push({ urls: stunUrls });
  const turnUrls = String(process.env.WEBRTC_TURN_SERVER || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (turnUrls.length && process.env.WEBRTC_TURN_CREDENTIAL) {
    const expires = Math.floor(Date.now() / 1000) + 60 * 60;
    const baseName = String(process.env.WEBRTC_TURN_USERNAME || 'healthconnect').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40) || 'healthconnect';
    const username = `${expires}:${baseName}`;
    const credential = crypto.createHmac('sha1', process.env.WEBRTC_TURN_CREDENTIAL).update(username).digest('base64');
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}
function makeJwt(payload, secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}
function verifySignedBody(rawBody, authorization, secret) {
  if (!rawBody || !authorization || !secret) return false;
  const token = String(authorization).replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return false;
    const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
    return claims.sha256 === digest;
  } catch { return false; }
}

module.exports = function registerConsultationRoutes({ app, pool, requireAuth, requireRole, authLimit }) {
  const wrap=(handler)=>(req,res,next)=>{
    try{const result=handler(req,res,next);if(result&&typeof result.then==='function')result.catch(next);return result;}
    catch(error){return next(error);}
  };
  const post = (path, ...handlers) => app.post(path, ...handlers.map(wrap));
  const get = (path, ...handlers) => app.get(path, ...handlers.map(wrap));
  const isConfigured = () => Boolean(process.env.PAYMENT_MODE === 'MOCK' && process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
  const safeJson = (value) => JSON.stringify(value || {}).slice(0, 4000);
  async function ownedConsultation(id, user) {
    const [rows] = await pool.execute(`SELECT c.*,DATE_FORMAT(c.scheduled_at,'%Y-%m-%d %H:%i:%s') AS scheduled_at_utc,mt.transaction_id,mt.payment_method,mt.payment_status AS demo_payment_status,mt.updated_at AS payment_updated_at,
      patient.name AS patient_name,patient.profile_image_url AS patient_photo,doctor.name AS doctor_name,doctor.profile_image_url AS doctor_photo,
      doctor.specialization,doctor.qualification
      FROM consultations c JOIN users patient ON patient.id=c.patient_id JOIN users doctor ON doctor.id=c.doctor_id
      LEFT JOIN mock_consultation_transactions mt ON mt.consultation_id=c.id
      WHERE c.public_id=? AND (c.patient_id=? OR c.doctor_id=?) LIMIT 1`, [id, user.id, user.id]);
    return rows[0] || null;
  }
  async function audit(connection, consultationId, actorId, eventType, details = {}) {
    await connection.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)', [consultationId, actorId || null, eventType, safeJson(details)]);
  }
  async function settle(consultation, endedBy, reason) {
    const connection = await pool.getConnection();
    let locked;
    let paymentStatus;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT *,GREATEST(0,TIMESTAMPDIFF(SECOND,started_at,UTC_TIMESTAMP())) AS server_elapsed_seconds FROM consultations WHERE id=? FOR UPDATE', [consultation.id]);
      locked = rows[0];
      if (!locked || ['COMPLETED','CANCELLED','REJECTED','EXPIRED','FAILED'].includes(locked.status)) { await connection.rollback(); return; }
      if (locked.status === 'SETTLING') { await connection.rollback(); return; }
      const actualSeconds = locked.started_at ? Math.min(Number(locked.max_minutes) * 60, Number(locked.server_elapsed_seconds) || 0) : 0;
      const totalPaise = billableAmountPaise(locked.rate_per_minute, actualSeconds);
      const totalAmount = (totalPaise / 100).toFixed(2);
      const doctorEarning = totalAmount;
      const nextStatus = actualSeconds > 0 ? 'SETTLING' : 'COMPLETED';
      paymentStatus = actualSeconds > 0 ? 'PENDING' : 'NOT_REQUIRED';
      await connection.execute(`UPDATE consultations SET status=?,payment_status=?,ended_at=UTC_TIMESTAMP(),ended_by=?,
        actual_seconds=?,billing_minutes=CEIL(?/60),total_amount=?,platform_fee_amount=0,doctor_earning_amount=?,failure_reason=? WHERE id=?`,
      [nextStatus, paymentStatus, endedBy || null, actualSeconds, actualSeconds, totalAmount, doctorEarning, reason || null, locked.id]);
      if (actualSeconds > 0) {
        await connection.execute(`INSERT INTO mock_consultation_transactions
          (transaction_id,consultation_id,patient_id,doctor_id,amount,currency,payment_method,payment_status)
          VALUES (?,?,?,?,?,'INR','DEMO_WALLET','PENDING')`,
        [makeDemoTransactionId(), locked.id, locked.patient_id, locked.doctor_id, totalAmount]);
      }
      await audit(connection, locked.id, endedBy, 'settlement_started', { actualSeconds, amount: totalAmount, paymentMode: 'MOCK' });
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    const patientTitle = locked.actual_seconds > 0 ? 'Demo payment required' : 'Consultation completed';
    const patientMessage = locked.actual_seconds > 0
      ? `Your consultation lasted ${locked.actual_seconds} seconds. Demo payment of ₹${Number(locked.total_amount).toFixed(2)} is ready. No real money is charged.`
      : 'Your consultation ended before billing started. No payment is due.';
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [locked.patient_id,'consultation',patientTitle,patientMessage]);
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [locked.doctor_id,'consultation','Consultation ended',`Your consultation ended after ${locked.actual_seconds} seconds. Gross demo earnings: ₹${Number(locked.doctor_earning_amount).toFixed(2)}.`]);
    await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)', [locked.id,endedBy || null,'settlement_completed',safeJson({ actualSeconds: locked.actual_seconds, amount: locked.total_amount, paymentStatus })]);
  }

  get('/consultations', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (!['patient','doctor','admin'].includes(user.role)) return res.status(404).render('not-found');
    if (user.role === 'admin') return res.redirect('/admin#admin-consultations');
    const [consultations] = await pool.execute(`SELECT c.*,DATE_FORMAT(c.scheduled_at,'%Y-%m-%d %H:%i:%s') AS scheduled_at_utc,mt.transaction_id,mt.payment_status AS demo_payment_status,mt.payment_method,
      patient.name AS patient_name,patient.profile_image_url AS patient_photo,
      doctor.name AS doctor_name,doctor.profile_image_url AS doctor_photo,doctor.specialization,doctor.qualification
      FROM consultations c JOIN users patient ON patient.id=c.patient_id JOIN users doctor ON doctor.id=c.doctor_id
      LEFT JOIN mock_consultation_transactions mt ON mt.consultation_id=c.id
      WHERE c.patient_id=? OR c.doctor_id=? ORDER BY c.requested_at DESC LIMIT 100`, [user.id,user.id]);
    for (const item of consultations) item.scheduledAtLabel=item.scheduled_at_utc?mysqlDate(item.scheduled_at_utc).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}):null;
    if (user.role === 'doctor') {
      const [[profile]] = await pool.execute("SELECT u.account_status,p.verification_status FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor'", [user.id]);
      const [[settings]] = await pool.execute('SELECT enabled FROM doctor_online_consult_settings WHERE doctor_id=?', [user.id]);
      const [[adminSettings]] = await pool.execute('SELECT enabled FROM consultation_settings WHERE id=1');
      const [[earnings]] = await pool.execute(`SELECT COUNT(*) AS total_count,
        COALESCE(SUM(actual_seconds),0) AS total_seconds,
        COALESCE(SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END),0) AS completed_count,
        COALESCE(SUM(CASE WHEN payment_status='PENDING' THEN doctor_earning_amount ELSE 0 END),0) AS pending_earnings,
        COALESCE(SUM(CASE WHEN payment_status='SUCCESS' THEN doctor_earning_amount ELSE 0 END),0) AS earnings
        FROM consultations WHERE doctor_id=?`, [user.id]);
      const [onlineSchedule]=await pool.execute('SELECT weekday,TIME_FORMAT(starts_at,\'%H:%i\') AS starts_at,TIME_FORMAT(ends_at,\'%H:%i\') AS ends_at,enabled FROM doctor_online_schedule WHERE doctor_id=? ORDER BY weekday',[user.id]);
    const minimumScheduleTime = new Date(Date.now() + 6 * 60 * 1000 + 330 * 60 * 1000).toISOString().slice(0,16);
      return res.render('consultations', { pageRole:'doctor', consultations, verified:profile?.account_status==='active'&&profile?.verification_status==='VERIFIED', onlineEnabled:Boolean(settings?.enabled), adminOnlineEnabled:Boolean(adminSettings?.enabled), availabilitySaved:req.query.availability==='saved', hasAvailabilitySettings:Boolean(settings), onlineSchedule, hasSavedSchedule:onlineSchedule.some((item)=>Boolean(item.enabled)), earnings, config:isConfigured(), scheduleSaved:req.query.schedule==='saved', minimumScheduleTime });
    }
    res.render('consultations', { pageRole:'patient', consultations, config:isConfigured() });
  });

  get('/admin/consultations', requireRole('admin'), async (req,res) => {
    const [[settings]]=await pool.execute('SELECT * FROM consultation_settings WHERE id=1');
    const [consultations]=await pool.execute(`SELECT c.public_id,c.status,c.payment_status,c.rate_per_minute,c.actual_seconds,c.total_amount,c.platform_fee_amount,c.doctor_earning_amount,c.requested_at,
      patient.name AS patient_name,doctor.name AS doctor_name,mt.transaction_id,mt.payment_method,mt.payment_status AS transaction_status
      FROM consultations c JOIN users patient ON patient.id=c.patient_id JOIN users doctor ON doctor.id=c.doctor_id LEFT JOIN mock_consultation_transactions mt ON mt.consultation_id=c.id
      ORDER BY c.requested_at DESC LIMIT 200`);
    res.render('admin-consultations',{settings,consultations,config:isConfigured()});
  });

  post('/admin/consultations/settings', requireRole('admin'), authLimit, async (req,res) => {
    const rate=Number(req.body.ratePerMinute); const maxMinutes=Number(req.body.maxMinutes);
    if (!Number.isFinite(rate)||rate<1||rate>100000||!Number.isInteger(maxMinutes)||maxMinutes<1||maxMinutes>240) return res.status(400).send('Rate or maximum minutes is outside the allowed range.');
    await pool.execute('UPDATE consultation_settings SET rate_per_minute=?,max_minutes=?,platform_fee_percent=0,enabled=?,updated_by=? WHERE id=1',[rate.toFixed(2),maxMinutes,req.body.enabled==='1'?1:0,req.session.user.id]);
    res.redirect('/admin/consultations');
  });

  post('/doctor/consultations/availability', requireRole('doctor'), authLimit, async (req,res) => {
    const [[profile]] = await pool.execute("SELECT u.account_status,p.verification_status FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor'", [req.session.user.id]);
    if (profile?.account_status!=='active' || profile?.verification_status!=='VERIFIED') return res.status(403).send('Only an active, verified doctor can change online consultation availability.');
    const enabled = req.body.enabled === '1' ? 1 : 0;
    await pool.execute('INSERT INTO doctor_online_consult_settings (doctor_id,enabled) VALUES (?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)', [req.session.user.id,enabled]);
    res.redirect('/consultations?availability=saved#online-availability');
  });

  post('/doctor/consultations/schedule', requireRole('doctor'), authLimit, async (req,res) => {
    const [[profile]]=await pool.execute("SELECT u.account_status,p.verification_status FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor'",[req.session.user.id]);
    if (profile?.account_status!=='active' || profile?.verification_status!=='VERIFIED') return res.status(403).send('Only an active, verified doctor can change the online consultation schedule.');
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      for(let weekday=0;weekday<7;weekday++){
        const enabled=req.body[`day_${weekday}`]==='1';
        const start=String(req.body[`start_${weekday}`]||'');const end=String(req.body[`end_${weekday}`]||'');
        if(enabled&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(end)||start>=end))throw new Error('Enter a valid same-day start and end time for each enabled day.');
        await connection.execute(`INSERT INTO doctor_online_schedule (doctor_id,weekday,starts_at,ends_at,enabled) VALUES (?,?,?,?,?)
          ON DUPLICATE KEY UPDATE starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),enabled=VALUES(enabled)`,[req.session.user.id,weekday,enabled?`${start}:00`:'00:00:00',enabled?`${end}:00`:'00:00:00',enabled?1:0]);
      }
      await connection.commit();
    } catch(error){await connection.rollback();return res.status(400).send(error.message||'Could not save availability schedule.');}
    finally{connection.release();}
    res.redirect('/consultations?schedule=saved#online-schedule-editor');
  });

  get('/consultations/new/:doctorId', requireRole('patient'), async (req,res) => {
    if (!isConfigured()) return res.status(503).send('Online consultation is not configured yet.');
    const doctorId = Number(req.params.doctorId);
    const [[doctor]] = await pool.execute(`SELECT u.id,u.name,u.profile_image_url,u.specialization,u.qualification,p.years_experience
      FROM users u JOIN provider_profiles p ON p.user_id=u.id JOIN doctor_online_consult_settings s ON s.doctor_id=u.id AND s.enabled=1
      WHERE u.id=? AND u.role='doctor' AND u.email_verified=1 AND u.account_status='active' AND p.verification_status='VERIFIED'
      `,[doctorId]);
    if (!doctor) return res.status(404).render('not-found');
    const [[settings]] = await pool.execute('SELECT rate_per_minute,max_minutes,currency,enabled FROM consultation_settings WHERE id=1');
    if (!settings?.enabled) return res.status(503).send('Online consultations are temporarily unavailable.');
    res.render('consultation-request', { doctor, settings });
  });

  post('/consultations/request', requireRole('patient'), authLimit, async (req,res) => {
    const doctorId = Number(req.body.doctorId);
    const consent = req.body.billingConsent === 'yes';
    if (!Number.isSafeInteger(doctorId) || doctorId < 1 || !consent) return res.status(400).send('Choose a doctor and confirm the demo per-minute billing terms.');
    if (!isConfigured()) return res.status(503).send('Payment/video services are not configured.');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[doctor]] = await connection.execute(`SELECT u.id FROM users u JOIN provider_profiles p ON p.user_id=u.id JOIN doctor_online_consult_settings s ON s.doctor_id=u.id AND s.enabled=1
        WHERE u.id=? AND u.role='doctor' AND u.email_verified=1 AND u.account_status='active' AND p.verification_status='VERIFIED'
        FOR UPDATE`, [doctorId]);
      const [[settings]] = await connection.execute('SELECT * FROM consultation_settings WHERE id=1 FOR UPDATE');
      await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE',[req.session.user.id]);
      const [[patientBusy]]=await connection.execute("SELECT id FROM consultations WHERE patient_id=? AND status IN ('REQUESTED','ACCEPTED','PAYMENT_PENDING','READY','ACTIVE','SETTLING') LIMIT 1 FOR UPDATE",[req.session.user.id]);
      if(patientBusy)throw new Error('Finish or cancel your existing online consultation before requesting another.');
      if (!doctor || !settings?.enabled) throw new Error('Doctor is not available for online consultation.');
      const publicId = crypto.randomUUID();
      const roomName = `hc-${crypto.randomBytes(24).toString('hex')}`;
      const [insert] = await connection.execute(`INSERT INTO consultations (public_id,room_name,patient_id,doctor_id,status,rate_per_minute,max_minutes,authorization_amount)
        VALUES (?,?,?,?,'REQUESTED',?,?,?)`, [publicId,roomName,req.session.user.id,doctorId,settings.rate_per_minute,settings.max_minutes,(Number(settings.rate_per_minute)*Number(settings.max_minutes)).toFixed(2)]);
      await connection.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)',[insert.insertId,req.session.user.id,'requested',safeJson({ rate:settings.rate_per_minute, maxMinutes:settings.max_minutes })]);
      await connection.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[doctorId,'consultation','New online consultation request','A patient has requested an online consultation. Review it from your Online consultations page.']);
      await connection.commit();
      return res.redirect(`/consultations/${publicId}`);
    } catch(error) { await connection.rollback(); return res.status(400).send(error.message || 'Could not request consultation.'); }
    finally { connection.release(); }
  });

  get('/consultations/:id', requireAuth, async (req,res) => {
    if (!['patient','doctor'].includes(req.session.user.role)) return res.status(404).render('not-found');
    const consultation = await ownedConsultation(req.params.id,req.session.user);
    if (!consultation) return res.status(404).render('not-found');
    const scheduledDate=consultation.scheduled_at_utc?mysqlDate(consultation.scheduled_at_utc):null;
    const scheduledAtLabel=scheduledDate?scheduledDate.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'full',timeStyle:'short'}):'';
    const minimumScheduleTime=new Date(Date.now()+6*60*1000+330*60*1000).toISOString().slice(0,16);
    res.render('consultation-detail',{ consultation, pageRole:req.session.user.role, config:isConfigured(), demoControls:demoControlsEnabled(), canJoin:consultation.status==='ACCEPTED'?consultationCanJoin(consultation.scheduled_at_utc):['READY','ACTIVE'].includes(consultation.status), scheduledAtLabel, minimumScheduleTime });
  });

  post('/consultations/:id/accept', requireRole('doctor'), authLimit, async (req,res) => {
    const consultation = await ownedConsultation(req.params.id,req.session.user);
    if (!consultation || Number(consultation.doctor_id) !== Number(req.session.user.id)) return res.status(404).render('not-found');
    if (!isConfigured()) return res.status(503).send('Payment/video services are not configured.');
    const scheduledAt = parseIndiaSchedule(req.body.scheduledAt);
    if (!scheduledAt || scheduledAt.getTime() < Date.now() + 5 * 60 * 1000 || scheduledAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) return res.status(400).send('Choose a valid appointment time at least 5 minutes from now and within the next 30 days (India time).');
    const [[verified]]=await pool.execute("SELECT u.id FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor' AND u.account_status='active' AND p.verification_status='VERIFIED'",[req.session.user.id]);
    if (!verified) return res.status(403).send('Only an active, verified doctor can accept consultations.');
    const proposedEnd=new Date(scheduledAt.getTime()+Number(consultation.max_minutes)*60*1000).toISOString().slice(0,19).replace('T',' ');
    const proposedStart=scheduledAt.toISOString().slice(0,19).replace('T',' ');
    const [[conflict]]=await pool.execute(`SELECT id FROM consultations WHERE doctor_id=? AND scheduled_at IS NOT NULL
      AND status IN ('ACCEPTED','READY','ACTIVE') AND scheduled_at<? AND DATE_ADD(scheduled_at,INTERVAL max_minutes MINUTE)>? LIMIT 1`,[req.session.user.id,proposedEnd,proposedStart]);
    if(conflict)return res.status(409).send('This time overlaps another scheduled call. Choose another time.');
    const [result] = await pool.execute("UPDATE consultations SET status='ACCEPTED',accepted_at=UTC_TIMESTAMP(),scheduled_at=? WHERE id=? AND doctor_id=? AND status='REQUESTED'",[scheduledAt.toISOString().slice(0,19).replace('T',' '),consultation.id,req.session.user.id]);
    if (!result.affectedRows) return res.status(409).send('This request is no longer waiting for acceptance.');
    const scheduledLabel = scheduledAt.toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'});
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.patient_id,'consultation','Doctor accepted and scheduled your request',`Your online consultation is scheduled for ${scheduledLabel} (India time). Open the consultation page 15 minutes before the appointment to join.`]);
    await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)',[consultation.id,req.session.user.id,'accepted',safeJson({scheduledAt:scheduledAt.toISOString(),timezone:'Asia/Kolkata'})]);
    res.redirect(`/consultations/${req.params.id}`);
  });

  post('/consultations/:id/reject', requireRole('doctor'), authLimit, async (req,res) => {
    const consultation = await ownedConsultation(req.params.id,req.session.user);
    if (!consultation || Number(consultation.doctor_id) !== Number(req.session.user.id)) return res.status(404).render('not-found');
    const [result] = await pool.execute("UPDATE consultations SET status='REJECTED',ended_at=UTC_TIMESTAMP(),ended_by=? WHERE id=? AND doctor_id=? AND status='REQUESTED'",[req.session.user.id,consultation.id,req.session.user.id]);
    if (!result.affectedRows) return res.status(409).send('This request is no longer waiting.');
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.patient_id,'consultation','Doctor declined your request','Your online consultation request was declined. You have not been charged.']);
    await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type) VALUES (?,?,?)',[consultation.id,req.session.user.id,'rejected']);
    res.redirect('/consultations');
  });

  post('/consultations/:id/cancel', requireRole('patient'), authLimit, async (req,res) => {
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[consultation]]=await connection.execute(
        'SELECT id,patient_id,doctor_id,status,started_at FROM consultations WHERE public_id=? AND patient_id=? FOR UPDATE',
        [req.params.id,req.session.user.id]
      );
      if (!consultation) { await connection.rollback(); return res.status(404).render('not-found'); }
      // A patient may withdraw a request before the call begins. A live call must
      // go through the settlement flow so its duration and demo payment are recorded.
      if (!['REQUESTED','ACCEPTED','READY'].includes(consultation.status) || consultation.started_at) {
        await connection.rollback();
        return res.status(409).send('This consultation has already started or finished and cannot be cancelled here.');
      }
      await connection.execute("UPDATE consultations SET status='CANCELLED',ended_at=UTC_TIMESTAMP(),ended_by=?,failure_reason='Cancelled by patient before call started' WHERE id=?",[req.session.user.id,consultation.id]);
      await audit(connection,consultation.id,req.session.user.id,'patient_cancelled_request');
      await connection.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.doctor_id,'consultation','Patient cancelled an online consultation','The patient cancelled this consultation before the call started. No payment was due.']);
      await connection.commit();
      return res.redirect(`/consultations/${req.params.id}`);
    } catch(error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });

  post('/consultations/:id/mock-payment', requireRole('patient'), authLimit, async (req,res) => {
    if (!demoControlsEnabled()) return res.status(404).render('not-found');
    const user=req.session.user;
    const action=String(req.body.action || '');
    if (!['success','fail','cancel'].includes(action)) return res.status(400).send('Choose a valid demo payment result.');
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[consultation]]=await connection.execute(`SELECT c.*,mt.id AS transaction_pk,mt.transaction_id
        FROM consultations c JOIN mock_consultation_transactions mt ON mt.consultation_id=c.id
        WHERE c.public_id=? AND c.patient_id=? FOR UPDATE`,[req.params.id,user.id]);
      if (!consultation) { await connection.rollback(); return res.status(404).render('not-found'); }
      if (consultation.status!=='SETTLING' || consultation.payment_status!=='PENDING') {
        await connection.rollback(); return res.status(409).send('This demo payment has already been processed or is not due.');
      }
      const transactionStatus={success:'SUCCESS',fail:'FAILED',cancel:'CANCELLED'}[action];
      const consultationStatus=action==='success'?'COMPLETED':transactionStatus;
      await connection.execute('UPDATE mock_consultation_transactions SET payment_status=? WHERE id=? AND payment_status=\'PENDING\'',[transactionStatus,consultation.transaction_pk]);
      const [updated]=await connection.execute('UPDATE consultations SET status=?,payment_status=? WHERE id=? AND status=\'SETTLING\' AND payment_status=\'PENDING\'',[consultationStatus,transactionStatus,consultation.id]);
      if (!updated.affectedRows) { await connection.rollback(); return res.status(409).send('This demo payment was already processed.'); }
      await audit(connection,consultation.id,user.id,`mock_payment_${action}`,{transactionId:consultation.transaction_id,amount:consultation.total_amount});
      await connection.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.patient_id,'consultation',`Demo payment ${transactionStatus.toLowerCase()}`,`Demo transaction ${consultation.transaction_id}: ₹${Number(consultation.total_amount).toFixed(2)}. No real money was charged.`]);
      await connection.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.doctor_id,'consultation',action==='success'?'Demo payment received':'Demo payment not completed',action==='success'?`Demo transaction ${consultation.transaction_id} completed. Gross earnings: ₹${Number(consultation.total_amount).toFixed(2)}.`:`Demo transaction ${consultation.transaction_id} is ${transactionStatus.toLowerCase()}.`]);
      await connection.commit();
      return res.redirect(`/consultations/${req.params.id}`);
    } catch(error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });

  post('/consultations/:id/token', requireAuth, authLimit, async (req,res) => {
    const consultation=await ownedConsultation(req.params.id,req.session.user);
    if (!consultation || !isConfigured()) return res.status(404).json({error:'Consultation not available.'});
    if (!['ACCEPTED','READY','ACTIVE'].includes(consultation.status)) return res.status(409).json({error:'The consultation must be accepted before joining.'});
    if (consultation.status==='ACCEPTED' && !consultationCanJoin(consultation.scheduled_at_utc)) return res.status(409).json({error:'The call opens 15 minutes before the scheduled appointment time.'});
    const user=req.session.user; const isPatient=user.id===consultation.patient_id; const role=isPatient?'patient':'doctor';
    if (!isPatient && user.id!==consultation.doctor_id) return res.status(404).json({error:'Consultation not available.'});
    if (role==='doctor') {
      const [[verified]]=await pool.execute("SELECT u.id FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor' AND u.account_status='active' AND p.verification_status='VERIFIED'",[user.id]);
      if (!verified) return res.status(403).json({error:'Doctor verification is required.'});
    }
    const now=Math.floor(Date.now()/1000); const token=makeJwt({iss:process.env.LIVEKIT_API_KEY,sub:`u-${user.id}`,name:role==='patient'?consultation.patient_name:consultation.doctor_name,nbf:now-5,iat:now,exp:now+600,video:{room:consultation.room_name,roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:false}},process.env.LIVEKIT_API_SECRET);
    res.json({serverUrl:process.env.LIVEKIT_URL,token,role,ratePerMinute:Number(consultation.rate_per_minute),maxMinutes:Number(consultation.max_minutes),rtcConfig:{iceServers:makeIceServers()}});
  });

  post('/consultations/:id/joined', requireAuth, authLimit, async (req,res) => {
    const consultation=await ownedConsultation(req.params.id,req.session.user);
    if (!consultation || !['ACCEPTED','READY','ACTIVE'].includes(consultation.status)) return res.status(409).json({error:'The consultation is not ready to join.'});
    const user=req.session.user; const isPatient=Number(user.id)===Number(consultation.patient_id);
    if (!isPatient && Number(user.id)!==Number(consultation.doctor_id)) return res.status(404).json({error:'Consultation not available.'});
    // Room membership comes from the signed LiveKit webhook, never this browser callback.
    res.json({connected:true,started:Boolean(consultation.started_at),startedAt:consultation.started_at});
  });

  get('/consultations/:id/state', requireAuth, async (req,res) => {
    const consultation=await ownedConsultation(req.params.id,req.session.user);
    if (!consultation) return res.status(404).json({error:'Consultation not available.'});
    const now=Math.floor(Date.now()/1000);
    const start=consultation.started_at?Math.floor(mysqlDate(consultation.started_at).getTime()/1000):null;
    const elapsed=start?Math.min(Number(consultation.max_minutes)*60,Math.max(0,now-start)):0;
    res.json({status:consultation.status,startedAt:consultation.started_at,elapsedSeconds:elapsed,ratePerMinute:Number(consultation.rate_per_minute),scheduledAt:consultation.scheduled_at_utc?`${consultation.scheduled_at_utc.replace(' ','T')}Z`:null,canJoin:consultation.status==='ACCEPTED'?consultationCanJoin(consultation.scheduled_at_utc):['READY','ACTIVE'].includes(consultation.status),patientWaiting:Boolean(consultation.patient_joined_at&&!consultation.patient_disconnected_at&&!consultation.doctor_joined_at)});
  });

  post('/consultations/:id/end', requireAuth, authLimit, async (req,res) => {
    const consultation=await ownedConsultation(req.params.id,req.session.user);
    if (!consultation) return res.status(404).render('not-found');
    try { await settle(consultation,req.session.user.id,'participant_ended'); res.redirect(`/consultations/${req.params.id}`); }
    catch(error) { console.error('Consultation settlement failed:',error.message); res.status(502).send('The session has ended, but payment settlement needs retry. Keep this page open and contact support if it remains pending.'); }
  });

  post('/webhooks/livekit', express.raw({ type:'application/webhook+json', limit:'256kb' }), async (req,res) => {
    if (!Buffer.isBuffer(req.body) || !verifySignedBody(req.body,req.get('Authorization'),process.env.LIVEKIT_API_SECRET)) return res.status(401).send('Invalid webhook signature.');
    let event; try { event=JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid event payload.'); }
    const room=event.room?.name;
    if (!room) return res.sendStatus(204);
    const [[consultation]]=await pool.execute('SELECT * FROM consultations WHERE room_name=? AND status IN (\'ACCEPTED\',\'READY\',\'ACTIVE\')',[room]);
    if (!consultation) return res.sendStatus(204);
    const identity=String(event.participant?.identity||'');
    const isPatient=identity===`u-${consultation.patient_id}`; const isDoctor=identity===`u-${consultation.doctor_id}`;
    if (!isPatient && !isDoctor) return res.sendStatus(204);
    if (event.event==='participant_left') {
      const col=isPatient?'patient_disconnected_at':'doctor_disconnected_at';
      await pool.execute(`UPDATE consultations SET ${col}=UTC_TIMESTAMP() WHERE id=?`,[consultation.id]);
      await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)',[consultation.id,isPatient?consultation.patient_id:consultation.doctor_id,'participant_disconnected',safeJson({role:isPatient?'patient':'doctor'})]);
    } else if (event.event==='participant_joined') {
      const col=isPatient?'patient_disconnected_at':'doctor_disconnected_at';
      const joined=isPatient?'patient_joined_at':'doctor_joined_at'; const other=isPatient?'doctor_joined_at':'patient_joined_at';
      await pool.execute(`UPDATE consultations SET ${joined}=COALESCE(${joined},UTC_TIMESTAMP()),${col}=NULL,status=IF(started_at IS NULL AND ${other} IS NOT NULL,'ACTIVE',status),started_at=IF(started_at IS NULL AND ${other} IS NOT NULL,UTC_TIMESTAMP(),started_at) WHERE id=?`,[consultation.id]);
      await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)',[consultation.id,isPatient?consultation.patient_id:consultation.doctor_id,'participant_connected',safeJson({role:isPatient?'patient':'doctor'})]);
      if(isPatient&&!consultation.doctor_joined_at){
        const waitingMessage=`Patient is waiting in the scheduled online consultation ${consultation.public_id}. Open Online consultations and join the call.`;
        await pool.execute(`INSERT INTO notifications (user_id,category,title,message)
          SELECT ?, 'consultation', 'Patient is waiting for the call', ? WHERE NOT EXISTS
          (SELECT 1 FROM notifications WHERE user_id=? AND category='consultation' AND title='Patient is waiting for the call' AND message=?)`,[consultation.doctor_id,waitingMessage,consultation.doctor_id,waitingMessage]);
      }
      const [[started]]=await pool.execute('SELECT started_at FROM consultations WHERE id=?',[consultation.id]);
      if (started.started_at && !consultation.started_at) {
        await pool.execute('INSERT INTO consultation_audit_events (consultation_id,actor_id,event_type,details_json) VALUES (?,?,?,?)',[consultation.id,null,'call_started',safeJson({livekit:true})]);
        await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.patient_id,'consultation','Consultation started','Both participants joined the private video room. Billing has started.']);
        await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',[consultation.doctor_id,'consultation','Consultation started','Both participants joined the private video room.']);
      }
    } else if (event.event==='room_finished') {
      try { await settle(consultation,null,'room_finished'); } catch(error) { console.error('LiveKit room settlement failed:',error.message); }
    }
    res.sendStatus(204);
  });

  // A pending paid call that loses a participant is settled after a 90-second reconnect window.
  const disconnectSweep=setInterval(async()=>{
    try {
      const [rows]=await pool.execute(`SELECT * FROM consultations WHERE status='ACTIVE' AND started_at IS NOT NULL AND
        ((patient_disconnected_at IS NOT NULL AND patient_disconnected_at < UTC_TIMESTAMP()-INTERVAL 90 SECOND) OR
         (doctor_disconnected_at IS NOT NULL AND doctor_disconnected_at < UTC_TIMESTAMP()-INTERVAL 90 SECOND) OR started_at < UTC_TIMESTAMP()-INTERVAL max_minutes MINUTE)`);
      for (const row of rows) try { await settle(row,null,'disconnect_or_duration_limit'); } catch(error) { console.error('Consultation sweep failed:',error.message); }
    } catch(error) { if (error.code!=='ER_NO_SUCH_TABLE') console.error('Consultation sweep query failed:',error.message); }
  },30000);
  disconnectSweep.unref?.();

};

module.exports.billableAmountPaise=billableAmountPaise;
module.exports.makeJwt=makeJwt;
module.exports.verifySignedBody=verifySignedBody;
module.exports.makeIceServers=makeIceServers;
module.exports.makeDemoTransactionId=makeDemoTransactionId;
module.exports.parseIndiaSchedule=parseIndiaSchedule;
module.exports.consultationCanJoin=consultationCanJoin;
