const path = require('path');
const clientPath = require.resolve('@prisma/client');
console.log('@prisma/client path:', clientPath);
// The bin might be in the same package or in a separate @prisma/cli
// Let's check if there is a prisma binary in the client package
const fs = require('fs');
const binPath = path.join(path.dirname(clientPath), '../../.bin/prisma');
console.log('Possible prisma binary path:', binPath);
console.log('Exists:', fs.existsSync(binPath));