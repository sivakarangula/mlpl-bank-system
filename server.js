const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let masterAccounts = [];

function loadMasterCSV() {
  const results = [];
  const csvFilePath = path.join(__dirname, 'MLPL PARTY ACC LIST - LIST.csv');
  
  if (fs.existsSync(csvFilePath)) {
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => {
        const name = data['Name'] || data['name'] || Object.values(data)[0];
        const acc = data['Account Number'] || data['account number'] || Object.values(data)[1];
        const ifsc = data['IFSC Code'] || data['ifsc code'] || Object.values(data)[2];
        
        if (name && acc && ifsc) {
          results.push({
            name: name.trim(),
            acc: String(acc).trim(),
            ifsc: ifsc.trim().toUpperCase()
          });
        }
      })
      .on('end', () => {
        masterAccounts = results;
        console.log(`Successfully loaded ${results.length} master accounts from CSV on cloud server.`);
      });
  } else {
    console.warn('Master CSV file not found in root directory.');
  }
}

loadMasterCSV();

// API endpoint to serve master accounts
app.get('/api/accounts', (req, res) => {
  res.json(masterAccounts);
});

// API endpoint to add new master account and update server CSV
app.post('/api/accounts', (req, res) => {
  const { name, acc, ifsc } = req.body;
  if (!name || !acc || !ifsc) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const newEntry = { name: name.trim(), acc: String(acc).trim(), ifsc: ifsc.trim().toUpperCase() };
  masterAccounts.push(newEntry);

  const csvLine = `\n"${newEntry.name}","${newEntry.acc}","${newEntry.ifsc}"`;
  fs.appendFile(path.join(__dirname, 'MLPL PARTY ACC LIST - LIST.csv'), csvLine, (err) => {
    if (err) console.error('Failed to append to CSV file', err);
  });

  res.json({ success: true, accounts: masterAccounts });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
