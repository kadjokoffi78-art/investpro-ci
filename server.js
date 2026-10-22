const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  getUserByPhone,
  getUserById,
  createUser,
  createInvestment,
  addTransaction,
  addWithdrawal,
  getInvestments,
  getTransactions,
  getPendingDeposits,
  approveDeposit
} = require('./database');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const sessions = new Map();

function hashPassword(password) {
  return crypto.createHash('sha256')
    .update(password)
    .digest('hex');
}

function sendJSON(res, status, data, cookie) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };

  if (cookie) headers['Set-Cookie'] = cookie;

  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', chunk => {
      data += chunk;

      if (data.length > 1000000) {
        reject(new Error('Requête trop grande'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('Données invalides'));
      }
    });

    req.on('error', reject);
  });
}

function token(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/investpro_session=([^;]+)/);
  return match ? match[1] : null;
}

function currentUser(req) {
  const t = token(req);
  if (!t) return null;

  const id = sessions.get(t);
  if (!id) return null;

  return getUserById(id);
}

function requireAdmin(req, res) {
  const user = currentUser(req);

  if (!user) {
    sendJSON(res, 401, { success: false, error: 'Connexion requise.' });
    return null;
  }

  if (user.role !== 'admin') {
    sendJSON(res, 403, { success: false, error: 'Accès réservé à l’administrateur.' });
    return null;
  }

  return user;
}


