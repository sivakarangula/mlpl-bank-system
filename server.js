const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite database
const db = new sqlite3.Database(path.join(__dirname, 'mlpl_database.db'), (err) => {
  if (err) console.error('Database opening error:', err);
  else console.log('Connected to SQLite database.');
});

// Setup Tables & Seed Data
db.serialize(() => {
  // 1. Master Beneficiaries Table
  db.run(`
    CREATE TABLE IF NOT EXISTS master_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      acc TEXT NOT NULL UNIQUE,
      ifsc TEXT NOT NULL
    )
  `);

  // 2. In-Progress Saved Payment Entries Table
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txType TEXT NOT NULL,
      debitAcc TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      creditAcc TEXT NOT NULL,
      ifsc TEXT NOT NULL,
      particulars TEXT NOT NULL,
      partyName TEXT NOT NULL
    )
  `);

  // Seed 5,937 accounts from CSV if database is empty
  db.get('SELECT COUNT(*) AS count FROM master_accounts', (err, row) => {
    if (!err && row.count === 0) {
      const csvFilePath = path.join(__dirname, 'master_accounts.csv');
      if (fs.existsSync(csvFilePath)) {
        console.log('Seeding master accounts from CSV...');
        const stmt = db.prepare('INSERT OR IGNORE INTO master_accounts (name, acc, ifsc) VALUES (?, ?, ?)');
        fs.createReadStream(csvFilePath)
          .pipe(csv())
          .on('data', (data) => {
            const name = (data['Name'] || data['name'] || '').trim();
            const acc = (data['Account Number'] || data['acc'] || '').trim();
            const ifsc = (data['IFSC Code'] || data['ifsc'] || '').trim().toUpperCase();
            if (name && acc && ifsc) {
              stmt.run(name, acc, ifsc);
            }
          })
          .on('end', () => {
            stmt.finalize();
            console.log('Master accounts seeded successfully.');
          });
      }
    }
  });
});

// Authentication Endpoint
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'SIVAKARANGULA' && password === '207456') {
    return res.json({ success: true, message: 'Authenticated' });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

// Get Master Accounts Count & Search
app.get('/api/accounts/count', (req, res) => {
  db.get('SELECT COUNT(*) AS count FROM master_accounts', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ count: row.count });
  });
});

app.get('/api/accounts/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const isDigits = /^\d+$/.test(q);
  let query, params;

  if (isDigits) {
    query = 'SELECT name, acc, ifsc FROM master_accounts WHERE acc LIKE ? OR acc LIKE ? LIMIT 50';
    params = [`%${q}`, `${q}%`];
  } else {
    query = 'SELECT name, acc, ifsc FROM master_accounts WHERE name LIKE ? OR acc LIKE ? LIMIT 50';
    params = [`%${q}%`, `%${q}%`];
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add New Master Beneficiary (Persists to database for all devices)
app.post('/api/accounts/add', (req, res) => {
  const { name, acc, ifsc } = req.body;
  if (!name || !acc || !ifsc) return res.status(400).json({ error: 'Missing fields' });

  const stmt = db.prepare('INSERT INTO master_accounts (name, acc, ifsc) VALUES (?, ?, ?)');
  stmt.run(name.trim(), acc.trim(), ifsc.trim().toUpperCase(), function (err) {
    if (err) return res.status(400).json({ error: 'Account already exists' });
    db.get('SELECT COUNT(*) AS count FROM master_accounts', (cErr, cRow) => {
      res.json({ success: true, count: cRow.count });
    });
  });
  stmt.finalize();
});

// Export all Master Accounts
app.get('/api/accounts/export', (req, res) => {
  db.all('SELECT name, acc, ifsc FROM master_accounts ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    let csvData = 'Name,Account Number,IFSC Code\n';
    rows.forEach(r => {
      csvData += `"${r.name.replace(/"/g, '""')}",${r.acc},${r.ifsc}\n`;
    });
    res.header('Content-Type', 'text/csv');
    res.attachment('master_accounts.csv');
    res.send(csvData);
  });
});

// In-Progress Payment Entries Endpoints (Shared across all sessions)
app.get('/api/entries', (req, res) => {
  db.all('SELECT * FROM saved_entries ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/entries', (req, res) => {
  const { txType, debitAcc, amount, currency, creditAcc, ifsc, particulars, partyName } = req.body;
  const numAmt = parseFloat(amount);

  if (numAmt >= 100000) {
    return res.status(400).json({ error: 'Amount must be below ₹1,00,000 only.' });
  }

  // Check if same credit account and amount exists
  db.get('SELECT * FROM saved_entries WHERE creditAcc = ? AND amount = ?', [creditAcc, numAmt.toFixed(2)], (err, existing) => {
    if (existing && !req.body.forceUpdate) {
      return res.json({ duplicate: true, existingId: existing.id, currentAmount: existing.amount });
    }

    if (req.body.addToExistingId) {
      const combined = (parseFloat(existing.amount) + numAmt).toFixed(2);
      if (parseFloat(combined) >= 100000) {
        return res.status(400).json({ error: 'Combined total exceeds limit of ₹1,00,000.' });
      }
      db.run('UPDATE saved_entries SET amount = ?, txType = ? WHERE id = ?', [combined, txType, req.body.addToExistingId], () => {
        res.json({ success: true });
      });
    } else {
      const stmt = db.prepare(`
        INSERT INTO saved_entries (txType, debitAcc, amount, currency, creditAcc, ifsc, particulars, partyName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(txType, debitAcc, numAmt.toFixed(2), currency, creditAcc, ifsc, particulars, partyName, () => {
        res.json({ success: true });
      });
      stmt.finalize();
    }
  });
});

app.put('/api/entries/:id', (req, res) => {
  const { txType, amount } = req.body;
  const numAmt = parseFloat(amount);
  if (numAmt >= 100000) return res.status(400).json({ error: 'Amount must be below ₹1,00,000 only.' });

  db.run('UPDATE saved_entries SET txType = ?, amount = ? WHERE id = ?', [txType, numAmt.toFixed(2), req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/entries/:id', (req, res) => {
  db.run('DELETE FROM saved_entries WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/entries', (req, res) => {
  db.run('DELETE FROM saved_entries', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});