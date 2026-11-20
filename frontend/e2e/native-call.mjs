import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
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
await mkdir('call-test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CALL_TEST_CHROMIUM || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--auto-select-desktop-capture-source=Entire screen',
    '--allow-http-screen-capture',
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
  await owner.getByRole('button', { name: 'Raise hand', exact: true }).click();
  await member
    .getByRole('button', { name: 'Participants', exact: true })
    .click();
  await member
    .getByRole('complementary', { name: 'Participants', exact: true })
    .getByText('Hand raised', { exact: true })
    .waitFor();
  await owner.getByRole('button', { name: 'Lower hand', exact: true }).click();
  await member
    .getByRole('button', { name: 'Close side panel', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'In-call chat', exact: true })
    .click();
  await owner
    .getByLabel('Message everyone', { exact: true })
    .fill('Live call message <b>stays plain text</b>');
  await owner
    .getByRole('button', { name: 'Send chat message', exact: true })
    .click();
  await member
    .getByRole('button', { name: 'In-call chat', exact: true })
    .click();
  await member
    .getByRole('log', { name: 'Call messages' })
    .getByText('Live call message <b>stays plain text</b>', { exact: true })
    .waitFor();
  assert.equal(
    await member.locator('.call-messages b').count(),
    0,
    'Chat interpreted HTML',
  );
  await owner
    .getByRole('button', { name: 'Close side panel', exact: true })
    .click();
  await member
    .getByRole('button', { name: 'Close side panel', exact: true })
    .click();
  await owner.getByRole('button', {name:'Participants',exact:true}).click();
  await owner.screenshot({path:'call-test-results/desktop-participants.png'});
  await owner.setViewportSize({width:390,height:844});
  await owner.screenshot({path:'call-test-results/mobile-participants.png'});
  assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Call overflows mobile viewport');
  await owner.getByRole('button',{name:'Close side panel',exact:true}).click();
  await owner.setViewportSize({width:1280,height:720});
  await owner
    .getByLabel('Call layout', { exact: true })
    .selectOption('spotlight');
  await owner.locator('.call-grid.spotlight .call-tile.focused').waitFor();
  await owner
    .getByRole('button', { name: 'Present screen', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Stop presenting', exact: true })
    .first()
    .waitFor();
  await member.locator('[data-call-peer="remote"].presenting').waitFor();
  await eventually(
    () =>
      member
        .locator('[data-call-peer="remote"].presenting video')
        .evaluate((el) => el.videoWidth > 0 && el.readyState >= 2),
    'Screen video did not reach other client',
  );
  assert.ok(await owner.locator('[data-call-peer="local"] video').evaluate(el=>el.srcObject.getVideoTracks()[0].getSettings().displaySurface),'Presentation is not a native display capture');
  await member.screenshot({path:'call-test-results/remote-presentation.png'});
  const display = await owner
    .locator('[data-call-peer="local"] video')
    .evaluateHandle((el) => el.srcObject);
  await owner
    .getByRole('button', { name: 'Stop presenting', exact: true })
    .first()
    .click();
  await eventually(
    () =>
      member
        .locator('[data-call-peer="remote"].presenting')
        .count()
        .then((n) => n === 0),
    'Screen sharing state did not stop',
  );
  assert.equal(
    await display.evaluate((stream) =>
      stream.getTracks().every((t) => t.readyState === 'ended'),
    ),
    true,
    'Screen capture was not stopped',
  );
  await eventually(
    () =>
      member
        .locator('[data-call-peer="remote"] video')
        .evaluate((el) => el.readyState >= 2 && el.videoWidth > 0),
    'Camera did not restore',
  );
  await owner.getByLabel('Call layout', { exact: true }).selectOption('auto');
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
    'PASS: native audio/video, hand raising, participant list, plain-text live chat, layouts, screen sharing/restoration, mute, camera, leave/rejoin, cleanup and organizer end.',
  );
  await Promise.all(contexts.map((c) => c.close()));
} finally {
  await browser.close();
}
