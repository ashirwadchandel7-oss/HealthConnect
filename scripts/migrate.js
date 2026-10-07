require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function run() {
  const database = process.env.DB_NAME || 'healthconnect_bharat';
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('DB_NAME contains unsupported characters.');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    multipleStatements: false,
  });

  try {
    const [userIdColumns] = await connection.execute(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='id' LIMIT 1",
      [database]
    );
    const userIdType = userIdColumns[0]?.COLUMN_TYPE?.toLowerCase();
    if (!['int unsigned', 'bigint unsigned', 'int', 'bigint'].includes(userIdType)) {
      throw new Error('Could not safely determine the existing users.id integer type. Check that db:init has been run.');
    }

    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(120) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const dir = path.join(__dirname, 'migrations');
    const files = (await fs.readdir(dir)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const [existing] = await connection.execute('SELECT version FROM schema_migrations WHERE version=?', [file]);
      if (existing.length) {
        console.log(`Already applied: ${file}`);
        continue;
      }
      const sql = (await fs.readFile(path.join(dir, file), 'utf8'))
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .replace(/BIGINT UNSIGNED/gi, userIdType);
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log(`Applied: ${file}`);
    }
  } finally {
    await connection.end();
  }
}

run().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
