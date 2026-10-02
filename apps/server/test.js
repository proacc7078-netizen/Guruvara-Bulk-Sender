const { prisma } = require('./src/config/db');

async function test() {
  try {
    const recipients = await prisma.recipient.findMany();
    console.log('Recipients:', recipients);
    if (recipients.length > 0) {
      console.log('First recipient:', recipients[0]);
      console.log('Fields:', Object.keys(recipients[0]));
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

test();