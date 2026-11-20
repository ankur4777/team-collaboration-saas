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
    // Deterministic speech results: Chrome's remote recognition service is not used in CI.
    await context.addInitScript(() => {
      class SpeechFixture {
        start() {
          this.running = true;
          window.__callSpeech = this;
        }
        abort() {
          this.running = false;
        }
      }
      Object.defineProperty(window, 'SpeechRecognition', {
        value: SpeechFixture,
        configurable: true,
      });
      window.__emitCallSpeech = (text) => {
        const engine = window.__callSpeech;
        if (engine?.running)
          engine.onresult?.({
            resultIndex: 0,
            results: {
              length: 1,
              0: { isFinal: true, 0: { transcript: text } },
            },
          });
      };
    });
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
    if (i === 0) {
      await page.goto(base + '/');
      await page.getByRole('button', { name: 'Calendar', exact: true }).click();
      await page
        .getByRole('button', { name: 'New event', exact: true })
        .waitFor();
      await page.locator('.wc-event').first().waitFor();
      await page.screenshot({ path: 'call-test-results/calendar-month.png' });
      await page
        .getByRole('navigation', { name: 'Calendar views' })
        .getByRole('button', { name: 'Work week', exact: true })
        .click();
      await eventually(
        () =>
          page
            .locator('.wc-time-column')
            .count()
            .then((n) => n === 5),
        'Work week did not show five days',
      );
      await page.screenshot({
        path: 'call-test-results/calendar-work-week.png',
      });
      await page
        .getByRole('navigation', { name: 'Calendar views' })
        .getByRole('button', { name: 'Week', exact: true })
        .click();
      assert.equal(await page.locator('.wc-time-column').count(), 7);
      await page
        .getByRole('navigation', { name: 'Calendar views' })
        .getByRole('button', { name: 'Day', exact: true })
        .click();
      await page.screenshot({ path: 'call-test-results/calendar-day.png' });
      await page.locator('.wc-time-slot').nth(14).click();
      const form = page.getByRole('dialog', {
        name: 'Schedule meeting',
        exact: true,
      });
      await form.waitFor();
      assert.ok(
        (
          await form
            .locator('input[type="datetime-local"]')
            .first()
            .inputValue()
        ).endsWith('T14:00'),
        'Calendar time slot was not prefilled',
      );
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page
        .getByRole('button', { name: 'Filter calendar', exact: true })
        .click();
      await page
        .getByRole('checkbox', { name: 'Organized by me', exact: true })
        .uncheck();
      assert.equal(await page.locator('.wc-timed-event.owned').count(), 0);
      await page
        .getByRole('checkbox', { name: 'Organized by me', exact: true })
        .check();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Search calendar', exact: true })
        .fill('Product planning');
      await page.locator('.wc-timed-event').first().waitFor();
      assert.equal(await page.locator('.wc-timed-event').count(), 1);
      await page
        .getByRole('button', { name: 'Clear calendar search', exact: true })
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      await eventually(
        () =>
          page
            .locator('.wc-sidebar')
            .count()
            .then((n) => n === 0),
        'Mini calendar did not adapt to mobile',
      );
      await page.screenshot({ path: 'call-test-results/calendar-mobile.png' });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        'Calendar overflowed the mobile viewport',
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(base + '/?meeting=11111111-1111-4111-8111-111111111111');
    }
    await page
      .getByRole('button', { name: 'Join meeting', exact: true })
      .click();
    await page.getByRole('button', { name: 'Join call', exact: true }).click();
    await page
      .getByRole('button', { name: 'Leave call', exact: true })
      .waitFor();
    if (i === 0) {
      await page
        .getByRole('button', { name: 'Turn camera off', exact: true })
        .click();
      await page.locator('.call-grid.solo .call-avatar-disc').waitFor();
      assert.equal(
        await page.locator('.call-grid .call-tile').count(),
        1,
        'A solo room must have one centered tile',
      );
      assert.equal(
        await page.locator('.call-waiting').count(),
        0,
        'Waiting placeholder still occupies half the room',
      );
      assert.equal(
        await page.locator('.call-control-dock').evaluate((el) => {
          const b = el.getBoundingClientRect();
          return Math.abs((b.left + b.right) / 2 - innerWidth / 2) < 16;
        }),
        true,
        'The floating dock is not centered',
      );
      await page.screenshot({ path: 'call-test-results/solo-room.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: 'call-test-results/solo-room-mobile.png' });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        'Solo room overflows mobile viewport',
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await page
        .getByRole('button', { name: 'Turn camera on', exact: true })
        .click();
    }
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
    .getByRole('button', { name: 'Emoji reactions', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'React with Thumbs up', exact: true })
    .click();
  await member
    .getByRole('status', { name: 'Live reactions', exact: true })
    .getByText('👍', { exact: true })
    .waitFor();
  await owner
    .getByRole('button', { name: 'Turn on captions', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Start my speech captions', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Close accessibility settings', exact: true })
    .click();
  await member
    .getByRole('button', { name: 'Translate speech', exact: true })
    .click();
  await member
    .getByRole('checkbox', { name: 'Translate new captions', exact: true })
    .check();
  await member
    .getByRole('button', { name: 'Close accessibility settings', exact: true })
    .click();
  await owner.evaluate(() =>
    window.__emitCallSpeech('Caption test from owner'),
  );
  await member
    .getByRole('log', { name: 'Live captions', exact: true })
    .getByText('मालिक की ओर से कैप्शन परीक्षण', { exact: true })
    .waitFor();
  await member
    .getByRole('log', { name: 'Live captions', exact: true })
    .getByText('Caption test from owner', { exact: true })
    .waitFor();
  await member.screenshot({
    path: 'call-test-results/translated-captions.png',
  });
  await owner
    .getByRole('button', { name: 'Mute microphone', exact: true })
    .click();
  await owner.evaluate(() =>
    window.__emitCallSpeech('Muted caption should not be sent'),
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    await member
      .getByText('Muted caption should not be sent', { exact: true })
      .count(),
    0,
  );
  await owner
    .getByRole('button', { name: 'Unmute microphone', exact: true })
    .click();
  await owner
    .getByRole('button', { name: 'Turn off captions', exact: true })
    .click();
  await member
    .getByRole('button', { name: 'Turn off captions', exact: true })
    .click();
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
  await owner
    .getByRole('button', { name: 'Participants', exact: true })
    .click();
  await owner.screenshot({
    path: 'call-test-results/desktop-participants.png',
  });
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.screenshot({ path: 'call-test-results/mobile-participants.png' });
  assert.equal(
    await owner.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    'Call overflows mobile viewport',
  );
  await owner
    .getByRole('button', { name: 'Close side panel', exact: true })
    .click();
  await owner.setViewportSize({ width: 1280, height: 720 });
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
  assert.ok(
    await owner
      .locator('[data-call-peer="local"] video')
      .evaluate(
        (el) => el.srcObject.getVideoTracks()[0].getSettings().displaySurface,
      ),
    'Presentation is not a native display capture',
  );
  assert.equal(
    await member.locator('.call-grid.spotlight').evaluate((grid) => {
      const focus = grid.querySelector('.focused').getBoundingClientRect();
      const others = [...grid.querySelectorAll('.call-tile:not(.focused)')];
      return (
        focus.width >= grid.clientWidth - 42 &&
        others.every((tile) => tile.getBoundingClientRect().top >= focus.bottom)
      );
    }),
    true,
    'Presentation did not fill the stage or overlapped another tile',
  );
  await member.screenshot({
    path: 'call-test-results/remote-presentation.png',
  });
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
  const deleteButton = owner.getByRole('button', {
    name: 'Delete meeting',
    exact: true,
  });
  await deleteButton.waitFor();
  assert.equal(
    await owner
      .getByRole('button', { name: 'Cancel meeting', exact: true })
      .count(),
    0,
    'Ended meeting still offers Cancel',
  );
  await owner.screenshot({
    path: 'call-test-results/ended-meeting-delete.png',
  });
  owner.once('dialog', (dialog) => dialog.accept());
  await deleteButton.click();
  await owner.getByText('Meeting deleted.', { exact: true }).waitFor();
  assert.equal(
    (
      await contexts[1].request.get(
        base + '/api/meetings/11111111-1111-4111-8111-111111111111/',
      )
    ).status(),
    404,
    'Deleted meeting remains visible to an attendee',
  );
  console.log(
    'PASS: native audio/video, reactions, deterministic speech/caption transport and translation adapter, hand raising, participant list, plain-text live chat, layouts, screen sharing/restoration, mute, camera, leave/rejoin, cleanup, organizer end and confirmed meeting deletion.',
  );
  await Promise.all(contexts.map((c) => c.close()));
} finally {
  await browser.close();
}