function serve(req, res) {
  let url = req.url.split('?')[0];

  if (url === '/') url = '/index.html';

  const file = path.normalize(path.join(PUBLIC, url));

  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Accès refusé');
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('Page introuvable');
  }

  const ext = path.extname(file);

  const types = {
    '.html':'text/html; charset=utf-8',
    '.css':'text/css; charset=utf-8',
    '.js':'application/javascript; charset=utf-8',
    '.png':'image/png',
    '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg',
    '.svg':'image/svg+xml'
  };

  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control':'no-store'
  });

  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {

  try {

    const url = req.url.split('?')[0];

    if (req.method === 'POST' && url === '/api/register') {

      const data = await body(req);

      const name = String(data.name || '').trim();
      const phone = String(data.phone || '').trim();
      const password = String(data.password || '');

      if (!name || !phone || !password) {
        return sendJSON(res, 400, {
          error:'Tous les champs sont obligatoires.'
        });
      }

      if (password.length < 4) {
        return sendJSON(res, 400, {
          error:'Le mot de passe doit contenir au moins 4 caractères.'
        });
      }

      if (getUserByPhone(phone)) {
        return sendJSON(res, 400, {
          error:'Ce numéro possède déjà un compte.'
        });
      }

      const user = createUser(
        name,
        phone,
        hashPassword(password)
      );

      return sendJSON(res, 200, {
        success:true,
        message:'Compte créé avec succès.',
        user:{
          id:user.id,
          name:user.name,
          phone:user.phone
        }
      });
    }

    if (req.method === 'POST' && url === '/api/login') {

      const data = await body(req);

      const phone = String(data.phone || '').trim();
      const password = String(data.password || '');

      const user = getUserByPhone(phone);

      if (!user || user.password !== hashPassword(password)) {
        return sendJSON(res, 401, {
          error:'Numéro ou mot de passe incorrect.'
        });
      }

      const t = crypto.randomBytes(32).toString('hex');

      sessions.set(t, user.id);

      return sendJSON(
        res,
        200,
        {success:true, message:'Connexion réussie.'},
        `investpro_session=${t}; HttpOnly; Path=/; SameSite=Lax`
      );
    }

    if (req.method === 'GET' && url === '/api/me') {

      const user = currentUser(req);

      if (!user) {
        return sendJSON(res, 401, {
          error:'Non connecté.'
        });
      }

      return sendJSON(res, 200, {
        user,
        investments:getInvestments(user.id),
        transactions:getTransactions(user.id)
      });
    }

    if (req.method === 'POST' && url === '/api/change-password') {
      const user = currentUser(req);

      if (!user) {
        return sendJSON(res, 401, {
          success: false,
          error: 'Connectez-vous d’abord.'
        });
      }

      const data = await body(req);
      const oldPassword = String(data.oldPassword || '');
      const newPassword = String(data.newPassword || '');

      if (!oldPassword || !newPassword) {
        return sendJSON(res, 400, {
          success: false,
          error: 'Veuillez remplir tous les champs.'
        });
      }

      if (newPassword.length < 8) {
        return sendJSON(res, 400, {
          success: false,
          error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.'
        });
      }

      const account = getUserById(user.id);

      if (!account || account.password !== hashPassword(oldPassword)) {
        return sendJSON(res, 401, {
          success: false,
          error: 'Ancien mot de passe incorrect.'
        });
      }

      const newHash = hashPassword(newPassword);

      const { DB } = require('./database');
      const { execFileSync } = require('child_process');

      execFileSync('sqlite3', [
        DB,
        `UPDATE users SET password='${newHash}' WHERE id=${Number(user.id)};`
      ]);

      return sendJSON(res, 200, {
        success: true,
        message: 'Mot de passe modifié avec succès.'
      });
    }

    if (req.method === 'POST' && url === '/api/logout') {

      const t = token(req);

      if (t) sessions.delete(t);

      return sendJSON(
        res,
        200,
        {success:true},
        'investpro_session=; HttpOnly; Path=/; Max-Age=0'
      );
    }


    // Administration des dépôts
    if (req.method === 'GET' && url === '/api/admin/deposits') {
      if (!requireAdmin(req, res)) return;

      const deposits = getPendingDeposits();
      return sendJSON(res, 200, {
        success: true,
        deposits
      });
    }

    if (req.method === 'POST' && url === '/api/admin/deposit/approve') {
      if (!requireAdmin(req, res)) return;

      const data = await body(req);
      const transactionId = Number(data.transactionId);

      try {
        const transaction = approveDeposit(transactionId);

        return sendJSON(res, 200, {
          success: true,
          message: 'Dépôt approuvé et solde crédité.',
          transaction
        });
      } catch (err) {
        return sendJSON(res, 400, {
          error: err.message || 'Impossible d’approuver le dépôt.'
        });
      }
    }

    if (req.method === 'POST' && url === '/api/deposit') {
      const user = currentUser(req);

      if (!user) {
        return sendJSON(res, 401, {
          error: 'Connectez-vous d’abord.'
        });
      }

      const data = await body(req);
      const amount = Number(data.amount);
      const method = String(data.method || '').toLowerCase();
      const proof = String(data.proof || '').trim();

      if (method !== 'wave' && method !== 'mtn') {
        return sendJSON(res, 400, {
          error: 'Moyen de paiement indisponible.'
        });
      }

      if (!Number.isSafeInteger(amount) || amount < 3000) {
        return sendJSON(res, 400, {
          error: 'Le montant minimum est de 3 000 FCFA.'
        });
      }

      if (!proof) {
        return sendJSON(res, 400, {
          error: 'La capture d’écran du paiement est obligatoire.'
        });
      }

      if (!proof.startsWith('data:image/')) {
        return sendJSON(res, 400, {
          error: 'La preuve de paiement doit être une image.'
        });
      }

      if (proof.length > 2000000) {
        return sendJSON(res, 400, {
          error: 'La capture est trop volumineuse.'
        });
      }

      addTransaction(
        user.id,
        method === 'wave' ? 'DEPOT_WAVE' : 'DEPOT_MTN',
        amount,
        proof
      );

      return sendJSON(res, 200, {
        success: true,
        message: 'Dépôt enregistré. Votre capture sera vérifiée avant le crédit du solde.'
      });
    }

    
    if (req.method === 'POST' && url === '/api/invest') {
      const user = currentUser(req);

      if (!user) {
        return sendJSON(res, 401, { error: 'Connectez-vous d’abord.' });
      }

      const data = await body(req);
      const prices = {
        V1: 3000, V2: 10000, V3: 25000, V4: 50000,
        V5: 100000, V6: 250000, V7: 500000, V8: 1000000
      };
      const plan = String(data.plan || '').toUpperCase();

      if (!Object.prototype.hasOwnProperty.call(prices, plan)) {
        return sendJSON(res, 400, { error: 'Produit invalide.' });
      }

      try {
        const investment = createInvestment(user.id, plan, prices[plan]);
        const updatedUser = getUserById(user.id);
        return sendJSON(res, 201, {
          success: true,
          message: 'Investissement enregistré.',
          investment,
          balance: updatedUser.balance
        });
      } catch (err) {
        return sendJSON(res, 400, {
          error: err.message || 'Investissement impossible.'
        });
      }
    }

if (req.method === 'POST' && url === '/api/withdraw') {
      const user = currentUser(req);
      if (!user) {
        return sendJSON(res, 401, { error: 'Connectez-vous d’abord.' });
      }

      const data = await body(req);
      const amount = Number(data.amount);
      const method = String(data.method || '').toLowerCase();
      const recipient = String(data.recipient || '').trim();

      if (!Number.isSafeInteger(amount) || amount < 1000) {
        return sendJSON(res, 400, {
          error: 'Le montant minimum de retrait est de 1 000 FCFA.'
        });
      }

      if (!['wave', 'mtn'].includes(method)) {
        return sendJSON(res, 400, {
          error: 'Choisissez Wave ou MTN MoMo.'
        });
      }

      if (!/^[0-9+ ]{8,20}$/.test(recipient)) {
        return sendJSON(res, 400, {
          error: 'Vérifiez le numéro de réception.'
        });
      }

      const fee = Math.round(amount * 0.08);
      const netAmount = amount - fee;

      try {
        addWithdrawal(user.id, amount, method, recipient, fee, netAmount);
        return sendJSON(res, 201, {
          success: true,
          message: 'Demande enregistrée en attente de traitement.',
          amount,
          fee,
          netAmount,
          method
        });
      } catch (err) {
        return sendJSON(res, 400, {
          error: err.message || 'Impossible d’enregistrer le retrait.'
        });
      }
    }

    serve(req,res);

  } catch (err) {

    console.error('ERREUR:',err);

    if (!res.headersSent) {
      sendJSON(res,500,{
        error:'Erreur interne du serveur.'
      });
    }
  }
});

server.listen(PORT,HOST,()=>{
  console.log('====================================');
  console.log('       🇨🇮 INVESTPRO CI');
  console.log('====================================');
  console.log('SERVEUR ACTIF');
  console.log(`http://${HOST}:${PORT}`);
  console.log('BASE SQLITE : OK');
  console.log('====================================');
});

server.on('error',err=>{
  console.error('ERREUR SERVEUR:',err.message);
});
