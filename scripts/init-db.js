require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function main() {
  const dbName = process.env.DB_NAME || 'healthconnect_bharat';
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error('DB_NAME may contain only letters, numbers and underscores.');
  }

  const createDatabase = process.env.DB_CREATE_DATABASE !== 'false';
  const connectionOptions = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    ...(createDatabase ? {} : { database: dbName }),
    ...(process.env.DB_SSL === 'true'
      ? { ssl: { minVersion: 'TLSv1.2' } }
      : {}),
  };

  let connection;
  try {
    connection = await mysql.createConnection(connectionOptions);

    if (createDatabase) {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      await connection.changeUser({ database: dbName });
    }

    console.log(`Using database ${dbName}.`);
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const statements = schema
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await connection.query(statement);
    }

    console.log('Users and email OTP tables are ready.');
  } finally {
    if (connection) await connection.end();
  }
}

main().catch((error) => {
  console.error('Could not create the database:', error.message);
  process.exitCode = 1;
});