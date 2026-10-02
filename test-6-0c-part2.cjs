/* Phase 6.0C part 2 — failures, malformed responses, validation. */
module.exports = async function part2(t) {
  const { check, mk, MEDIA, sent, up, tmp, h } = t;

  // 11. metaMediaId skips upload (single call, direct send)
  const f3 = h.mf(async () => sent('wamid.3'));
  const r3 = await mk(f3).sendMedia('+1555', { ...MEDIA, metaMediaId: 'PRE_UPLOADED' });
  check('11 metaMediaId skips upload', f3.calls.length === 1 && /\/messages$/.test(f3.calls[0].url) && JSON.parse(f3.calls[0].init.body).image.id === 'PRE_UPLOADED' && r3.success === true);

  // 12. provider HTTP failure on upload
  const f4 = h.mf(async () => h.er(500));
  const r4 = await mk(f4).sendMedia('+1555', MEDIA);
  check('12 upload 500 fails', r4.success === false && r4.errorCode === 'WHATSAPP_SEND_FAILED' && f4.calls.length === 1);

  // 13. provider HTTP failure on message send after successful upload
  const f5 = h.mf(async (u) => (String(u).endsWith('/media') ? up('M5') : h.er(500)));
  const r5 = await mk(f5).sendMedia('+1555', MEDIA);
  check('13 message send 500 fails', r5.success === false && r5.errorCode === 'WHATSAPP_SEND_FAILED' && f5.calls.length === 2);

  // 14. unauthorized upload classified as unavailable
  const f6 = h.mf(async () => h.er(401));
  const r6 = await mk(f6).sendMedia('+1555', MEDIA);
  check('14 upload 401 unavailable', r6.success === false && r6.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE');

  // 15. malformed upload response (no id)
  const f7 = h.mf(async (u) => (String(u).endsWith('/media') ? h.ok({ unexpected: true }, 200) : sent('x')));
  const r7 = await mk(f7).sendMedia('+1555', MEDIA);
  check('15 malformed upload resp', r7.success === false && r7.errorCode === 'WHATSAPP_SEND_FAILED' && f7.calls.length === 1);

  // 16. malformed message response after upload (no messages array)
  const f8 = h.mf(async (u) => (String(u).endsWith('/media') ? up('M8') : h.ok({ unexpected: 1 }, 200)));
  const r8 = await mk(f8).sendMedia('+1555', MEDIA);
  check('16 malformed msg resp no wamid', r8.success === true && r8.providerMessageId === undefined);

  // 17. network failure
  const f9 = h.mf(async () => { throw new Error('down'); });
  const r9 = await mk(f9).sendMedia('+1555', MEDIA);
  check('17 network unavailable', r9.success === false && r9.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE');

  // 18. missing local file
  const r10 = await mk(h.mf(async () => h.er(400))).sendMedia('+1555', { path: tmp + '/missing.png', mimeType: 'image/png' });
  check('18 missing file invalid', r10.success === false && r10.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');

  // 19. empty recipient invalid
  const r11 = await mk(h.mf(async () => h.ok({}, 200))).sendMedia('   ', MEDIA);
  check('19 empty to invalid', r11.success === false && r11.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');

  // 20. caption over limit invalid
  const r12 = await mk(h.mf(async () => h.ok({}, 200))).sendMedia('+1555', MEDIA, 'x'.repeat(1025));
  check('20 long caption invalid', r12.success === false && r12.errorCode === 'WHATSAPP_CONFIGURATION_INVALID');

  // 21. no secrets in any result
  const all = JSON.stringify([r3, r4, r5, r6, r7, r9, r10, r11, r12]);
  check('21 no secrets leaked', !all.includes('DUMMY'));
};