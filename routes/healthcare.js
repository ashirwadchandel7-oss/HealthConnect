const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const activeAppointmentStates = ['BOOKED', 'CONFIRMED'];
const allowedReviewStates = new Set(['UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'NEEDS_CORRECTION']);

function utcSqlDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 16) !== value) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function addMinutes(sqlDate, minutes) {
  const date = new Date(`${sqlDate.replace(' ', 'T')}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

const indiaDateKey = (date = new Date()) => new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10);
function indiaLocalToUtc(dateKey, time) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60000);
}

function reference() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function decodePaymentQr(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const valid = match[1] === 'jpeg'
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : match[1] === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return valid ? { buffer, extension: match[1] === 'jpeg' ? 'jpg' : match[1] } : null;
}

async function storeDoctorPaymentQr(doctorId, dataUrl) {
  const image = decodePaymentQr(dataUrl);
  if (!image) throw new Error('Choose a valid JPG, PNG or WebP QR image up to 5 MB.');
  const fileName = `${doctorId}-${crypto.randomBytes(18).toString('hex')}.${image.extension}`;
  const directory = path.join(__dirname, 'public', 'uploads', 'payment-qr');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), image.buffer, { flag: 'wx' });
  return `/uploads/payment-qr/${fileName}`;
}

async function removeDoctorPaymentQr(doctorId, imageUrl) {
  const match = typeof imageUrl === 'string' && imageUrl.match(new RegExp(`^/uploads/payment-qr/${doctorId}-([a-f0-9]{36}\\.(?:jpg|png|webp))$`));
  if (match) await fs.unlink(path.join(__dirname, 'public', 'uploads', 'payment-qr', match[1])).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function proofPdf(lines) {
  const escape = (value) => String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1').slice(0, 150);
  const commands = ['BT', '/F1 18 Tf', '50 790 Td', '(HealthConnect Bharat - Appointment Proof) Tj', '/F1 11 Tf'];
  lines.forEach((line) => commands.push('0 -27 Td', `(${escape(line)}) Tj`));
  commands.push('ET');
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output, 'ascii')); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'ascii');
}

function decodeMedicalUpload(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const signatures = {
    'application/pdf': buffer.subarray(0, 5).toString() === '%PDF-',
    'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    'image/png': buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    'image/webp': buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP',
  };
  if (!signatures[match[1]]) return null;
  const extension = match[1] === 'application/pdf' ? 'pdf' : match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  return { buffer, extension, mime: match[1] };
}

module.exports = function registerHealthcareRoutes({ app, pool, requireAuth, requireRole, authLimit, setNotice, saveDoctorProfilePhoto, removeDoctorProfilePhoto, doctorQualifications, doctorSpecialties, sendCode, consumeCode, getResendWaitSeconds }) {
  const wrapHandler = (handler) => (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
      return result;
    } catch (error) {
      return next(error);
    }
  };
  const get = (routePath, ...handlers) => app.get(routePath, ...handlers.map(wrapHandler));
  const post = (routePath, ...handlers) => app.post(routePath, ...handlers.map(wrapHandler));

  async function requireVerifiedDoctor(req, res, next) {
    const [rows] = await pool.execute(
      "SELECT u.id FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor' AND u.account_status='active' AND p.verification_status='VERIFIED' LIMIT 1",
      [req.session.user.id]
    );
    if (!rows.length) {
      setNotice(req, 'error', 'This action is available after administrator verification of your doctor profile.');
      return res.redirect('/doctor/home');
    }
    return next();
  }

  async function verifiedDoctorWhenDoctor(req, res, next) {
    if (req.session.user?.role !== 'doctor') return next();
    return requireVerifiedDoctor(req, res, next);
  }

  async function audit(connection, actorId, action, entityType, entityId, details = null) {
    await connection.execute(
      'INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)',
      [actorId || null, action, entityType, entityId || null, details ? JSON.stringify(details) : null]
    );
  }

  async function notify(connection, userId, category, title, message) {
    await connection.execute(
      'INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)',
      [userId, category, title, message]
    );
  }

  post('/doctor/payment-profile', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const upiId = String(req.body.upiId || '').trim();
    const imageData = String(req.body.qrImageData || '');
    if (!/^[A-Za-z0-9._-]{2,80}@[A-Za-z0-9.-]{2,40}$/.test(upiId)) {
      setNotice(req, 'error', 'Enter a valid UPI ID, for example name@bank.');
      return res.redirect('/doctor/home#doctor-payment-settings');
    }
    let savedImageUrl = null;
    try {
      const [[existing]] = await pool.execute('SELECT qr_image_url FROM doctor_payment_profiles WHERE doctor_id=?', [req.session.user.id]);
      if (imageData) savedImageUrl = await storeDoctorPaymentQr(req.session.user.id, imageData);
      else if (existing?.qr_image_url) savedImageUrl = existing.qr_image_url;
      else throw new Error('Upload your UPI QR image before saving.');
      await pool.execute(`INSERT INTO doctor_payment_profiles (doctor_id,upi_id,qr_image_url) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE upi_id=VALUES(upi_id),qr_image_url=VALUES(qr_image_url)`, [req.session.user.id, upiId, savedImageUrl]);
      if (imageData && existing?.qr_image_url && existing.qr_image_url !== savedImageUrl) await removeDoctorPaymentQr(req.session.user.id, existing.qr_image_url);
      await pool.execute("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,details_json) VALUES (?,'doctor.payment_profile.updated','doctor_payment_profile',?,?)", [req.session.user.id, req.session.user.id, JSON.stringify({ upiIdUpdated: true, qrUpdated: Boolean(imageData) })]);
      setNotice(req, 'success', 'Your UPI ID and QR code are saved. Patients can use them for demo UPI payment.');
    } catch (error) {
      if (savedImageUrl && imageData) await removeDoctorPaymentQr(req.session.user.id, savedImageUrl).catch(() => {});
      setNotice(req, 'error', error.message.startsWith('Choose a valid') || error.message.startsWith('Upload your') ? error.message : 'UPI payment details could not be saved.');
    }
    res.redirect('/doctor/home#doctor-payment-settings');
  });

  post('/doctor/profile/change/request', requireRole('doctor'), authLimit, async (req, res) => {
    const selected = Array.isArray(req.body.doctorQualifications) ? req.body.doctorQualifications : req.body.doctorQualifications ? [req.body.doctorQualifications] : [];
    const yearsText = String(req.body.yearsExperience || '').trim();
    const feeText = String(req.body.consultationFee || '').trim();
    const phone = String(req.body.phone || '').trim();
    const change = {
      name: String(req.body.name || '').trim().slice(0, 100),
      phone,
      city: String(req.body.city || '').trim().slice(0, 100),
      specialization: String(req.body.specialization || '').trim(),
      qualification: selected.join(' · '),
      registration_number: String(req.body.registrationNumber || '').trim().slice(0, 100),
      registration_authority: String(req.body.registrationAuthority || '').trim().slice(0, 180),
      organization: String(req.body.organization || '').trim().slice(0, 180),
      consultation_fee: feeText ? Number(feeText) : null,
      years_experience: yearsText ? Number(yearsText) : null,
      practice_address: String(req.body.practiceAddress || '').trim().slice(0, 500),
      state: String(req.body.state || '').trim().slice(0, 100),
      bio: String(req.body.bio || '').trim().slice(0, 2000),
    };
    const phoneOk = /^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s()-]/g, ''));
    const qualificationOk = selected.length >= 1 && selected.length <= 3 && new Set(selected).size === selected.length && selected.every((item) => doctorQualifications.includes(item));
    if (change.name.length < 2 || !phoneOk || !doctorSpecialties.includes(change.specialization) || !qualificationOk
      || !change.registration_number || !change.registration_authority
      || (yearsText && (!Number.isInteger(change.years_experience) || change.years_experience < 0 || change.years_experience > 70))
      || (feeText && (!Number.isFinite(change.consultation_fee) || change.consultation_fee < 0 || change.consultation_fee > 100000))) {
      setNotice(req, 'error', 'Check your details, qualification selection, registration information, and contact number.');
      return res.redirect('/profile');
    }
    const [currentRows] = await pool.execute(`SELECT u.name,u.phone,u.city,u.specialization,u.qualification,u.registration_number,u.organization,u.consultation_fee,
      p.registration_authority,p.years_experience,p.practice_address,p.state,p.bio FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='doctor'`, [req.session.user.id]);
    if (!currentRows.length) return res.status(404).render('not-found');
    const current = currentRows[0];
    const changed = Object.entries(change).some(([key, value]) => String(value ?? '') !== String((key in current ? current[key] : current[key]) ?? ''));
    if (!changed) {
      setNotice(req, 'info', 'No profile changes to submit.');
      return res.redirect('/profile');
    }
    try {
      await sendCode(req, req.session.user.email, 'profile');
      req.session.pendingDoctorProfileChange = { userId: req.session.user.id, email: req.session.user.email, change };
      return res.redirect('/doctor/profile/change/verify');
    } catch (error) {
      setNotice(req, 'error', error.message || 'Could not send the profile confirmation code.');
      return res.redirect('/profile');
    }
  });

  get('/doctor/profile/change/verify', requireRole('doctor'), async (req, res) => {
    const pending = req.session.pendingDoctorProfileChange;
    if (!pending || Number(pending.userId) !== Number(req.session.user.id)) return res.redirect('/profile');
    const resendWaitSeconds = await getResendWaitSeconds(pending.email, 'profile').catch(() => 0);
    res.render('doctor-profile-verify', { email: pending.email, error: null, resendWaitSeconds, devOtp: req.session.devOtp });
  });

  post('/doctor/profile/change/resend', requireRole('doctor'), authLimit, async (req, res) => {
    const pending = req.session.pendingDoctorProfileChange;
    if (!pending || Number(pending.userId) !== Number(req.session.user.id)) return res.redirect('/profile');
    try { await sendCode(req, pending.email, 'profile'); setNotice(req, 'success', 'A new confirmation code was requested.'); }
    catch (error) { setNotice(req, 'error', error.message || 'Could not resend the code.'); }
    res.redirect('/doctor/profile/change/verify');
  });

  post('/doctor/profile/change/verify', requireRole('doctor'), authLimit, async (req, res) => {
    const pending = req.session.pendingDoctorProfileChange;
    const code = String(req.body.code || '').trim();
    if (!pending || Number(pending.userId) !== Number(req.session.user.id)) return res.redirect('/profile');
    if (!/^\d{6}$/.test(code)) return res.render('doctor-profile-verify', { email: pending.email, error: 'Enter the six-digit code.', resendWaitSeconds: await getResendWaitSeconds(pending.email, 'profile').catch(() => 0), devOtp: req.session.devOtp });
    try {
      const valid = await consumeCode(pending.email, 'profile', code, async (connection) => {
        const data = pending.change;
        const [owners] = await connection.execute("SELECT id FROM users WHERE id=? AND email=? AND role='doctor' AND email_verified=1 FOR UPDATE", [req.session.user.id, pending.email]);
        if (!owners.length) throw new Error('Doctor account verification no longer matches.');
        await connection.execute(`UPDATE users SET name=?,phone=?,city=?,specialization=?,qualification=?,registration_number=?,organization=?,consultation_fee=?,account_status='pending' WHERE id=? AND role='doctor'`, [data.name,data.phone,data.city||null,data.specialization,data.qualification,data.registration_number,data.organization||null,data.consultation_fee,req.session.user.id]);
        await connection.execute(`UPDATE provider_profiles SET registration_authority=?,years_experience=?,practice_address=?,state=?,bio=?,verification_status='PENDING',review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=UTC_TIMESTAMP() WHERE user_id=?`, [data.registration_authority,data.years_experience,data.practice_address||null,data.state||null,data.bio||null,req.session.user.id]);
        await connection.execute('INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)', [req.session.user.id,'doctor.profile.change.submitted','provider',req.session.user.id,JSON.stringify({emailVerified:true,submittedForAdminReview:true})]);
        await connection.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [req.session.user.id,'provider_review','Profile changes awaiting review','Your email-confirmed profile changes were submitted. Your directory listing and doctor tools stay pending until administrator review.']);
      });
      if (!valid) return res.render('doctor-profile-verify', { email: pending.email, error: 'The code is incorrect or expired. Request a new code and try again.', resendWaitSeconds: await getResendWaitSeconds(pending.email, 'profile').catch(() => 0), devOtp: req.session.devOtp });
      req.session.user.name = pending.change.name;
      req.session.user.status = 'pending';
      req.session.pendingDoctorProfileChange = null;
      req.session.devOtp = null;
      setNotice(req, 'success', 'Email verified. Changes were sent to the administrator; your doctor account is pending review.');
      res.redirect('/doctor/home');
    } catch (error) {
      console.error('Doctor profile change confirmation failed:', error.message);
      res.render('doctor-profile-verify', { email: pending.email, error: 'Could not confirm these changes. Please try again.', resendWaitSeconds: await getResendWaitSeconds(pending.email, 'profile').catch(() => 0), devOtp: req.session.devOtp });
    }
  });

  // Users can update only their own safe contact fields.
  post('/profile', requireAuth, authLimit, async (req, res) => {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const city = (req.body.city || '').trim();
    const state = String(req.body.state || '').trim().slice(0, 100);
    const phoneOk = /^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s()-]/g, ''));
    const isDoctor = req.session.user.role === 'doctor';
    if (isDoctor) {
      setNotice(req, 'error', 'Doctor profile changes need email confirmation and administrator review. Use the profile change form.');
      return res.redirect('/profile');
    }
    const selectedQualifications = (Array.isArray(req.body.doctorQualifications)
      ? req.body.doctorQualifications
      : req.body.doctorQualifications ? [req.body.doctorQualifications] : []);
    const specialty = String(req.body.specialization || '').trim();
    const organization = String(req.body.organization || '').trim().slice(0, 180);
    const validQualifications = selectedQualifications.length >= 1 && selectedQualifications.length <= 3
      && new Set(selectedQualifications).size === selectedQualifications.length
      && selectedQualifications.every((item) => doctorQualifications.includes(item));
    if (name.length < 2 || name.length > 100 || !phoneOk || city.length > 100
      || (isDoctor && (!validQualifications || !doctorSpecialties.includes(specialty)))) {
      setNotice(req, 'error', 'Name, phone number, or city is invalid.');
      return res.redirect('/profile');
    }
    try {
      if (isDoctor) {
        const qualification = selectedQualifications.join(' · ');
        const yearsValue = String(req.body.yearsExperience || '').trim();
        const years = yearsValue ? Number(yearsValue) : null;
        const practiceAddress = String(req.body.practiceAddress || '').trim().slice(0, 500) || null;
        const bio = String(req.body.bio || '').trim().slice(0, 2000) || null;
        const feeValue = String(req.body.consultationFee || '').trim();
        const fee = feeValue ? Number(feeValue) : null;
        if ((yearsValue && (!Number.isInteger(years) || years < 0 || years > 70))
          || (feeValue && (!Number.isFinite(fee) || fee < 0 || fee > 100000))) {
          throw new Error('Experience or consultation fee is invalid.');
        }
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [current] = await connection.execute('SELECT specialization,qualification,city FROM users WHERE id=? AND role=\'doctor\' FOR UPDATE', [req.session.user.id]);
          if (!current.length) throw new Error('Doctor account not found.');
          const credentialsChanged = current[0].specialization !== specialty || current[0].qualification !== qualification || current[0].city !== (city || null);
          await connection.execute('UPDATE users SET name=?,phone=?,city=?,specialization=?,qualification=?,consultation_fee=?,organization=? WHERE id=? AND role=\'doctor\'', [name, phone, city || null, specialty, qualification, fee, organization || null, req.session.user.id]);
          await connection.execute('UPDATE provider_profiles SET years_experience=?,practice_address=?,state=?,bio=? WHERE user_id=?', [years, practiceAddress, state || null, bio, req.session.user.id]);
          if (credentialsChanged) {
            await connection.execute("UPDATE provider_profiles SET verification_status='PENDING',review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=UTC_TIMESTAMP() WHERE user_id=?", [req.session.user.id]);
            await connection.execute('INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)', [req.session.user.id, 'doctor.credentials.updated', 'provider', req.session.user.id, JSON.stringify({ credentialsChanged: true })]);
          }
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      } else {
        await pool.execute('UPDATE users SET name=?,phone=?,city=? WHERE id=?', [name, phone, city || null, req.session.user.id]);
      }
      req.session.user.name = name;
      setNotice(req, 'success', isDoctor ? 'Your profile was updated. Changes to qualifications or specialty were sent for administrator review.' : 'Your profile was updated.');
    } catch (error) {
      console.error('Profile update failed:', error.message);
      setNotice(req, 'error', 'Profile could not be updated right now.');
    }
    res.redirect('/profile');
  });

  post('/profile/photo', requireRole('doctor', 'patient'), authLimit, async (req, res) => {
    const ownerId = req.session.user.id;
    const ownerRole = req.session.user.role;
    const imageData = typeof req.body.profileImageData === 'string' ? req.body.profileImageData : '';
    const removePhoto = req.body.removeProfilePhoto === '1';
    const redirectTo = '/profile';
    let savedPhotoUrl = null;

    if (!imageData && !removePhoto) {
      setNotice(req, 'info', 'Choose a new photo before saving your picture.');
      return res.redirect(redirectTo);
    }

    try {
      const [doctors] = await pool.execute(
        'SELECT profile_image_url FROM users WHERE id=? AND role=? LIMIT 1',
        [ownerId, ownerRole]
      );
      if (!doctors.length) {
        setNotice(req, 'error', 'Doctor account was not found.');
        return res.redirect(redirectTo);
      }

      if (removePhoto) {
        await pool.execute('UPDATE users SET profile_image_url=NULL WHERE id=? AND role=?', [ownerId, ownerRole]);
        await pool.execute('DELETE FROM profile_images WHERE user_id=?', [ownerId]);
        if (doctors[0].profile_image_url) await removeDoctorProfilePhoto(doctors[0].profile_image_url);
        setNotice(req, 'success', 'Profile photo removed. The default doctor avatar is now shown.');
        return res.redirect(redirectTo);
      }

      const nextPhotoUrl = await saveDoctorProfilePhoto(imageData, ownerId, ownerRole);
      savedPhotoUrl = nextPhotoUrl;
      await pool.execute(
        'UPDATE users SET profile_image_url=? WHERE id=? AND role=?',
        [nextPhotoUrl, ownerId, ownerRole]
      );
      if (doctors[0].profile_image_url && doctors[0].profile_image_url !== nextPhotoUrl) {
        await removeDoctorProfilePhoto(doctors[0].profile_image_url).catch((error) => {
          console.error('Could not remove superseded doctor photo:', error.message);
        });
      }
      setNotice(req, 'success', 'Your profile picture was updated.');
    } catch (error) {
      if (savedPhotoUrl) await removeDoctorProfilePhoto(savedPhotoUrl).catch(() => {});
      console.error('Doctor profile photo update failed:', error.message);
      setNotice(req, 'error', error.message.startsWith('Choose a valid')
        ? error.message
        : 'Your profile picture could not be updated. Please try again.');
    }
    res.redirect(redirectTo);
  });


  get('/hospital/home', requireRole('hospital'), async (req, res) => {
    const [rows] = await pool.execute(`SELECT u.id,u.name,u.email,u.phone,u.city,u.organization,u.account_status,h.registered_name,h.licence_number,h.address,h.state,h.postal_code,h.departments,h.services,h.facilities,h.accessibility,h.public_description,p.public_phone,p.verification_status,p.review_reason
      FROM users u JOIN provider_profiles p ON p.user_id=u.id LEFT JOIN hospitals h ON h.user_id=u.id WHERE u.id=? AND u.role='hospital'`, [req.session.user.id]);
    if (!rows.length || !rows[0].registered_name) return res.redirect('/provider/status');
    const hospital = rows[0];
    const hospitalApproved = hospital.verification_status === 'VERIFIED' && hospital.account_status === 'active';
    const [stats] = hospitalApproved ? await pool.execute(`SELECT
      (SELECT COUNT(*) FROM doctor_hospital_affiliations af JOIN users d ON d.id=af.doctor_id JOIN provider_profiles dp ON dp.user_id=d.id WHERE af.hospital_user_id=? AND af.status='APPROVED' AND d.account_status='active' AND dp.verification_status='VERIFIED') AS doctors,
      (SELECT COUNT(*) FROM appointments a JOIN doctor_hospital_affiliations af ON af.doctor_id=a.doctor_id AND af.hospital_user_id=? AND af.status='APPROVED' WHERE a.starts_at>=UTC_TIMESTAMP() AND a.status IN ('BOOKED','CONFIRMED')) AS upcoming_appointments,
      (SELECT COUNT(*) FROM appointments a JOIN doctor_hospital_affiliations af ON af.doctor_id=a.doctor_id AND af.hospital_user_id=? AND af.status='APPROVED' WHERE DATE(a.starts_at + INTERVAL 330 MINUTE)=DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE) AND a.status IN ('BOOKED','CONFIRMED')) AS today_appointments`, [hospital.id,hospital.id,hospital.id]) : [[{doctors:0,upcoming_appointments:0,today_appointments:0}]];
    const [doctors] = hospitalApproved ? await pool.execute(`SELECT d.id,d.name,d.specialization,d.qualification,d.profile_image_url,af.status
      FROM doctor_hospital_affiliations af JOIN users d ON d.id=af.doctor_id JOIN provider_profiles p ON p.user_id=d.id
      WHERE af.hospital_user_id=? AND af.status='APPROVED' AND d.account_status='active' AND p.verification_status='VERIFIED' ORDER BY d.name LIMIT 100`, [hospital.id]) : [[]];
    const [appointments] = hospitalApproved ? await pool.execute(`SELECT a.booking_reference,a.starts_at,a.status,a.consultation_type,d.name AS doctor_name
      FROM appointments a JOIN doctor_hospital_affiliations af ON af.doctor_id=a.doctor_id AND af.hospital_user_id=? AND af.status='APPROVED'
      JOIN users d ON d.id=a.doctor_id WHERE a.starts_at>=UTC_TIMESTAMP() AND a.status IN ('BOOKED','CONFIRMED') ORDER BY a.starts_at LIMIT 50`, [hospital.id]) : [[]];
    res.render('hospital-dashboard', { hospital, stats: stats[0], doctors, appointments, profileOnly: req.query.view === 'profile', sectionOnly: req.query.section === 'appointments' ? 'appointments' : null });
  });

  post('/hospital/profile', requireRole('hospital'), authLimit, async (req, res) => {
    const name = String(req.body.registeredName || '').trim().slice(0, 180);
    const licence = String(req.body.licenceNumber || '').trim().slice(0, 120);
    const address = String(req.body.address || '').trim().slice(0, 500);
    const city = String(req.body.city || '').trim().slice(0, 100);
    const phone = String(req.body.phone || '').trim();
    const state = String(req.body.state || '').trim().slice(0, 100);
    const postalCode = String(req.body.postalCode || '').trim().slice(0, 20);
    const representative = String(req.body.representativeName || '').trim().slice(0, 120);
    const departments = String(req.body.departments || '').trim().slice(0, 4000);
    const services = String(req.body.services || '').trim().slice(0, 4000);
    const facilities = String(req.body.facilities || '').trim().slice(0, 4000);
    const accessibility = String(req.body.accessibility || '').trim().slice(0, 4000);
    const description = String(req.body.description || '').trim().slice(0, 1000);
    if (name.length < 2 || !address || !city || !/^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s()-]/g, ''))) {
      setNotice(req, 'error', 'Enter the registered name, address, city, and a valid contact number.');
      return res.redirect('/hospital/home?view=profile#hospital-profile');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const publicPhone = req.body.publicPhone === 'on' ? 1 : 0;
      const [existing] = await connection.execute(`SELECT u.organization,u.city,u.phone,h.registered_name,h.licence_number,h.address,h.state,h.postal_code,h.representative_name,h.departments,h.services,h.facilities,h.accessibility,h.public_description,p.public_phone
        FROM users u JOIN hospitals h ON h.user_id=u.id JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='hospital' FOR UPDATE`, [req.session.user.id]);
      if (!existing.length) throw new Error('Hospital profile not found.');
      const before = existing[0];
      const after = [name, city, phone, name, licence || null, address, state || null, postalCode || null, representative || null, departments || null, services || null, facilities || null, accessibility || null, description || null, publicPhone];
      const current = [before.organization,before.city,before.phone,before.registered_name,before.licence_number,before.address,before.state,before.postal_code,before.representative_name,before.departments,before.services,before.facilities,before.accessibility,before.public_description,Number(before.public_phone)];
      const changed = after.some((value,index) => String(value ?? '') !== String(current[index] ?? ''));
      await connection.execute('UPDATE users SET organization=?,name=?,city=?,phone=?,account_status=IF(?=1,\'pending\',account_status) WHERE id=? AND role=\'hospital\'', [name,name,city,phone,changed?1:0,req.session.user.id]);
      await connection.execute('UPDATE hospitals SET registered_name=?,licence_number=?,address=?,state=?,postal_code=?,representative_name=?,departments=?,services=?,facilities=?,accessibility=?,public_description=? WHERE user_id=?', [...after.slice(3, 14), req.session.user.id]);
      await connection.execute('UPDATE provider_profiles SET public_phone=? WHERE user_id=?', [publicPhone, req.session.user.id]);
      if (changed) {
        await connection.execute("UPDATE provider_profiles SET verification_status='PENDING',review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=UTC_TIMESTAMP() WHERE user_id=?", [req.session.user.id]);
        await audit(connection, req.session.user.id, 'hospital.profile.updated', 'hospital', req.session.user.id);
      }
      await connection.commit();
      req.session.user.name = name;
      setNotice(req, 'success', changed ? 'Profile saved and sent for administrator review. Public discovery and hospital tools resume after approval.' : 'Hospital profile saved.');
    } catch (error) {
      await connection.rollback();
      console.error('Hospital profile update failed:', error.message);
      setNotice(req, 'error', 'Hospital profile could not be saved.');
    } finally { connection.release(); }
    res.redirect('/hospital/home?view=profile#hospital-profile');
  });

  // The directory only displays provider profiles approved by an administrator.
  get('/hospitals', async (req, res) => {
    const city = String(req.query.city || '').trim().slice(0, 100);
    const department = String(req.query.department || '').trim().slice(0, 100);
    const service = String(req.query.service || '').trim().slice(0, 100);
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const pageSize = 20;
    const offset = (page - 1) * pageSize;
    const [counts] = await pool.execute(
      `SELECT COUNT(*) AS total FROM hospitals h JOIN users u ON u.id=h.user_id JOIN provider_profiles p ON p.user_id=u.id
       WHERE p.verification_status='VERIFIED' AND u.account_status='active' AND u.email_verified=1
       AND (?='' OR u.city LIKE CONCAT('%',?,'%')) AND (?='' OR h.departments LIKE CONCAT('%',?,'%')) AND (?='' OR h.services LIKE CONCAT('%',?,'%'))`,
      [city, city, department, department, service, service]
    );
    const [rows] = await pool.execute(
      `SELECT u.id,h.registered_name,h.address,u.city,h.state,h.postal_code,h.departments,h.services,h.facilities,h.accessibility,h.public_description,IF(p.public_phone=1,u.phone,NULL) AS public_phone
       FROM hospitals h JOIN users u ON u.id=h.user_id JOIN provider_profiles p ON p.user_id=u.id
       WHERE p.verification_status='VERIFIED' AND u.account_status='active' AND u.email_verified=1
       AND (?='' OR u.city LIKE CONCAT('%',?,'%')) AND (?='' OR h.departments LIKE CONCAT('%',?,'%')) AND (?='' OR h.services LIKE CONCAT('%',?,'%'))
       ORDER BY h.registered_name LIMIT ${pageSize} OFFSET ${offset}`,
      [city, city, department, department, service, service]
    );
    const total = Number(counts[0].total);
    res.render('hospitals', { hospitals: rows, city, department, service, page, total, hasNext: offset + rows.length < total });
  });

  get('/doctors/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).render('not-found');
    const [doctors] = await pool.execute(
      `SELECT u.id,u.name,u.specialization,u.city,u.qualification,u.consultation_fee,u.profile_image_url,p.years_experience,p.practice_address,dpp.upi_id,dpp.qr_image_url
       FROM users u JOIN provider_profiles p ON p.user_id=u.id LEFT JOIN doctor_payment_profiles dpp ON dpp.doctor_id=u.id
       WHERE u.id=? AND u.role='doctor' AND u.email_verified=1 AND u.account_status='active' AND p.verification_status='VERIFIED'`,
      [id]
    );
    if (!doctors.length) return res.status(404).render('not-found');
    const [slots] = await pool.execute(
      `SELECT a.id,a.starts_at,a.ends_at,a.consultation_type,a.location FROM doctor_availability a
       WHERE a.doctor_id=? AND a.slot_status='AVAILABLE' AND a.starts_at>UTC_TIMESTAMP()
       AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.doctor_id=a.doctor_id AND b.status IN ('BOOKED','CONFIRMED') AND b.starts_at<a.ends_at AND b.ends_at>a.starts_at)
       ORDER BY a.starts_at LIMIT 100`,
      [id]
    );
    const [weeklySchedule] = await pool.execute(
      'SELECT weekday,TIME_FORMAT(starts_at,\'%H:%i\') AS starts_at,TIME_FORMAT(ends_at,\'%H:%i\') AS ends_at,appointment_minutes FROM doctor_weekly_schedule WHERE doctor_id=? ORDER BY weekday',
      [id]
    );
    const [onlineSchedule] = await pool.execute(
      'SELECT weekday,TIME_FORMAT(starts_at,\'%H:%i\') AS starts_at,TIME_FORMAT(ends_at,\'%H:%i\') AS ends_at,TIME_FORMAT(second_starts_at,\'%H:%i\') AS second_starts_at,TIME_FORMAT(second_ends_at,\'%H:%i\') AS second_ends_at FROM doctor_online_schedule WHERE doctor_id=? AND enabled=1 ORDER BY weekday',
      [id]
    );
    const [[onlineSetting]] = await pool.execute(`SELECT enabled,(NOT EXISTS (SELECT 1 FROM doctor_online_schedule x WHERE x.doctor_id=doctor_online_consult_settings.doctor_id AND x.enabled=1) OR EXISTS (SELECT 1 FROM doctor_online_schedule x WHERE x.doctor_id=doctor_online_consult_settings.doctor_id AND x.enabled=1 AND x.weekday=WEEKDAY(UTC_TIMESTAMP()+INTERVAL 330 MINUTE) AND ((TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)>=x.starts_at AND TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)<x.ends_at) OR (x.second_starts_at IS NOT NULL AND TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)>=x.second_starts_at AND TIME(UTC_TIMESTAMP()+INTERVAL 330 MINUTE)<x.second_ends_at))) AND NOT EXISTS (SELECT 1 FROM consultations busy WHERE busy.doctor_id=doctor_online_consult_settings.doctor_id AND busy.status IN ('REQUESTED','ACCEPTED','PAYMENT_PENDING','READY','ACTIVE','SETTLING')) AS in_schedule FROM doctor_online_consult_settings WHERE doctor_id=?`, [id]);
    const [[consultationSettings]] = await pool.execute('SELECT rate_per_minute,enabled FROM consultation_settings WHERE id=1');
    const onlineBookingEnabled=Boolean(onlineSetting?.enabled&&consultationSettings?.enabled);
    res.render('doctor-detail', { doctor: doctors[0], slots, weeklySchedule, onlineSchedule, onlineBookingEnabled, integrationConfigured: Boolean(process.env.PAYMENT_MODE==='MOCK' && onlineBookingEnabled && process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET), onlineAvailable:Boolean(onlineSetting?.enabled && onlineSetting?.in_schedule && consultationSettings?.enabled), consultationRate:Number(consultationSettings?.rate_per_minute||5) });
  });

  // Hospital and doctor roles are verified from the server-side session, never form fields.
  get('/provider/status', requireRole('doctor', 'hospital'), async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT p.verification_status,p.review_reason,p.submitted_at,p.reviewed_at,p.registration_authority,p.years_experience,p.practice_address,p.state,p.postal_code,
       u.specialization,u.qualification,u.registration_number,u.city,u.organization,h.registered_name AS hospital_name,h.licence_number AS hospital_licence,h.address AS hospital_address,h.departments,h.services,h.facilities,h.accessibility,h.representative_name
       FROM provider_profiles p JOIN users u ON u.id=p.user_id LEFT JOIN hospitals h ON h.user_id=u.id WHERE p.user_id=?`,
      [req.session.user.id]
    );
    const [reviews] = await pool.execute(
      'SELECT old_status,new_status,reason,created_at FROM provider_reviews WHERE provider_user_id=? ORDER BY id DESC LIMIT 20',
      [req.session.user.id]
    );
    const [documents] = ['doctor', 'hospital'].includes(req.session.user.role)
      ? await pool.execute('SELECT id,original_name,mime_type,file_size,submitted_at FROM provider_documents WHERE provider_user_id=? ORDER BY submitted_at DESC LIMIT 30', [req.session.user.id])
      : [[]];
    res.render('provider-status', { provider: rows[0] || null, reviews, documents });
  });

  post('/provider/verification/documents', requireRole('doctor', 'hospital'), authLimit, async (req, res) => {
    const [profileRows] = await pool.execute('SELECT verification_status FROM provider_profiles WHERE user_id=?', [req.session.user.id]);
    if (!profileRows.length || profileRows[0].verification_status === 'VERIFIED') {
      setNotice(req, 'error', 'This account does not need a verification document upload.');
      return res.redirect('/provider/status');
    }
    const fileData = String(req.body.providerFileData || '');
    const upload = decodeMedicalUpload(fileData);
    const suppliedName = String(req.body.originalName || '').trim().replace(/[\\/]/g, '_').slice(0, 180);
    if (!upload || !suppliedName) {
      setNotice(req, 'error', 'Choose a PDF, JPG, PNG or WebP verification document up to 5 MB.');
      return res.redirect('/provider/status');
    }
    const privateKey = `${crypto.randomBytes(24).toString('hex')}.${upload.extension}`;
    const folder = path.join(__dirname, '..', 'var', 'private-medical-records');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, privateKey), upload.buffer, { flag: 'wx', mode: 0o600 });
    try {
      const [saved] = await pool.execute('INSERT INTO provider_documents (provider_user_id,private_file_key,original_name,mime_type,file_size) VALUES (?,?,?,?,?)', [req.session.user.id, privateKey, suppliedName, upload.mime, upload.buffer.length]);
      await pool.execute("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id) VALUES (?,'provider.document.upload','provider_document',?)", [req.session.user.id, saved.insertId]);
      setNotice(req, 'success', 'Verification document submitted for review.');
    } catch (error) {
      await fs.unlink(path.join(folder, privateKey)).catch(() => {});
      throw error;
    }
    res.redirect('/provider/status');
  });

  get('/providers/documents/:id/file', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).render('not-found');
    const [rows] = await pool.execute('SELECT id,provider_user_id,private_file_key,mime_type,original_name FROM provider_documents WHERE id=? LIMIT 1', [id]);
    const document = rows[0];
    if (!document || (req.session.user.role !== 'admin' && Number(document.provider_user_id) !== Number(req.session.user.id))) return res.status(404).render('not-found');
    const file = path.join(__dirname, '..', 'var', 'private-medical-records', path.basename(document.private_file_key));
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', document.mime_type);
    res.set('Content-Disposition', `attachment; filename="${document.original_name.replace(/[^a-z0-9._-]/gi, '_')}"`);
    res.sendFile(file, (error) => { if (error && !res.headersSent) res.status(404).render('not-found'); });
  });

  post('/provider/resubmit', requireRole('hospital'), authLimit, async (req, res) => {
    const specialty = String(req.body.specialization || '').trim().slice(0, 120);
    const qualificationChoices = Array.isArray(req.body.doctorQualifications)
      ? req.body.doctorQualifications
      : req.body.doctorQualifications ? [req.body.doctorQualifications] : [];
    const qualification = req.session.user.role === 'doctor'
      ? qualificationChoices.join(' · ')
      : String(req.body.qualification || '').trim().slice(0, 180);
    const registrationNumber = String(req.body.registrationNumber || '').trim().slice(0, 100);
    const authority = String(req.body.registrationAuthority || '').trim().slice(0, 180);
    const city = String(req.body.city || '').trim().slice(0, 100);
    const address = String(req.body.practiceAddress || '').trim().slice(0, 500);
    if (req.session.user.role === 'doctor' && (qualificationChoices.length < 1 || qualificationChoices.length > 3 || new Set(qualificationChoices).size !== qualificationChoices.length || qualificationChoices.some((item) => !doctorQualifications.includes(item)) || !doctorSpecialties.includes(specialty))) {
      setNotice(req, 'error', 'Choose a listed specialty and 1–3 listed qualifications.');
      return res.redirect('/provider/status');
    }
    if (req.session.user.role !== 'hospital' && (!specialty || !qualification || !registrationNumber || !authority || !city)) {
      setNotice(req, 'error', 'Complete all required professional fields before resubmitting.');
      return res.redirect('/provider/status');
    }
    if (req.session.user.role === 'hospital' && (!String(req.body.organization || '').trim() || !String(req.body.hospitalAddress || '').trim() || !city)) {
      setNotice(req, 'error', 'Registered name, address, and city are required for a hospital application.');
      return res.redirect('/provider/status');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT verification_status FROM provider_profiles WHERE user_id=? FOR UPDATE', [req.session.user.id]);
      if (!rows.length || !['NEEDS_CORRECTION', 'REJECTED'].includes(rows[0].verification_status)) throw new Error('This application is not awaiting corrections.');
      await connection.execute(
        `UPDATE users SET specialization=?,qualification=?,registration_number=?,city=?,organization=? WHERE id=?`,
        [specialty || null, qualification || null, registrationNumber || null, city || null, String(req.body.organization || '').trim().slice(0, 180) || null, req.session.user.id]
      );
      await connection.execute(
        `UPDATE provider_profiles SET registration_authority=?,practice_address=?,state=?,postal_code=?,verification_status='PENDING',review_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,submitted_at=UTC_TIMESTAMP() WHERE user_id=?`,
        [authority || null, address || null, String(req.body.state || '').trim().slice(0, 100) || null, String(req.body.postalCode || '').trim().slice(0, 20) || null, req.session.user.id]
      );
      if (req.session.user.role === 'hospital') {
        await connection.execute('UPDATE hospitals SET registered_name=?,licence_number=?,address=?,state=?,postal_code=?,departments=?,services=?,facilities=?,accessibility=?,representative_name=? WHERE user_id=?', [String(req.body.organization || '').trim().slice(0, 180), String(req.body.hospitalLicence || '').trim().slice(0, 120) || null, String(req.body.hospitalAddress || '').trim().slice(0, 500), String(req.body.state || '').trim().slice(0, 100) || null, String(req.body.postalCode || '').trim().slice(0, 20) || null, String(req.body.departments || '').trim().slice(0, 1000) || null, String(req.body.services || '').trim().slice(0, 1000) || null, String(req.body.facilities || '').trim().slice(0, 1000) || null, String(req.body.accessibility || '').trim().slice(0, 1000) || null, String(req.body.representativeName || '').trim().slice(0, 120) || null, req.session.user.id]);
      }
      await audit(connection, req.session.user.id, 'provider.resubmit', 'provider', req.session.user.id);
      await connection.commit();
      setNotice(req, 'success', 'Your corrected application was resubmitted for review.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', error.message === 'This application is not awaiting corrections.' ? error.message : 'Application could not be resubmitted.');
    } finally {
      connection.release();
    }
    res.redirect('/provider/status');
  });

  get('/admin', requireRole('admin'), async (req, res) => {
    const [providers] = await pool.execute(
      `SELECT u.id,u.name,u.email,u.phone,u.role,u.organization,u.specialization,u.qualification,u.registration_number,u.city,
       p.registration_authority,p.years_experience,p.practice_address,p.state,p.postal_code,p.verification_status,p.submitted_at,p.review_reason,
       h.registered_name AS hospital_name,h.licence_number AS hospital_licence,h.address AS hospital_address,h.departments,h.services,h.facilities,h.accessibility,h.representative_name
       ,(SELECT d.id FROM provider_documents d WHERE d.provider_user_id=u.id ORDER BY d.submitted_at DESC LIMIT 1) AS latest_document_id
       FROM users u JOIN provider_profiles p ON p.user_id=u.id LEFT JOIN hospitals h ON h.user_id=u.id WHERE u.role IN ('doctor','hospital') AND p.verification_status IN ('PENDING','UNDER_REVIEW','NEEDS_CORRECTION','REJECTED') ORDER BY p.submitted_at LIMIT 200`
    );
    const [stats] = await pool.execute(
      `SELECT (SELECT COUNT(*) FROM users WHERE role='patient') patients,
       (SELECT COUNT(*) FROM users WHERE role='doctor') doctors,
       (SELECT COUNT(*) FROM users WHERE role='hospital') hospitals,
       (SELECT COUNT(*) FROM users WHERE role IN ('patient','doctor','hospital')) total_users,
       (SELECT COUNT(*) FROM appointments WHERE starts_at>=UTC_TIMESTAMP()) upcoming_appointments,
       (SELECT COUNT(*) FROM provider_profiles WHERE verification_status IN ('PENDING','UNDER_REVIEW','NEEDS_CORRECTION')) pending_reviews`
    );
    const [users] = await pool.execute("SELECT id,name,email,role,account_status,created_at FROM users WHERE role IN ('patient','doctor','hospital') ORDER BY created_at DESC LIMIT 100");
    const [affiliations] = await pool.execute(`SELECT af.id,af.status,d.name AS doctor_name,d.email AS doctor_email,h.registered_name AS hospital_name,h.user_id AS hospital_user_id
      FROM doctor_hospital_affiliations af JOIN users d ON d.id=af.doctor_id JOIN hospitals h ON h.user_id=af.hospital_user_id
      WHERE af.status='PENDING' ORDER BY af.created_at LIMIT 100`);
    const [contactMessages] = await pool.execute(
      `SELECT m.id,m.user_id,m.sender_role,m.sender_name,m.sender_email,m.sender_phone,m.category,m.message,m.status,m.created_at,
       e.original_name AS evidence_name,e.mime_type AS evidence_mime,e.file_size AS evidence_size
       FROM contact_messages m LEFT JOIN contact_message_evidence e ON e.message_id=m.id
       ORDER BY CASE m.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,m.created_at DESC LIMIT 100`
    );
    if (contactMessages.length) {
      const ids = contactMessages.map((message) => Number(message.id));
      const placeholders = ids.map(() => '?').join(',');
      const [contactReplies] = await pool.execute(
        `SELECT id,message_id,reply_text,delivery_status,created_at FROM contact_message_replies WHERE message_id IN (${placeholders}) ORDER BY created_at`,
        ids
      );
      const repliesByMessage = new Map();
      for (const reply of contactReplies) {
        if (!repliesByMessage.has(Number(reply.message_id))) repliesByMessage.set(Number(reply.message_id), []);
        repliesByMessage.get(Number(reply.message_id)).push(reply);
      }
      for (const message of contactMessages) message.replies = repliesByMessage.get(Number(message.id)) || [];
    } else {
      for (const message of contactMessages) message.replies = [];
    }
    res.render('admin', { providers, stats: stats[0], users, affiliations, contactMessages });
  });

  post('/admin/affiliations/:id/review', requireRole('admin'), authLimit, async (req, res) => {
    const affiliationId = Number(req.params.id);
    const status = String(req.body.status || '');
    if (!Number.isSafeInteger(affiliationId) || affiliationId < 1 || !['APPROVED', 'REJECTED'].includes(status)) {
      setNotice(req, 'error', 'Invalid affiliation decision.');
      return res.redirect('/admin');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT id,doctor_id,hospital_user_id FROM doctor_hospital_affiliations WHERE id=? AND status='PENDING' FOR UPDATE", [affiliationId]);
      if (!rows.length) throw new Error('Affiliation request is no longer pending.');
      await connection.execute('UPDATE doctor_hospital_affiliations SET status=? WHERE id=?', [status, affiliationId]);
      await notify(connection, rows[0].doctor_id, 'affiliation', 'Hospital affiliation reviewed', `The affiliation request was ${status.toLowerCase()}.`);
      await notify(connection, rows[0].hospital_user_id, 'affiliation', 'Affiliation request reviewed', `A doctor affiliation request was ${status.toLowerCase()}.`);
      await audit(connection, req.session.user.id, 'doctor.affiliation.review', 'doctor_hospital_affiliation', affiliationId, { status });
      await connection.commit();
      setNotice(req, 'success', `Affiliation marked ${status.toLowerCase()}.`);
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Affiliation decision could not be saved.');
    } finally { connection.release(); }
    res.redirect('/admin');
  });

  post('/admin/users/:id/status', requireRole('admin'), authLimit, async (req, res) => {
    const userId = Number(req.params.id);
    const status = String(req.body.status || '');
    if (!Number.isSafeInteger(userId) || userId < 1 || !['active', 'suspended'].includes(status) || userId === Number(req.session.user.id)) {
      setNotice(req, 'error', 'Invalid account management request.');
      return res.redirect('/admin');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT id,role,account_status FROM users WHERE id=? AND role<>'admin' FOR UPDATE", [userId]);
      if (!rows.length) throw new Error('Account not found.');
      await connection.execute('UPDATE users SET account_status=? WHERE id=?', [status, userId]);
      await audit(connection, req.session.user.id, 'user.status', 'user', userId, { status });
      await notify(connection, userId, 'account', 'Account status updated', `Your account status is now ${status}.`);
      await connection.commit();
      setNotice(req, 'success', `Account marked ${status}.`);
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Account status could not be changed.');
    } finally {
      connection.release();
    }
    res.redirect('/admin');
  });

  get('/admin/audit', requireRole('admin'), async (req, res) => {
    const query = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const limit = 50;
    const offset = (page - 1) * limit;
    const [logs] = await pool.execute(
      `SELECT a.id,a.actor_id,a.action,a.entity_type,a.entity_id,a.details_json,a.created_at,u.name AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
       WHERE (?='' OR a.action LIKE CONCAT('%',?,'%') OR a.entity_type LIKE CONCAT('%',?,'%'))
       ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`,
      [query, query, query]
    );
    res.render('audit', { logs, query, page, hasNext: logs.length === limit });
  });

  post('/admin/providers/:id/review', requireRole('admin'), authLimit, async (req, res) => {
    const providerId = Number(req.params.id);
    const status = String(req.body.status || '');
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (!Number.isSafeInteger(providerId) || providerId < 1 || !allowedReviewStates.has(status)) {
      setNotice(req, 'error', 'Invalid provider review request.');
      return res.redirect('/admin');
    }
    if (['REJECTED', 'NEEDS_CORRECTION'].includes(status) && reason.length < 5) {
      setNotice(req, 'error', 'Provide a clear reason when rejecting or requesting corrections.');
      return res.redirect('/admin');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT p.verification_status,u.role FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=? FOR UPDATE',
        [providerId]
      );
      if (!rows.length) throw new Error('Provider application not found.');
      const oldStatus = rows[0].verification_status;
      await connection.execute(
        'UPDATE provider_profiles SET verification_status=?,review_reason=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP() WHERE user_id=?',
        [status, reason || null, req.session.user.id, providerId]
      );
      await connection.execute(
        'UPDATE users SET account_status=? WHERE id=?',
        [status === 'VERIFIED' ? 'active' : 'pending', providerId]
      );
      await connection.execute(
        'INSERT INTO provider_reviews (provider_user_id,reviewer_id,old_status,new_status,reason) VALUES (?,?,?,?,?)',
        [providerId, req.session.user.id, oldStatus, status, reason || null]
      );
      await notify(connection, providerId, 'provider_review', 'Application status updated', `Your provider application status is now ${status}. ${reason}`.trim());
      await audit(connection, req.session.user.id, 'provider.review', 'provider', providerId, { from: oldStatus, to: status });
      await connection.commit();
      setNotice(req, 'success', `Application updated to ${status}.`);
    } catch (error) {
      await connection.rollback();
      console.error('Provider review failed:', error.message);
      setNotice(req, 'error', 'Application review could not be saved.');
    } finally {
      connection.release();
    }
    res.redirect('/admin');
  });

  post('/doctor/availability', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const startsAt = utcSqlDate(req.body.startsAt);
    const endsAt = utcSqlDate(req.body.endsAt);
    const type = req.body.consultationType === 'online' ? 'online' : 'in_person';
    const location = String(req.body.location || '').trim().slice(0, 300) || null;
    if (!startsAt || !endsAt || new Date(`${endsAt.replace(' ', 'T')}Z`) <= new Date(`${startsAt.replace(' ', 'T')}Z`) || new Date(`${startsAt.replace(' ', 'T')}Z`) <= new Date()) {
      setNotice(req, 'error', 'Choose a valid future start and end time.');
      return res.redirect('/doctor/home#doctor-schedule');
    }
    if (type === 'online') {
      setNotice(req, 'error', 'Online consultation is unavailable until a secure video provider is configured.');
      return res.redirect('/doctor/home#doctor-schedule');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [provider] = await connection.execute(
        "SELECT u.id FROM users u JOIN provider_profiles p ON p.user_id=u.id WHERE u.id=? AND u.account_status='active' AND p.verification_status='VERIFIED' FOR UPDATE",
        [req.session.user.id]
      );
      if (!provider.length) throw new Error('Your provider account is not verified.');
      const localDate = indiaDateKey(new Date(`${startsAt.replace(' ', 'T')}Z`));
      const [leave] = await connection.execute('SELECT id FROM doctor_unavailable_dates WHERE doctor_id=? AND unavailable_date=?', [req.session.user.id, localDate]);
      if (leave.length) throw new Error('You marked this date as unavailable.');
      const [overlaps] = await connection.execute(
        'SELECT id FROM doctor_availability WHERE doctor_id=? AND starts_at<? AND ends_at>? FOR UPDATE',
        [req.session.user.id, endsAt, startsAt]
      );
      if (overlaps.length) throw new Error('This time overlaps an existing slot.');
      await connection.execute(
        'INSERT INTO doctor_availability (doctor_id,starts_at,ends_at,consultation_type,location) VALUES (?,?,?,?,?)',
        [req.session.user.id, startsAt, endsAt, type, location]
      );
      await audit(connection, req.session.user.id, 'availability.create', 'doctor_availability', null);
      await connection.commit();
      setNotice(req, 'success', 'Availability slot added.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', ['This time overlaps an existing slot.', 'You marked this date as unavailable.'].includes(error.message) ? error.message : 'Availability could not be saved. Check your verification status and time.');
    } finally {
      connection.release();
    }
    res.redirect('/doctor/home#doctor-schedule');
  });

  post('/doctor/availability/:id/block', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    try {
      const [result] = await pool.execute(
        `UPDATE doctor_availability a SET slot_status='BLOCKED' WHERE a.id=? AND a.doctor_id=?
         AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.availability_id=a.id AND b.status IN ('BOOKED','CONFIRMED'))`,
        [Number(req.params.id), req.session.user.id]
      );
      setNotice(req, result.affectedRows ? 'success' : 'error', result.affectedRows ? 'Slot blocked.' : 'That slot cannot be blocked because it may already be booked.');
    } catch (error) {
      console.error('Block availability failed:', error.message);
      setNotice(req, 'error', 'Slot could not be blocked.');
    }
    res.redirect('/doctor/home#doctor-schedule');
  });

  post('/doctor/schedule', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const weekdays = [...new Set((Array.isArray(req.body.weekdays) ? req.body.weekdays : req.body.weekdays ? [req.body.weekdays] : []).map(Number))];
    const start = String(req.body.scheduleStart || '');
    const end = String(req.body.scheduleEnd || '');
    const duration = Number(req.body.appointmentMinutes);
    const breakStart = String(req.body.breakStart || '');
    const breakEnd = String(req.body.breakEnd || '');
    const timeOk = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    let validationMessage = '';
    if (!weekdays.length) validationMessage = 'Select at least one working day.';
    else if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) validationMessage = 'Select valid working days.';
    else if (!timeOk(start) || !timeOk(end)) validationMessage = 'Enter both a valid start time and end time.';
    else if (start >= end) validationMessage = 'End time must be later than start time.';
    else if (![15,30,45,60].includes(duration)) validationMessage = 'Choose an appointment duration of 15, 30, 45 or 60 minutes.';
    else if (Boolean(breakStart) !== Boolean(breakEnd)) validationMessage = 'For a break, enter both start and end times; otherwise leave both blank.';
    else if (breakStart && (!timeOk(breakStart) || !timeOk(breakEnd) || breakStart >= breakEnd || breakStart < start || breakEnd > end)) validationMessage = 'Break must start after clinic opening, end after its start, and finish by clinic closing.';
    if (validationMessage) {
      setNotice(req, 'error', validationMessage);
      return res.redirect('/doctor/home#doctor-schedule');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const placeholders = weekdays.map(() => '?').join(',');
      await connection.execute(`DELETE FROM doctor_weekly_schedule WHERE doctor_id=? AND weekday NOT IN (${placeholders})`, [req.session.user.id, ...weekdays]);
      await connection.execute(`UPDATE doctor_availability da SET slot_status='BLOCKED'
        WHERE da.doctor_id=? AND da.source='weekly' AND da.starts_at>UTC_TIMESTAMP() AND da.slot_status='AVAILABLE'
        AND NOT EXISTS (SELECT 1 FROM appointments ap WHERE ap.availability_id=da.id AND ap.status IN ('BOOKED','CONFIRMED'))`, [req.session.user.id]);
      for (const weekday of weekdays) {
        await connection.execute(`INSERT INTO doctor_weekly_schedule (doctor_id,weekday,starts_at,ends_at,appointment_minutes,break_starts_at,break_ends_at)
          VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE starts_at=VALUES(starts_at),ends_at=VALUES(ends_at),appointment_minutes=VALUES(appointment_minutes),break_starts_at=VALUES(break_starts_at),break_ends_at=VALUES(break_ends_at)`,
        [req.session.user.id, weekday, `${start}:00`, `${end}:00`, duration, breakStart ? `${breakStart}:00` : null, breakEnd ? `${breakEnd}:00` : null]);
      }
      const [profile] = await connection.execute('SELECT organization FROM users WHERE id=? AND role=\'doctor\'', [req.session.user.id]);
      const location = String(req.body.location || profile[0]?.organization || '').trim().slice(0, 300) || null;
      let created = 0;
      for (let offset = 1; offset <= 7; offset += 1) {
        const date = new Date(`${indiaDateKey()}T00:00:00Z`);
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() + offset);
        if (!weekdays.includes(date.getUTCDay())) continue;
        const dateKey = date.toISOString().slice(0, 10);
        const [leave] = await connection.execute('SELECT id FROM doctor_unavailable_dates WHERE doctor_id=? AND unavailable_date=?', [req.session.user.id, dateKey]);
        if (leave.length) continue;
        const cursor = indiaLocalToUtc(dateKey, start);
        const finish = indiaLocalToUtc(dateKey, end);
        const breakFrom = breakStart ? indiaLocalToUtc(dateKey, breakStart) : null;
        const breakTo = breakEnd ? indiaLocalToUtc(dateKey, breakEnd) : null;
        while (cursor.getTime() + duration * 60000 <= finish.getTime()) {
          const slotEnd = new Date(cursor.getTime() + duration * 60000);
          if (!(breakFrom && cursor < breakTo && slotEnd > breakFrom)) {
            const sqlStart = cursor.toISOString().slice(0, 19).replace('T', ' ');
            const sqlEnd = slotEnd.toISOString().slice(0, 19).replace('T', ' ');
            const [exact] = await connection.execute('SELECT id,source FROM doctor_availability WHERE doctor_id=? AND starts_at=? FOR UPDATE', [req.session.user.id, sqlStart]);
            if (exact.length) {
              if (exact[0].source === 'weekly') {
                const [updated] = await connection.execute("UPDATE doctor_availability da SET ends_at=?,location=?,slot_status='AVAILABLE' WHERE id=? AND NOT EXISTS (SELECT 1 FROM appointments ap WHERE ap.availability_id=da.id AND ap.status IN ('BOOKED','CONFIRMED'))", [sqlEnd, location, exact[0].id]);
                created += updated.affectedRows;
              }
            } else {
              const [overlap] = await connection.execute("SELECT id FROM doctor_availability WHERE doctor_id=? AND starts_at<? AND ends_at>? AND NOT (source='weekly' AND slot_status='BLOCKED') LIMIT 1 FOR UPDATE", [req.session.user.id, sqlEnd, sqlStart]);
              const [booked] = await connection.execute("SELECT id FROM appointments WHERE doctor_id=? AND status IN ('BOOKED','CONFIRMED') AND starts_at<? AND ends_at>? LIMIT 1 FOR UPDATE", [req.session.user.id, sqlEnd, sqlStart]);
              if (!overlap.length && !booked.length) {
                await connection.execute("INSERT INTO doctor_availability (doctor_id,starts_at,ends_at,consultation_type,location,source) VALUES (?,?,?,'in_person',?,'weekly')", [req.session.user.id, sqlStart, sqlEnd, location]);
                created += 1;
              }
            }
          }
          cursor.setTime(cursor.getTime() + duration * 60000);
        }
      }
      const [[slotSummary]] = await connection.execute(`SELECT COUNT(*) AS total FROM doctor_availability da
        WHERE da.doctor_id=? AND da.source='weekly' AND da.slot_status='AVAILABLE'
        AND da.starts_at>=UTC_TIMESTAMP() AND da.starts_at<UTC_TIMESTAMP()+INTERVAL 7 DAY
        AND NOT EXISTS (SELECT 1 FROM appointments ap WHERE ap.availability_id=da.id AND ap.status IN ('BOOKED','CONFIRMED'))`, [req.session.user.id]);
      const availableSlots = Number(slotSummary?.total || 0);
      await audit(connection, req.session.user.id, 'doctor.schedule.update', 'doctor_weekly_schedule', req.session.user.id, { weekdays, duration, generated: created, availableNext7Days: availableSlots });
      await connection.commit();
      setNotice(req, 'success', `Schedule saved. ${availableSlots} bookable appointment slots are available over the next 7 days. Existing bookings were preserved.`);
    } catch (error) {
      await connection.rollback();
      console.error('Doctor schedule update failed:', error.message);
      setNotice(req, 'error', 'Schedule could not be saved. Existing appointment times have been preserved.');
    } finally { connection.release(); }
    res.redirect('/doctor/home#doctor-schedule');
  });

  post('/doctor/leave', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const date = String(req.body.unavailableDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= indiaDateKey()) {
      setNotice(req, 'error', 'Choose a valid future leave date.');
      return res.redirect('/doctor/home#doctor-schedule');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const dayStart = indiaLocalToUtc(date, '00:00').toISOString().slice(0,19).replace('T',' ');
      const nextDay = new Date(indiaLocalToUtc(date, '00:00').getTime() + 24*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      const [booked] = await connection.execute("SELECT id FROM appointments WHERE doctor_id=? AND status IN ('BOOKED','CONFIRMED') AND starts_at>=? AND starts_at<? FOR UPDATE", [req.session.user.id, dayStart, nextDay]);
      if (booked.length) throw new Error('This date has pending or confirmed appointments. Reschedule or resolve them first.');
      await connection.execute('INSERT INTO doctor_unavailable_dates (doctor_id,unavailable_date,reason) VALUES (?,?,?) ON DUPLICATE KEY UPDATE reason=VALUES(reason)', [req.session.user.id, date, String(req.body.reason || '').trim().slice(0, 180) || null]);
      await connection.execute("UPDATE doctor_availability SET slot_status='BLOCKED' WHERE doctor_id=? AND starts_at>=? AND starts_at<? AND slot_status='AVAILABLE'", [req.session.user.id, dayStart, nextDay]);
      await connection.commit();
      setNotice(req, 'success', 'Leave date saved and open slots were blocked.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', error.message.startsWith('This date') ? error.message : 'Leave date could not be saved.');
    } finally { connection.release(); }
    res.redirect('/doctor/home#doctor-schedule');
  });

  post('/appointments', requireRole('patient'), authLimit, async (req, res) => {
    const availabilityId = Number(req.body.availabilityId);
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const paymentMethod = String(req.body.paymentMethod || 'CASH').toUpperCase();
    if (!Number.isSafeInteger(availabilityId) || availabilityId < 1 || reason.length < 3 || !['CASH','UPI'].includes(paymentMethod)) {
      setNotice(req, 'error', 'Choose an available clinic time, payment method, and enter a short reason for the visit.');
      return res.redirect('/doctors');
    }
    const connection = await pool.getConnection();
    let appointmentId = null;
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [req.session.user.id]);
      const [slots] = await connection.execute(
        `SELECT a.*,u.consultation_fee,dpp.upi_id,dpp.qr_image_url FROM doctor_availability a JOIN users u ON u.id=a.doctor_id JOIN provider_profiles p ON p.user_id=u.id
         LEFT JOIN doctor_payment_profiles dpp ON dpp.doctor_id=u.id
         WHERE a.id=? AND a.slot_status='AVAILABLE' AND a.starts_at>UTC_TIMESTAMP() AND u.account_status='active' AND p.verification_status='VERIFIED' FOR UPDATE`,
        [availabilityId]
      );
      const slot = slots[0];
      if (!slot) throw new Error('That appointment time is no longer available.');
      const [conflicts] = await connection.execute(
        "SELECT id FROM appointments WHERE (doctor_id=? OR patient_id=?) AND status IN ('BOOKED','CONFIRMED') AND starts_at<? AND ends_at>? FOR UPDATE",
        [slot.doctor_id, req.session.user.id, slot.ends_at, slot.starts_at]
      );
      if (conflicts.length) throw new Error('That appointment time has just been booked. Please choose another.');
      if (slot.consultation_type !== 'in_person') throw new Error('Use the online consultation request flow for video appointments.');
      const bookingReference = reference();
      const fee = Math.max(0, Number(slot.consultation_fee) || 0);
      if (paymentMethod === 'UPI' && (!slot.upi_id || !slot.qr_image_url || fee <= 0)) throw new Error('This doctor has not completed UPI payment setup. Choose cash at the clinic.');
      const appointmentStatus = paymentMethod === 'CASH' ? 'CONFIRMED' : 'BOOKED';
      const paymentStatus = paymentMethod === 'CASH' ? 'CASH_DUE' : 'PENDING';
      const [result] = await connection.execute(
        `INSERT INTO appointments
         (booking_reference,patient_id,doctor_id,created_by_user_id,availability_id,starts_at,ends_at,consultation_type,reason,status,payment_method,payment_status,payment_amount)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [bookingReference, req.session.user.id, slot.doctor_id, req.session.user.id, slot.id, slot.starts_at, slot.ends_at, slot.consultation_type, reason, appointmentStatus, paymentMethod, paymentStatus, fee.toFixed(2)]
      );
      appointmentId = result.insertId;
      if (paymentMethod === 'CASH') {
        await notify(connection, slot.doctor_id, 'appointment', 'New confirmed clinic appointment', `A patient booked an in-person appointment for ${slot.starts_at}. Booking ${bookingReference}.`);
        await notify(connection, req.session.user.id, 'appointment', 'Clinic appointment confirmed', `Your appointment is confirmed. Booking reference: ${bookingReference}. Pay ₹${fee.toFixed(2)} in cash at the clinic.`);
      } else {
        await notify(connection, slot.doctor_id, 'appointment', 'UPI payment is awaiting patient confirmation', `The patient selected UPI for booking ${bookingReference}.`);
        await notify(connection, req.session.user.id, 'appointment', 'UPI details ready', `Open the UPI payment page to view the doctor's payment details for booking ${bookingReference}.`);
      }
      await audit(connection, req.session.user.id, 'appointment.book', 'appointment', result.insertId, { doctorId: slot.doctor_id, bookingReference, paymentMethod, paymentAmount: fee });
      await connection.commit();
      if (paymentMethod === 'CASH') setNotice(req, 'success', `Appointment confirmed. Booking reference: ${bookingReference}. Your clinic proof is ready in the patient dashboard.`);
      else setNotice(req, 'success', `Your appointment is reserved. Complete the demo UPI step to confirm booking ${bookingReference}.`);
    } catch (error) {
      await connection.rollback();
      const known = ['That appointment time is no longer available.', 'That appointment time has just been booked. Please choose another.', 'Use the online consultation request flow for video appointments.', 'This doctor has not completed UPI payment setup. Choose cash at the clinic.'];
      setNotice(req, 'error', known.includes(error.message) ? error.message : 'Booking failed. Please try again.');
    } finally {
      connection.release();
    }
    if (appointmentId && paymentMethod === 'UPI') return res.redirect(`/appointments/${appointmentId}/pay`);
    res.redirect('/dashboard#patient-appointments');
  });

  get('/appointments/:id/pay', requireRole('patient'), async (req, res) => {
    const appointmentId=Number(req.params.id);
    if(!Number.isSafeInteger(appointmentId)||appointmentId<1)return res.status(404).render('not-found');
    const [rows] = await pool.execute(`SELECT a.id,a.booking_reference,a.starts_at,a.ends_at,a.status,a.payment_status,a.payment_amount,a.mock_payment_reference,
      d.name AS doctor_name,d.specialization,d.profile_image_url AS doctor_photo,dpp.upi_id,dpp.qr_image_url
      FROM appointments a JOIN users d ON d.id=a.doctor_id JOIN doctor_payment_profiles dpp ON dpp.doctor_id=d.id
      WHERE a.id=? AND a.patient_id=? AND a.payment_method='UPI' LIMIT 1`, [appointmentId, req.session.user.id]);
    const appointment = rows[0];
    if (!appointment) return res.status(404).render('not-found');
    if (appointment.payment_status === 'PAID') return res.redirect(`/appointments/${appointment.id}/confirmation`);
    if (appointment.payment_status !== 'PENDING' || appointment.status !== 'BOOKED') return res.status(409).send('This appointment is not waiting for UPI payment.');
    res.render('appointment-payment', { appointment });
  });

  post('/appointments/:id/payment/mock-complete', requireRole('patient'), authLimit, async (req, res) => {
    const appointmentId = Number(req.params.id);
    if (!Number.isSafeInteger(appointmentId)||appointmentId<1)return res.status(404).render('not-found');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT * FROM appointments WHERE id=? AND patient_id=? FOR UPDATE', [appointmentId, req.session.user.id]);
      const appointment = rows[0];
      if (!appointment || appointment.payment_method !== 'UPI') throw new Error('UPI appointment not found.');
      if (appointment.payment_status === 'PAID' && appointment.mock_payment_reference) {
        await connection.rollback();
        return res.redirect(`/appointments/${appointmentId}/confirmation`);
      }
      if (appointment.status !== 'BOOKED' || appointment.payment_status !== 'PENDING') throw new Error('This UPI payment is no longer pending.');
      const mockReference = `DEMO-UPI-${reference()}`;
      await connection.execute("UPDATE appointments SET status='CONFIRMED',payment_status='PAID',mock_payment_reference=? WHERE id=?", [mockReference, appointment.id]);
      await notify(connection, appointment.patient_id, 'appointment', 'Demo UPI payment recorded', `The demo payment step for booking ${appointment.booking_reference} is complete. This does not verify a real bank transfer.`);
      await notify(connection, appointment.doctor_id, 'appointment', 'Demo UPI appointment confirmed', `A patient completed the demo payment step for booking ${appointment.booking_reference}.`);
      await audit(connection, req.session.user.id, 'appointment.payment.mock_completed', 'appointment', appointment.id, { gateway: 'mock_upi', mock: true, amount: appointment.payment_amount });
      await connection.commit();
      return res.redirect(`/appointments/${appointment.id}/confirmation`);
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Demo UPI payment could not be recorded. Return to your dashboard and retry.');
      return res.redirect(`/appointments/${appointmentId}/pay`);
    } finally { connection.release(); }
  });

  get('/appointments/:id/confirmation', requireRole('patient'), async (req, res) => {
    const appointmentId=Number(req.params.id);
    if(!Number.isSafeInteger(appointmentId)||appointmentId<1)return res.status(404).render('not-found');
    const [rows] = await pool.execute(`SELECT a.*,DATE_FORMAT(a.starts_at,'%Y-%m-%d %H:%i:%s') AS starts_at_utc,DATE_FORMAT(a.ends_at,'%Y-%m-%d %H:%i:%s') AS ends_at_utc,
      d.name AS doctor_name,d.specialization,d.qualification,d.profile_image_url AS doctor_photo,d.organization AS clinic_name,
      p.name AS patient_name,p.email AS patient_email,da.location AS clinic_location
      FROM appointments a JOIN users d ON d.id=a.doctor_id JOIN users p ON p.id=a.patient_id LEFT JOIN doctor_availability da ON da.id=a.availability_id
      WHERE a.id=? AND a.patient_id=? AND a.consultation_type='in_person' LIMIT 1`, [appointmentId, req.session.user.id]);
    const appointment = rows[0];
    if (!appointment) return res.status(404).render('not-found');
    if (appointment.status === 'BOOKED' && appointment.payment_method === 'UPI' && appointment.payment_status === 'PENDING') return res.redirect(`/appointments/${appointment.id}/pay`);
    if (appointment.status !== 'CONFIRMED') return res.status(409).send('Only a confirmed appointment has a clinic visit proof.');
    res.render('appointment-confirmation', { appointment });
  });

  get('/appointments/:id/proof.pdf', requireRole('patient'), async (req, res) => {
    const appointmentId = Number(req.params.id);
    if (!Number.isSafeInteger(appointmentId) || appointmentId < 1) return res.status(404).render('not-found');
    const [rows] = await pool.execute(`SELECT a.booking_reference,a.starts_at,a.ends_at,a.status,a.payment_method,a.payment_status,a.payment_amount,a.reason,a.mock_payment_reference,
      d.name AS doctor_name,d.specialization,d.qualification,d.organization AS clinic_name,p.name AS patient_name,da.location AS clinic_location
      FROM appointments a JOIN users d ON d.id=a.doctor_id JOIN users p ON p.id=a.patient_id LEFT JOIN doctor_availability da ON da.id=a.availability_id
      WHERE a.id=? AND a.patient_id=? AND a.consultation_type='in_person' LIMIT 1`, [appointmentId, req.session.user.id]);
    const item = rows[0];
    if (!item) return res.status(404).render('not-found');
    if (item.status !== 'CONFIRMED') return res.status(409).send('Only a confirmed appointment has a downloadable proof.');
    const starts = item.starts_at instanceof Date ? item.starts_at : new Date(`${String(item.starts_at).replace(' ','T')}Z`);
    const ends = item.ends_at instanceof Date ? item.ends_at : new Date(`${String(item.ends_at).replace(' ','T')}Z`);
    const lines = [
      `Booking reference: ${item.booking_reference}`,
      `Status: CONFIRMED`,
      `Appointment type: Face to face`,
      `Patient: ${item.patient_name}`,
      `Doctor: ${item.doctor_name}`,
      `Specialty: ${item.specialization || 'Doctor'}`,
      `Qualification: ${item.qualification || 'Not provided'}`,
      `Date and time: ${starts.toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`,
      `Duration: ${Math.max(1,Math.round((ends-starts)/60000))} minutes`,
      `Clinic: ${item.clinic_name || item.doctor_name}`,
      `Location: ${item.clinic_location || 'Confirm with the clinic'}`,
      `Fee: INR ${Number(item.payment_amount || 0).toFixed(2)}`,
      `Payment: ${item.payment_method === 'CASH' ? 'Cash due at clinic' : item.payment_status === 'PAID' ? 'Mock UPI payment recorded' : 'Pending'}`,
      `Payment reference: ${item.mock_payment_reference || 'None'}`,
      `Visit reason: ${item.reason || 'Not provided'}`,
      'Show this proof and a photo ID at the clinic.',
      'Mock UPI is a demo record and does not confirm a real bank transfer.',
    ];
    const pdf = proofPdf(lines);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="appointment-${item.booking_reference}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.send(pdf);
  });

  post('/appointments/:id/cancel', requireRole('patient'), authLimit, async (req, res) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id,doctor_id,starts_at,status,payment_method,payment_status FROM appointments WHERE id=? AND patient_id=? FOR UPDATE',
        [Number(req.params.id), req.session.user.id]
      );
      const appointment = rows[0];
      if (!appointment || !activeAppointmentStates.includes(appointment.status)) throw new Error('This appointment cannot be cancelled.');
      const unpaidOnlineBooking = appointment.payment_method==='UPI'&&appointment.payment_status==='PENDING';
      const cutoffHours = Math.min(168, Math.max(0, Number(process.env.CANCELLATION_CUTOFF_HOURS || 24)));
      const start = new Date(`${String(appointment.starts_at).replace(' ', 'T')}Z`);
      if (!unpaidOnlineBooking && start.getTime() - Date.now() < cutoffHours * 3600000) throw new Error(`Appointments must be cancelled at least ${cutoffHours} hours in advance.`);
      await connection.execute("UPDATE appointments SET status='CANCELLED',payment_status=IF(payment_status='PENDING','EXPIRED',payment_status) WHERE id=?", [appointment.id]);
      await notify(connection, req.session.user.id, 'appointment', 'Appointment cancelled', 'Your appointment was cancelled.');
      await notify(connection, appointment.doctor_id, 'appointment', 'Patient cancelled an appointment', 'A patient cancelled an appointment. Review your schedule.');
      await audit(connection, req.session.user.id, 'appointment.cancel', 'appointment', appointment.id);
      await connection.commit();
      setNotice(req, 'success', 'Appointment cancelled.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', error.message.startsWith('Appointments must') ? error.message : 'This appointment could not be cancelled.');
    } finally {
      connection.release();
    }
    res.redirect('/dashboard#patient-appointments');
  });

  post('/appointments/:id/reschedule', requireRole('patient'), authLimit, async (req, res) => {
    const appointmentId = Number(req.params.id);
    const availabilityId = Number(req.body.availabilityId);
    if (!Number.isSafeInteger(appointmentId) || !Number.isSafeInteger(availabilityId) || availabilityId < 1) {
      setNotice(req, 'error', 'Choose a valid appointment time.');
      return res.redirect('/dashboard#patient-appointments');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [req.session.user.id]);
      const [currentRows] = await connection.execute(
        'SELECT id,doctor_id,starts_at,status,payment_method,payment_status,booking_reference FROM appointments WHERE id=? AND patient_id=? FOR UPDATE',
        [appointmentId, req.session.user.id]
      );
      const current = currentRows[0];
      if (!current || !activeAppointmentStates.includes(current.status)) throw new Error('This appointment cannot be rescheduled.');
      if (current.payment_method === 'UPI' && current.payment_status === 'PENDING') throw new Error('Complete or cancel the online payment before rescheduling.');
      const cutoffHours = Math.min(168, Math.max(0, Number(process.env.CANCELLATION_CUTOFF_HOURS || 24)));
      const currentStart = new Date(`${String(current.starts_at).replace(' ', 'T')}Z`);
      if (currentStart.getTime() - Date.now() < cutoffHours * 3600000) throw new Error('Rescheduling must be requested before the cancellation cutoff.');
      const [slots] = await connection.execute(
        `SELECT a.* FROM doctor_availability a JOIN users u ON u.id=a.doctor_id JOIN provider_profiles p ON p.user_id=u.id
         WHERE a.id=? AND a.doctor_id=? AND a.slot_status='AVAILABLE' AND a.consultation_type='in_person' AND a.starts_at>UTC_TIMESTAMP() AND u.account_status='active' AND p.verification_status='VERIFIED' FOR UPDATE`,
        [availabilityId,current.doctor_id]
      );
      if (!slots.length) throw new Error('The new time is no longer available.');
      const slot = slots[0];
      const [conflicts] = await connection.execute(
        "SELECT id FROM appointments WHERE (doctor_id=? OR patient_id=?) AND status IN ('BOOKED','CONFIRMED') AND id<>? AND starts_at<? AND ends_at>? FOR UPDATE",
        [slot.doctor_id, req.session.user.id, current.id, slot.ends_at, slot.starts_at]
      );
      if (conflicts.length) throw new Error('The new time has just been booked.');
      await connection.execute(
        'UPDATE appointments SET doctor_id=?,availability_id=?,starts_at=?,ends_at=?,consultation_type=?,status=\'CONFIRMED\' WHERE id=?',
        [slot.doctor_id, slot.id, slot.starts_at, slot.ends_at, slot.consultation_type, current.id]
      );
      if (Number(current.doctor_id) !== Number(slot.doctor_id)) {
        await notify(connection, current.doctor_id, 'appointment', 'Appointment rescheduled', 'A patient moved this appointment to another provider.');
      }
      await notify(connection, req.session.user.id, 'appointment', 'Appointment rescheduled and confirmed', `Your confirmed appointment time is ${slot.starts_at}. Booking reference remains ${current.booking_reference}.`);
      await notify(connection, slot.doctor_id, 'appointment', 'Confirmed appointment rescheduled', `A patient rescheduled confirmed booking ${current.booking_reference} to ${slot.starts_at}.`);
      await audit(connection, req.session.user.id, 'appointment.reschedule', 'appointment', current.id, { previousDoctorId: current.doctor_id, doctorId: slot.doctor_id });
      await connection.commit();
      setNotice(req, 'success', 'Appointment rescheduled and confirmed. Your existing payment method remains on the booking.');
    } catch (error) {
      await connection.rollback();
      const known = ['This appointment cannot be rescheduled.', 'Complete or cancel the online payment before rescheduling.', 'Rescheduling must be requested before the cancellation cutoff.', 'The new time is no longer available.', 'The new time has just been booked.'];
      setNotice(req, 'error', known.includes(error.message) ? error.message : 'Appointment could not be rescheduled.');
    } finally {
      connection.release();
    }
    res.redirect('/dashboard#patient-appointments');
  });

  post('/doctor/appointments/:id/status', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const status = String(req.body.status || '');
    if (!['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'REJECTED', 'CANCELLED'].includes(status)) {
      setNotice(req, 'error', 'Invalid appointment status.');
      return res.redirect('/doctor/home#doctor-appointments');
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id,patient_id,status,payment_method,payment_status FROM appointments WHERE id=? AND doctor_id=? FOR UPDATE',
        [Number(req.params.id), req.session.user.id]
      );
      if (!rows.length || !activeAppointmentStates.includes(rows[0].status)) throw new Error('Appointment not found or already closed.');
      if (rows[0].payment_method === 'UPI' && rows[0].payment_status !== 'PAID' && status !== 'CANCELLED') {
        throw new Error('Online payment must complete before changing appointment status.');
      }
      const validTransition = rows[0].status === 'BOOKED'
        ? ['CONFIRMED', 'REJECTED', 'CANCELLED'].includes(status)
        : ['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(status);
      if (!validTransition) throw new Error('This status transition is not allowed.');
      await connection.execute(
        "UPDATE appointments SET status=?, payment_status=IF(?='CANCELLED' AND payment_method='UPI' AND payment_status='PENDING','EXPIRED',payment_status) WHERE id=?",
        [status, status, rows[0].id]
      );
      await notify(connection, rows[0].patient_id, 'appointment', 'Appointment status updated', `Your appointment status is ${status}.`);
      await audit(connection, req.session.user.id, 'appointment.status', 'appointment', rows[0].id, { status });
      await connection.commit();
      setNotice(req, 'success', `Appointment marked ${status.toLowerCase()}.`);
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Appointment status could not be changed.');
    } finally {
      connection.release();
    }
    res.redirect('/doctor/home#doctor-appointments');
  });

  post('/doctor/appointments/:id/request-reschedule', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const [rows] = await pool.execute("SELECT id,patient_id,booking_reference FROM appointments WHERE id=? AND doctor_id=? AND status='CONFIRMED'", [Number(req.params.id), req.session.user.id]);
    if (!rows.length) {
      setNotice(req, 'error', 'Only your confirmed appointments can have a reschedule request.');
      return res.redirect('/doctor/home#doctor-appointments');
    }
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [rows[0].patient_id, 'appointment', 'Doctor requested a new appointment time', `Please contact your doctor about booking ${rows[0].booking_reference}.`]);
    await pool.execute("INSERT INTO audit_logs (actor_id,action,entity_type,entity_id) VALUES (?,'appointment.reschedule.request','appointment',?)", [req.session.user.id, rows[0].id]);
    setNotice(req, 'success', 'Reschedule request sent to the patient.');
    res.redirect('/doctor/home#doctor-appointments');
  });

  post('/doctor/appointments/:id/records', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 180);
    const notes = String(req.body.notes || '').trim().slice(0, 10000);
    const upload = decodeMedicalUpload(req.body.recordFileData);
    if (req.body.recordFileData && !upload) {
      setNotice(req, 'error', 'Choose a valid PDF, JPG, PNG or WebP file no larger than 5 MB.');
      return res.redirect('/doctor/home#doctor-appointments');
    }
    const connection = await pool.getConnection();
    let privateKey = null;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT id,patient_id FROM appointments WHERE id=? AND doctor_id=? AND status IN ('CONFIRMED','COMPLETED') FOR UPDATE",
        [Number(req.params.id), req.session.user.id]
      );
      if (!rows.length || title.length < 2 || !notes) throw new Error('Only the assigned doctor can add a record to a confirmed appointment.');
      if (!upload && !notes) throw new Error('Add a care note or attach a relevant document.');
      if (upload) {
        privateKey = `${crypto.randomBytes(24).toString('hex')}.${upload.extension}`;
        const folder = path.join(__dirname, '..', 'var', 'private-medical-records');
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, privateKey), upload.buffer, { flag: 'wx', mode: 0o600 });
      }
      const [result] = await connection.execute(
        'INSERT INTO medical_records (patient_id,created_by,appointment_id,title,notes,private_file_key,mime_type,file_size) VALUES (?,?,?,?,?,?,?,?)',
        [rows[0].patient_id, req.session.user.id, rows[0].id, title, notes || null, privateKey, upload?.mime || null, upload?.buffer.length || null]
      );
      await audit(connection, req.session.user.id, 'medical_record.create', 'medical_record', result.insertId, { appointmentId: rows[0].id });
      await connection.commit();
      setNotice(req, 'success', 'Medical record added to the patient account.');
    } catch (error) {
      await connection.rollback();
      if (privateKey) await fs.unlink(path.join(__dirname, '..', 'var', 'private-medical-records', privateKey)).catch(() => {});
      setNotice(req, 'error', 'Record could not be added. Confirm the appointment and input fields.');
    } finally {
      connection.release();
    }
    res.redirect('/doctor/home#doctor-appointments');
  });

  get('/medical-records/:id/file', requireAuth, verifiedDoctorWhenDoctor, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).render('not-found');
    const [rows] = await pool.execute(
      `SELECT r.private_file_key,r.mime_type,r.title,r.patient_id,r.created_by,a.doctor_id
       FROM medical_records r LEFT JOIN appointments a ON a.id=r.appointment_id WHERE r.id=? LIMIT 1`, [id]
    );
    const record = rows[0];
    const user = req.session.user;
    const allowed = record && (Number(record.patient_id) === Number(user.id)
      || (user.role === 'doctor' && Number(record.doctor_id) === Number(user.id) && Number(record.created_by) === Number(user.id)));
    if (!allowed || !record.private_file_key) return res.status(404).render('not-found');
    const file = path.join(__dirname, '..', 'var', 'private-medical-records', path.basename(record.private_file_key));
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', record.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${String(record.title).replace(/[^a-z0-9_-]/gi, '_').slice(0, 50)}.${path.extname(file).slice(1)}"`);
    res.sendFile(file, (error) => { if (error && !res.headersSent) res.status(404).render('not-found'); });
  });

  post('/doctor/appointments/:id/prescriptions', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const text = String(req.body.prescription || '').trim().slice(0, 20000);
    const medicineNames = Array.isArray(req.body.medicineName) ? req.body.medicineName : req.body.medicineName ? [req.body.medicineName] : [];
    const medicines = medicineNames.map((name, index) => ({
      name: String(name || '').trim().slice(0, 160),
      dosage: String((Array.isArray(req.body.dosage) ? req.body.dosage[index] : req.body.dosage) || '').trim().slice(0, 100),
      frequency: String((Array.isArray(req.body.frequency) ? req.body.frequency[index] : req.body.frequency) || '').trim().slice(0, 100),
      duration: String((Array.isArray(req.body.duration) ? req.body.duration[index] : req.body.duration) || '').trim().slice(0, 100),
      instructions: String((Array.isArray(req.body.medicineInstructions) ? req.body.medicineInstructions[index] : req.body.medicineInstructions) || '').trim().slice(0, 300),
    })).filter((medicine) => medicine.name);
    const additionalNotes = String(req.body.additionalNotes || '').trim().slice(0, 5000) || null;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        "SELECT id,patient_id FROM appointments WHERE id=? AND doctor_id=? AND status IN ('CONFIRMED','COMPLETED') FOR UPDATE",
        [Number(req.params.id), req.session.user.id]
      );
      if (!rows.length || (!medicines.length && text.length < 3)) throw new Error('Only the assigned doctor can issue a prescription for a confirmed appointment.');
      const prescriptionText = text || medicines.map((m) => `${m.name} — ${m.dosage || 'Dosage not specified'} — ${m.frequency || 'Frequency not specified'} — ${m.duration || 'Duration not specified'}${m.instructions ? ` — ${m.instructions}` : ''}`).join('\n');
      const [result] = await connection.execute(
        'INSERT INTO prescriptions (patient_id,doctor_id,appointment_id,prescription_text,medicines_json,additional_notes) VALUES (?,?,?,?,?,?)',
        [rows[0].patient_id, req.session.user.id, rows[0].id, prescriptionText, medicines.length ? JSON.stringify(medicines) : null, additionalNotes]
      );
      await audit(connection, req.session.user.id, 'prescription.issue', 'prescription', result.insertId, { appointmentId: rows[0].id });
      await notify(connection, rows[0].patient_id, 'prescription', 'A prescription is available', 'Sign in to view the prescription from your doctor.');
      await connection.commit();
      setNotice(req, 'success', 'Prescription added to the patient account.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Prescription could not be saved. Confirm the appointment and input fields.');
    } finally {
      connection.release();
    }
    res.redirect('/doctor/home#doctor-appointments');
  });

  post('/doctor/prescriptions/:id/amend', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const text = String(req.body.prescription || '').trim().slice(0, 20000);
    const prescriptionId = Number(req.params.id);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT p.id,p.patient_id,p.appointment_id FROM prescriptions p JOIN appointments a ON a.id=p.appointment_id
         WHERE p.id=? AND p.doctor_id=? AND a.doctor_id=? AND a.status IN ('CONFIRMED','COMPLETED') FOR UPDATE`,
        [prescriptionId, req.session.user.id, req.session.user.id]
      );
      if (!rows.length || text.length < 3) throw new Error('This prescription cannot be amended by this account.');
      const [result] = await connection.execute(
        'INSERT INTO prescriptions (patient_id,doctor_id,appointment_id,prescription_text,amended_from) VALUES (?,?,?,?,?)',
        [rows[0].patient_id, req.session.user.id, rows[0].appointment_id, text, rows[0].id]
      );
      await audit(connection, req.session.user.id, 'prescription.amend', 'prescription', result.insertId, { replaces: rows[0].id });
      await notify(connection, rows[0].patient_id, 'prescription', 'A prescription amendment is available', 'A doctor added a new prescription version. Earlier versions remain in your history.');
      await connection.commit();
      setNotice(req, 'success', 'A new prescription version was saved; the earlier version remains in history.');
    } catch (error) {
      await connection.rollback();
      setNotice(req, 'error', 'Prescription amendment could not be saved.');
    } finally {
      connection.release();
    }
    res.redirect('/doctor/home#doctor-prescriptions');
  });

  get('/prescriptions/:id', requireAuth, verifiedDoctorWhenDoctor, async (req, res) => {
    const user = req.session.user;
    if (!['patient', 'doctor'].includes(user.role)) return res.status(404).render('not-found');
    const [rows] = await pool.execute(
      `SELECT p.id,p.prescription_text,p.medicines_json,p.additional_notes,p.issued_at,p.amended_from,u.name AS doctor_name,u.specialization,a.booking_reference
       FROM prescriptions p JOIN users u ON u.id=p.doctor_id LEFT JOIN appointments a ON a.id=p.appointment_id
       WHERE p.id=? AND ((?='patient' AND p.patient_id=?) OR (?='doctor' AND p.doctor_id=?))`,
      [Number(req.params.id), user.role, user.id, user.role, user.id]
    );
    if (!rows.length) return res.status(404).render('not-found');
    if (typeof rows[0].medicines_json === 'string') {
      try { rows[0].medicines = JSON.parse(rows[0].medicines_json); } catch { rows[0].medicines = []; }
    } else rows[0].medicines = rows[0].medicines_json || [];
    res.render('prescription', { prescription: rows[0] });
  });

  post('/notifications/:id/read', requireAuth, authLimit, async (req, res) => {
    await pool.execute('UPDATE notifications SET read_at=UTC_TIMESTAMP() WHERE id=? AND user_id=? AND read_at IS NULL', [Number(req.params.id), req.session.user.id]);
    res.redirect(req.session.user.role === 'doctor' ? '/doctor/home#doctor-notifications' : '/dashboard#doctor-notifications');
  });

  post('/notifications/read-all', requireRole('doctor'), authLimit, async (req, res) => {
    await pool.execute('UPDATE notifications SET read_at=UTC_TIMESTAMP() WHERE user_id=? AND read_at IS NULL', [req.session.user.id]);
    setNotice(req, 'success', 'All notifications marked as read.');
    res.redirect('/doctor/home#doctor-notifications');
  });

  post('/doctor/messages', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const appointmentId = Number(req.body.appointmentId);
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (!Number.isSafeInteger(appointmentId) || appointmentId < 1 || message.length < 1) {
      setNotice(req, 'error', 'Choose an appointment and enter a message.');
      return res.redirect('/doctor/home#doctor-messages');
    }
    const [rows] = await pool.execute("SELECT id,patient_id FROM appointments WHERE id=? AND doctor_id=? AND status IN ('BOOKED','CONFIRMED','COMPLETED')", [appointmentId, req.session.user.id]);
    if (!rows.length) {
      setNotice(req, 'error', 'That appointment is not available for messaging.');
      return res.redirect('/doctor/home#doctor-messages');
    }
    await pool.execute('INSERT INTO appointment_messages (appointment_id,sender_id,recipient_id,message) VALUES (?,?,?,?)', [appointmentId, req.session.user.id, rows[0].patient_id, message]);
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [rows[0].patient_id, 'message', 'Message from your doctor', 'Sign in to your dashboard to read an appointment message.']);
    setNotice(req, 'success', 'Appointment message sent.');
    res.redirect('/doctor/home#doctor-messages');
  });

  post('/patient/messages', requireRole('patient'), authLimit, async (req, res) => {
    const appointmentId = Number(req.body.appointmentId);
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (!Number.isSafeInteger(appointmentId) || appointmentId < 1 || !message) {
      setNotice(req, 'error', 'Choose an appointment and enter a message.');
      return res.redirect('/dashboard#patient-care-messages');
    }
    const [rows] = await pool.execute("SELECT id,doctor_id FROM appointments WHERE id=? AND patient_id=? AND status IN ('BOOKED','CONFIRMED','COMPLETED')", [appointmentId, req.session.user.id]);
    if (!rows.length) {
      setNotice(req, 'error', 'That appointment is not available for messaging.');
      return res.redirect('/dashboard#patient-care-messages');
    }
    await pool.execute('INSERT INTO appointment_messages (appointment_id,sender_id,recipient_id,message) VALUES (?,?,?,?)', [appointmentId, req.session.user.id, rows[0].doctor_id, message]);
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [rows[0].doctor_id, 'message', 'Patient sent an appointment message', 'Sign in to your dashboard to read the appointment message.']);
    setNotice(req, 'success', 'Message sent to your doctor.');
    res.redirect('/dashboard#patient-care-messages');
  });

  post('/messages/:id/read', requireAuth, verifiedDoctorWhenDoctor, authLimit, async (req, res) => {
    const user = req.session.user;
    if (!['doctor', 'patient'].includes(user.role)) return res.status(404).render('not-found');
    await pool.execute(`UPDATE appointment_messages m JOIN appointments a ON a.id=m.appointment_id
      SET m.read_at=UTC_TIMESTAMP() WHERE m.id=? AND m.recipient_id=? AND
      ((?='doctor' AND a.doctor_id=?) OR (?='patient' AND a.patient_id=?)) AND m.read_at IS NULL`,
    [Number(req.params.id), user.id, user.role, user.id, user.role, user.id]);
    res.redirect(user.role === 'doctor' ? '/doctor/home#doctor-messages' : '/dashboard#patient-care-messages');
  });

  post('/doctor/affiliations', requireRole('doctor'), requireVerifiedDoctor, authLimit, async (req, res) => {
    const hospitalId = Number(req.body.hospitalId);
    if (!Number.isSafeInteger(hospitalId) || hospitalId < 1) {
      setNotice(req, 'error', 'Choose a hospital account.');
      return res.redirect('/doctor/home#doctor-clinic');
    }
    const [hospitals] = await pool.execute("SELECT u.id FROM users u JOIN hospitals h ON h.user_id=u.id WHERE u.id=? AND u.role='hospital' AND u.account_status='active'", [hospitalId]);
    if (!hospitals.length) {
      setNotice(req, 'error', 'That hospital account is unavailable.');
      return res.redirect('/doctor/home#doctor-clinic');
    }
    await pool.execute("INSERT INTO doctor_hospital_affiliations (doctor_id,hospital_user_id,status) VALUES (?,?, 'PENDING') ON DUPLICATE KEY UPDATE status='PENDING',updated_at=UTC_TIMESTAMP()", [req.session.user.id, hospitalId]);
    await pool.execute('INSERT INTO notifications (user_id,category,title,message) VALUES (?,?,?,?)', [hospitalId, 'affiliation', 'Doctor affiliation request', 'A doctor requested an affiliation. Review it in the hospital account.']);
    setNotice(req, 'success', 'Affiliation request submitted; it stays pending until the hospital approves it.');
    res.redirect('/doctor/home#doctor-clinic');
  });

  app.use((error, req, res, next) => {
    console.error('Healthcare route failed:', error.message);
    if (res.headersSent) return next(error);
    res.status(500).render('server-error', {
      user: req.session?.user || null,
      notice: null,
      year: new Date().getFullYear(),
    });
  });
};

module.exports.utcSqlDate = utcSqlDate;
module.exports.addMinutes = addMinutes;
module.exports.decodeMedicalUpload = decodeMedicalUpload;
module.exports.decodePaymentQr = decodePaymentQr;
module.exports.proofPdf = proofPdf;
