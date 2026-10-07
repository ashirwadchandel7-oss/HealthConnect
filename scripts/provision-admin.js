require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const mysql = require('mysql2/promise');

async function run() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('Set ADMIN_EMAIL to an existing verified account in .env first.');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const confirmation = await rl.question(`Promote verified account ${email} to admin? Type the email to confirm: `);
  rl.close();
  if (confirmation.trim().toLowerCase() !== email) throw new Error('Confirmation did not match. No changes were made.');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'healthconnect_bharat',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const [result] = await connection.execute(
      "UPDATE users SET role='admin', account_status='active' WHERE email=? AND email_verified=1",
      [email]
    );
    if (!result.affectedRows) throw new Error('No verified user matched. Verify the account first; no admin was created.');
    console.log('Verified account promoted to admin. Keep this account protected.');
  } finally {
    await connection.end();
  }
}

run().catch((error) => {
  console.error('Admin provisioning failed:', error.message);
  process.exitCode = 1;
});
