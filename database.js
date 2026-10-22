const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'database');
const DB = path.join(DB_DIR, 'investpro.db');

fs.mkdirSync(DB_DIR, { recursive: true });

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function run(sql) {
  return execFileSync(
    'sqlite3',
    ['-json', DB, sql],
    { encoding: 'utf8' }
  ).trim();
}

function exec(sql) {
  execFileSync(
    'sqlite3',
    [DB, sql],
    { encoding: 'utf8' }
  );
}

exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT NOT NULL UNIQUE,
 password TEXT NOT NULL,
 balance INTEGER DEFAULT 0,
 gains INTEGER DEFAULT 0,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 referrer_id INTEGER,
 referral_earnings INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS investments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 plan TEXT NOT NULL,
 amount INTEGER NOT NULL,
 status TEXT DEFAULT 'ACTIF',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS referral_bonus (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 from_user_id INTEGER NOT NULL,
 level INTEGER NOT NULL,
 rate REAL NOT NULL,
 amount INTEGER NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 type TEXT NOT NULL,
 amount INTEGER NOT NULL,
 status TEXT DEFAULT 'EN ATTENTE',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

function getUserByPhone(phone) {
  const result = run(
    `SELECT * FROM users WHERE phone='${sqlEscape(phone)}' LIMIT 1;`
  );
  return result ? JSON.parse(result)[0] : null;
}

function getUserById(id) {
  const result = run(
    `SELECT id,name,phone,balance,gains,created_at,role
     FROM users WHERE id=${Number(id)} LIMIT 1;`
  );
  return result ? JSON.parse(result)[0] : null;
}

function createUser(name, phone, password) {
  exec(`
    INSERT INTO users(name,phone,password)
    VALUES(
      '${sqlEscape(name)}',
      '${sqlEscape(phone)}',
      '${sqlEscape(password)}'
    );
  `);

  return getUserByPhone(phone);
}

function addTransaction(userId, type, amount, proof = null) {
  const proofValue = proof ? `'${sqlEscape(proof)}'` : 'NULL';

  exec(`
    INSERT INTO transactions(user_id,type,amount,status,proof)
    VALUES(${Number(userId)},'${sqlEscape(type)}',${Number(amount)},'EN ATTENTE',${proofValue});
  `);
}


function getPendingDeposits() {
  const result = run(`
    SELECT
      t.id,
      t.user_id,
      u.name,
      u.phone,
      t.type,
      t.amount,
      t.status,
      t.proof,
      t.created_at
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.type IN ('DEPOT_WAVE','DEPOT_MTN')
      AND t.status = 'EN ATTENTE'
    ORDER BY t.id DESC;
  `);

  return result ? JSON.parse(result) : [];
}

function approveDeposit(transactionId) {
  const id = Number(transactionId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Transaction invalide.');
  }

  const result = run(`
    SELECT id,user_id,amount,status,type
    FROM transactions
    WHERE id=${id}
      AND type IN ('DEPOT_WAVE','DEPOT_MTN')
      AND status='EN ATTENTE'
    LIMIT 1;
  `);

  if (!result) {
    throw new Error('Dépôt introuvable ou déjà traité.');
  }

  const transaction = JSON.parse(result)[0];

  exec(`
    BEGIN TRANSACTION;

    UPDATE users
    SET balance = balance + ${Number(transaction.amount)}
    WHERE id = ${Number(transaction.user_id)};

    UPDATE transactions
    SET status = 'APPROUVÉ'
    WHERE id = ${id};

    COMMIT;
  `);

  return transaction;
}

function createInvestment(userId, plan, amount) {
  const uid = Number(userId);
  const value = Number(amount);

  if (!Number.isSafeInteger(uid) || uid <= 0 ||
      !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Montant ou utilisateur invalide.');
  }

  const result = run(`
    BEGIN IMMEDIATE;
    UPDATE users
    SET balance = balance - ${value}
    WHERE id = ${uid} AND balance >= ${value};

    INSERT INTO investments(user_id, plan, amount, status)
    SELECT ${uid}, '${sqlEscape(plan)}', ${value}, 'ACTIF'
    WHERE changes() = 1;

    SELECT changes() AS inserted;
    COMMIT;
  `);

  const rows = result ? JSON.parse(result) : [];
  if (!rows.length || Number(rows[0].inserted) !== 1) {
    throw new Error('Solde insuffisant ou compte introuvable.');
  }

  return { plan, amount: value, status: 'ACTIF' };
}


function addWithdrawal(userId, amount, method, recipient, fee, netAmount) {
  const uid = Number(userId);
  const value = Number(amount);
  const cost = Number(fee);
  const net = Number(netAmount);
  const allowed = ['wave', 'mtn'];

  if (!Number.isSafeInteger(uid) || uid <= 0 ||
      !Number.isSafeInteger(value) || value < 1000 ||
      !Number.isSafeInteger(cost) || cost < 0 ||
      !Number.isSafeInteger(net) || net < 0 ||
      !allowed.includes(method) ||
      !/^[0-9+ ]{8,20}$/.test(recipient)) {
    throw new Error('Informations de retrait invalides.');
  }

  const result = run(`
    BEGIN IMMEDIATE;

    INSERT INTO transactions
      (user_id,type,amount,status,method,recipient,fee,net_amount)
    SELECT ${uid},'RETRAIT',${value},'EN ATTENTE',
      '${sqlEscape(method)}','${sqlEscape(recipient)}',${cost},${net}
    WHERE EXISTS (
      SELECT 1 FROM users
      WHERE id=${uid}
        AND balance - COALESCE((
          SELECT SUM(amount) FROM transactions
          WHERE user_id=${uid}
            AND type='RETRAIT'
            AND status='EN ATTENTE'
        ),0) >= ${value}
    );

    SELECT changes() AS inserted;
    COMMIT;
  `);

  const rows = result ? JSON.parse(result) : [];
  if (!rows.length || Number(rows[0].inserted) !== 1) {
    throw new Error('Solde insuffisant pour ce retrait ou vos demandes en attente.');
  }
}

function getInvestments(userId) {
  const result = run(`
    SELECT id,plan,amount,status,created_at
    FROM investments
    WHERE user_id=${Number(userId)}
    ORDER BY id DESC;
  `);

  return result ? JSON.parse(result) : [];
}

function getTransactions(userId) {
  const result = run(`
    SELECT id,type,amount,status,created_at
    FROM transactions
    WHERE user_id=${Number(userId)}
    ORDER BY id DESC;
  `);

  return result ? JSON.parse(result) : [];
}

module.exports = {
  createInvestment,
  DB,
  getUserByPhone,
  getUserById,
  createUser,
  addTransaction,
  addWithdrawal,
  getInvestments,
  getTransactions,
  getPendingDeposits,
  approveDeposit
};
