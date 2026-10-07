require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

const mimeByExtension = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function main() {
  const dbName = process.env.DB_NAME || 'healthconnect_bharat';
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  const photoDirectory = path.join(__dirname, '..', 'public', 'uploads', 'profiles');
  let migrated = 0;
  let missing = 0;

  try {
    const [users] = await connection.execute(
      "SELECT id,profile_image_url FROM users WHERE profile_image_url LIKE '/uploads/profiles/%'"
    );
    for (const user of users) {
      const fileName = String(user.profile_image_url).split('/').pop();
      const match = fileName.match(/^([a-f0-9]{36})\.(jpg|jpeg|png|webp)$/i);
      if (!match) { missing += 1; continue; }
      const extension = match[2].toLowerCase();
      let image;
      try { image = await fs.readFile(path.join(photoDirectory, fileName)); }
      catch (error) {
        if (error.code === 'ENOENT') { missing += 1; continue; }
        throw error;
      }
      if (!image.length || image.length > 5 * 1024 * 1024) { missing += 1; continue; }
      await connection.execute(
        'INSERT INTO profile_images (user_id,mime_type,image_data) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mime_type=VALUES(mime_type),image_data=VALUES(image_data),updated_at=CURRENT_TIMESTAMP',
        [user.id, mimeByExtension[extension], image]
      );
      await connection.execute('UPDATE users SET profile_image_url=? WHERE id=?', [`/profile-images/${user.id}`, user.id]);
      migrated += 1;
    }
    console.log(`Profile photo migration complete. Migrated: ${migrated}; local image file unavailable or invalid: ${missing}.`);
    if (missing) console.log('For unavailable files, sign in on the deployed site and upload the photo again from Profile.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Profile photo migration failed:', error.message);
  process.exitCode = 1;
});
