const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
const PROTECTED=['cmucj53t000063r8w100k19n3','cmucj53tg00073r8w6zi07kk8'];
(async()=>{
  const before={};
  const cnt=async()=>({
    recipients:await p.recipient.count(),campaigns:await p.campaign.count(),schedules:await p.campaignSchedule.count(),
    executions:await p.campaignExecution.count(),execRecipients:await p.campaignExecutionRecipient.count(),
    campRecipients:await p.campaignRecipient.count(),messages:await p.message.count(),media:await p.media.count(),
    recipientTags:await p.recipientTag.count(),tags:await p.tag.count(),users:await p.user.count(),
    auditLogs:await p.auditLog.count(),loginAttempts:await p.loginAttempt.count(),
  });
  Object.assign(before,await cnt());

  // Media file paths to remove with their Media records (collected BEFORE deleting).
  const media=await p.media.findMany({select:{id:true,filename:true,storagePath:true}});

  // 1..4 execution + schedule + audience (children first)
  const d1=await p.campaignExecutionRecipient.deleteMany({});
  const d2=await p.campaignExecution.deleteMany({});
  const d3=await p.campaignSchedule.deleteMany({});
  const d4=await p.campaignRecipient.deleteMany({});
  // 5 campaigns
  const d5=await p.campaign.deleteMany({});
  // 6 messages (media rows are removed by SetNull? -> delete media explicitly first)
  const d6=await p.media.deleteMany({});
  const d7=await p.message.deleteMany({});
  // 7 recipient-tag associations
  const d8=await p.recipientTag.deleteMany({});
  // 8 every recipient except the two protected IDs (explicit id exclusion)
  const del=await p.recipient.findMany({select:{id:true},where:{id:{notIn:PROTECTED}}});
  const d9=await p.recipient.deleteMany({where:{id:{notIn:PROTECTED}}});

  const after=await cnt();
  console.log('DELETED '+JSON.stringify({
    campaignExecutionRecipient:d1.count,campaignExecution:d2.count,campaignSchedule:d3.count,
    campaignRecipient:d4.count,campaign:d5.count,media:d6.count,message:d7.count,
    recipientTag:d8.count,recipients:d9.count,recipientsTargeted:del.length,
  }));
  console.log('AFTER '+JSON.stringify(after));
  console.log('MEDIA_FILES '+JSON.stringify(media.map(m=>({id:m.id,filename:m.filename,storagePath:m.storagePath}))));
})().catch(async e=>{console.error('ERR',e.message);await p.$disconnect();process.exit(1)});
