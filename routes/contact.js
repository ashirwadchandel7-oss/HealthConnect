const rateLimit = require('express-rate-limit');

const categories = new Set(['account', 'appointment', 'technical', 'complaint', 'other']);

function decodeEvidence(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:(application\/pdf|image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;

  const mime = match[1];
  const valid = mime === 'application/pdf'
    ? buffer.subarray(0, 5).toString() === '%PDF-'
    : mime === 'image/jpeg'
      ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mime === 'image/png'
        ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!valid) return null;

  const extension = ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[mime];
  return { buffer, mime, extension };
}

module.exports = function registerContactRoutes({ app, pool, requireRole, authLimit, setNotice, sendContactReply }) {
  const submitLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many messages were sent. Please try again later.',
  });

  app.get('/contact', (req, res) => {
    const user = req.session.user || null;
    if (user?.role === 'admin') return res.redirect('/admin#contact-inbox');
    res.render('contact', {
      form: {
        name: user?.name || '',
        email: user?.email || '',
        phone: user?.phone || '',
        category: 'other',
        message: '',
      },
      error: null,
    });
  });

  app.post('/contact', submitLimit, async (req, res) => {
    const user = req.session.user || null;
    if (user?.role === 'admin') return res.redirect('/admin#contact-inbox');
    const name = String(user?.name || req.body.name || '').trim().slice(0, 120);
    const email = String(user?.email || req.body.email || '').trim().toLowerCase().slice(0, 254);
    const phone = String(user?.phone || req.body.phone || '').trim().slice(0, 32);
    const category = String(req.body.category || '');
    const message = String(req.body.message || '').trim();
    const evidenceData = String(req.body.evidenceData || '');
    const evidence = evidenceData ? decodeEvidence(evidenceData) : null;
    const rawEvidenceName = String(req.body.evidenceName || '').trim();
    const evidenceName = rawEvidenceName
      .split(/[\\/]/).pop().replace(/[^a-z0-9._ -]/gi, '_').slice(0, 180);
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    const phoneValid = !phone || /^\+?[0-9 ()-]{7,32}$/.test(phone);
    let error = null;

    if (name.length < 2 || !emailValid || !phoneValid) error = 'Enter a valid name and email address, and check the phone number.';
    else if (!categories.has(category)) error = 'Choose a valid message category.';
    else if (message.length < 10 || message.length > 5000) error = 'Message must be between 10 and 5,000 characters.';
    else if (evidenceData && (!evidence || !evidenceName)) error = 'Attach a valid PDF, JPG, PNG or WebP proof no larger than 5 MB.';

    if (error) {
      return res.status(400).render('contact', {
        form: { name, email, phone, category, message },
        error,
      });
    }

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO contact_messages (user_id,sender_role,sender_name,sender_email,sender_phone,category,message) VALUES (?,?,?,?,?,?,?)',
        [user?.id || null, user?.role || null, name, email, phone || null, category, message]
      );
      if (evidence) {
        await connection.execute(
          'INSERT INTO contact_message_evidence (message_id,original_name,mime_type,file_size,file_data) VALUES (?,?,?,?,?)',
          [result.insertId, evidenceName, evidence.mime, evidence.buffer.length, evidence.buffer]
        );
      }
      await connection.commit();
      setNotice(req, 'success', 'Your message was sent to the HealthConnect admin team. Keep the reference number: HC-' + String(result.insertId).padStart(6, '0') + '.');
      return res.redirect('/contact');
    } catch (saveError) {
      if (connection) await connection.rollback().catch(() => {});
      console.error('Contact message could not be saved:', saveError.message);
      return res.status(503).render('contact', {
        form: { name, email, phone, category, message },
        error: 'We could not save your message right now. Please try again later.',
      });
    } finally {
      connection?.release();
    }
  });

  app.post('/admin/contact-messages/:id/reply', requireRole('admin'), authLimit, async (req, res, next) => {
    const id = Number(req.params.id);
    const text = String(req.body.reply || '').trim();
    if (!Number.isSafeInteger(id) || id < 1 || text.length < 2 || text.length > 4000) {
      setNotice(req, 'error', 'Write a reply of 2 to 4,000 characters.');
      return res.redirect('/admin#contact-inbox');
    }

    try {
      const [messages] = await pool.execute(
        'SELECT id,sender_name,sender_email FROM contact_messages WHERE id=? LIMIT 1',
        [id]
      );
      if (!messages.length) {
        setNotice(req, 'error', 'Contact message was not found.');
        return res.redirect('/admin#contact-inbox');
      }
      const message = messages[0];
      const reference = `HC-${String(id).padStart(6, '0')}`;
      const subject = `HealthConnect Bharat support reply ${reference}`;
      const [saved] = await pool.execute(
        "INSERT INTO contact_message_replies (message_id,admin_user_id,reply_text,delivery_status) VALUES (?,?,?,'PENDING')",
        [id, req.session.user.id, text]
      );
      try {
        await sendContactReply({
          email: message.sender_email,
          subject,
          text: `Hello ${message.sender_name},\n\n${text}\n\nReference: ${reference}\n\nHealthConnect Bharat Admin Team`,
        });
        await pool.execute("UPDATE contact_message_replies SET delivery_status='SENT' WHERE id=?", [saved.insertId]);
        await pool.execute("UPDATE contact_messages SET status=IF(status='OPEN','IN_PROGRESS',status) WHERE id=?", [id]);
        setNotice(req, 'success', `Reply emailed to ${message.sender_email}.`);
      } catch (emailError) {
        await pool.execute("UPDATE contact_message_replies SET delivery_status='FAILED' WHERE id=?", [saved.insertId]).catch(() => {});
        console.error('Contact reply delivery failed:', emailError.code || 'UNKNOWN', emailError.message);
        setNotice(req, 'error', 'Reply could not be emailed. Check the server email configuration; the failed reply is saved in the inbox.');
      }
      return res.redirect('/admin#contact-inbox');
    } catch (error) {
      return next(error);
    }
  });

  app.get('/admin/contact-messages/:id/evidence', requireRole('admin'), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
    try {
      const [rows] = await pool.execute(
        'SELECT original_name,mime_type,file_data FROM contact_message_evidence WHERE message_id=? LIMIT 1',
        [id]
      );
      if (!rows.length) return res.sendStatus(404);
      const evidence = rows[0];
      const safeName = evidence.original_name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 180) || 'evidence';
      res.set({
        'Content-Type': evidence.mime_type,
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.send(evidence.file_data);
    } catch (error) {
      return next(error);
    }
  });
};
