const path = require('path');
const fs = require('fs');
const clientPath = require.resolve('@prisma/client');
const clientPackagePath = path.join(path.dirname(clientPath), 'package.json');
const clientPackage = JSON.parse(fs.readFileSync(clientPackagePath, 'utf8'));
console.log('@prisma/client package.json:', JSON.stringify(clientPackage, null, 2));