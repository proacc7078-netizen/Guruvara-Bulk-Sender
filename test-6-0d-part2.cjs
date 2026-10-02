/* Phase 6.0D part 2 — failure/retry handling parity between media and text paths. */
module.exports = async function part2(t) {
  const { check, del, idOf, seedExecution, calls, prisma, providerMod, adapter } = t;
  const imgPath = t.imgPath;
  const row = (e, r) => prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId: e.id, recipientId: r.id } } });

  // 8. media provider failure → existing retry handling (5xx retryable, with metaError like the real adapter)
  providerMod.whatsappProviderRegistry.getAdapter = () => ({ ...adapter, sendMedia: async () => ({ success: false, errorCode: 'WHATSAPP_SEND_FAILED', errorMessage: 'Meta API image send failed with status 500.', metaError: { httpStatus: 500 } }) });
  const t3 = await seedExecution(imgPath, 'fail caption');
  const r3 = await del.sendExecutionRecipient(idOf(t3.exec, t3.recip));
  check('8 media failure retried', r3.success === false && r3.retryScheduled === true, JSON.stringify(r3));
  const w3 = await row(t3.exec, t3.recip);
  check('9 status PENDING w/ nextAttempt', w3.status === 'PENDING' && w3.nextAttemptAt !== null && w3.errorCode === 'WHATSAPP_SEND_FAILED');

  // 10. text failure path unchanged (same 5xx shape the real adapter returns)
  providerMod.whatsappProviderRegistry.getAdapter = () => ({ ...adapter, sendText: async () => ({ success: false, errorCode: 'WHATSAPP_SEND_FAILED', errorMessage: 'Meta API text send failed with status 500.', metaError: { httpStatus: 500 } }) });
  const t4 = await seedExecution(null, 'fail text');
  const r4 = await del.sendExecutionRecipient(idOf(t4.exec, t4.recip));
  check('10 text failure retried same', r4.success === false && r4.retryScheduled === true);

  // 11. media auth failure handled by existing classification (401 metaError)
  providerMod.whatsappProviderRegistry.getAdapter = () => ({ ...adapter, sendMedia: async () => ({ success: false, errorCode: 'WHATSAPP_PROVIDER_UNAVAILABLE', errorMessage: 'Meta rejected the configured credentials (unauthorized).', metaError: { httpStatus: 401 } }) });
  const t5 = await seedExecution(imgPath, 'auth fail caption');
  const r5 = await del.sendExecutionRecipient(idOf(t5.exec, t5.recip));
  const w5 = await row(t5.exec, t5.recip);
  check('11 media auth failure handled', r5.success === false && (r5.retryScheduled === true || w5.status === 'FAILED'), 'row=' + w5.status + ' scheduled=' + r5.retryScheduled);

  // 12. no-media behavior unchanged: recorded text sends carry (to, msg) only, never a media payload
  // (>=1 because test 10's failure adapter doesn't route through the recording mock)
  check('12 no-media path untouched', calls.sendText.length >= 1 && calls.sendText.every((c) => typeof c.to === 'string' && typeof c.msg === 'string' && !('media' in c) && !('caption' in c)));
};