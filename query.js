const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.db');
db.all('SELECT id, name, phone, email, account, priority FROM leads ORDER BY id DESC LIMIT 20', (err, rows) => {
  if (err) console.error(err);
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});


