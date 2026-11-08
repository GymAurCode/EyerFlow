const { app } = require('electron');
const { join } = require('node:path');
app.setPath('userData', join(process.env.APPDATA, 'EyerStock-dev'));
app.whenReady().then(() => {
  try {
    const dir = join(process.env.APPDATA, 'EyerStock-dev');
    const { key } = require('../dist/data/encrypted-connection').resolveEncryptionKey(dir);
    const db = require('../dist/data/connection').openForInspection(join(dir, 'eyerstock.db'), key, true);
    try {
      const data = require('../dist/main/repositories/mms/analytics').mmsDashboard(db, {});
      console.log('Dashboard loaded:', JSON.stringify({ totalMo: data.totalMo }));
    } catch (error) { console.error('ORIGINAL DASHBOARD ERROR:', error.stack); }
    db.close();
  } catch (error) { console.error(error.stack); }
  app.quit();
});
