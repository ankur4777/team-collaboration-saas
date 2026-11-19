import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:5173';
async function eventually(fn, message, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(message);
}
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({ permissions: ['camera', 'microphone'] }),
    ),
  );
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = contexts[i];
    const csrf = await context.request.get(base + '/api/auth/csrf/');
    const token = (await csrf.json()).csrf_token;
    const login = await context.request.post(base + '/api/auth/login/', {
      headers: { 'X-CSRFToken': token },
      data: {
        email: i ? 'call-member@example.test' : 'call-owner@example.test',
        password: 'BrowserTestOnly123!',
      },
    });
    assert.equal(login.status(), 200, await login.text());
    const page = await context.newPage();
    pages.push(page);
    await page.goto(base + '/?meeting=11111111-1111-4111-8111-111111111111');
    await page
      .getByRole('button', { name: 'Join meeting', exact: true })
      .click();
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await page
      .getByRole('button', { name: 'Leave call', exact: true })
      .waitFor();
  }
  const [owner, member] = pages;
  for (const page of pages) {
    await eventually(
      () =>
        page
          .locator('[data-call-peer="remote"][data-state="connected"] video')
          .evaluate(
            (el) =>
              el.readyState >= 2 &&
              el.videoWidth > 0 &&
              el.srcObject
                .getAudioTracks()
                .some((t) => t.readyState === 'live'),
          ),
      'Real audio/video tracks did not connect',
    );
  }
  await owner
    .getByRole('button', { name: 'Mute microphone', exact: true })
    .click();
  await eventually(
    () =>
      member
        .locator('[data-call-peer="remote"] .call-person svg')
        .count()
        .then((n) => n > 0),
    'Remote mute state did not update',
  );
  await owner
    .getByRole('button', { name: 'Turn camera off', exact: true })
    .click();
  await member
    .locator('[data-call-peer="remote"] video.camera-hidden')
    .waitFor();
  const media = await member
    .locator('[data-call-peer="local"] video')
    .evaluateHandle((el) => el.srcObject);
  await member.getByRole('button', { name: 'Leave call', exact: true }).click();
  assert.equal(
    await media.evaluate((stream) =>
      stream.getTracks().every((t) => t.readyState === 'ended'),
    ),
    true,
    'Leaving did not stop local devices',
  );
  await eventually(
    () =>
      owner
        .locator('[data-call-peer="remote"]')
        .count()
        .then((n) => n === 0),
    'Left peer was not removed',
  );
  await new Promise((r) => setTimeout(r, 400));
  await member
    .getByRole('button', { name: 'Join meeting', exact: true })
    .click();
  await member.getByRole('button', { name: 'Join call', exact: true }).click();
  await eventually(
    () =>
      member
        .locator('[data-call-peer="remote"][data-state="connected"] video')
        .evaluate((el) => el.readyState >= 2),
    'Rejoin failed',
  );
  owner.once('dialog', (dialog) => dialog.accept());
  await owner
    .getByRole('button', { name: 'End for everyone', exact: true })
    .click();
  await eventually(
    () =>
      member
        .getByRole('alert')
        .textContent()
        .then((t) => t.includes('call ended')),
    'Organizer end did not stop the other client',
    20000,
  );
  console.log(
    'PASS: two-browser native audio/video, mute, camera off, leave/rejoin, media cleanup and organizer end.',
  );
  await Promise.all(contexts.map((c) => c.close()));
} finally {
  await browser.close();
}
