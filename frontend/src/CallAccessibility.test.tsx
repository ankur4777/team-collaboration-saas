// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CallAccessibility, { type AccessEvent } from './CallAccessibility';
import { callsApi } from './api';
vi.mock('./api', () => ({ callsApi: { translate: vi.fn() } }));
class FakeSpeech {
  static instances: FakeSpeech[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onresult:
    | ((event: {
        resultIndex: number;
        results: {
          length: number;
          [n: number]: {
            isFinal: boolean;
            [n: number]: { transcript: string };
          };
        };
      }) => void)
    | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeSpeech.instances.push(this);
  }
  emit(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, 0: { transcript: text } } },
    });
  }
}
let stage: HTMLDivElement;
const send = vi.fn();
const props = () => ({
  meetingId: 'test-meeting',
  userId: 'self',
  event: null as AccessEvent | null,
  send,
  audio: true,
  isMicActive: () => true,
  stage,
  translationReady: true,
});
const caption = (id = 'caption-1'): AccessEvent => ({
  type: 'caption',
  caption: {
    id,
    sender: { id: 'peer', user_id: 'other', name: 'Teammate' },
    text: 'Hello team',
    language: 'en-US',
    sent_at: new Date().toISOString(),
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  FakeSpeech.instances = [];
  vi.stubGlobal('SpeechRecognition', FakeSpeech);
  stage = document.createElement('div');
  document.body.append(stage);
});
afterEach(() => {
  cleanup();
  stage.remove();
  vi.unstubAllGlobals();
});
describe('Call captions and reactions', () => {
  it('sends only the selected reaction and displays authenticated incoming names', async () => {
    const user = userEvent.setup(),
      p = props();
    const ui = render(<CallAccessibility {...p} />);
    await user.click(
      screen.getByRole('button', { name: 'Emoji reactions' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'React with Thumbs up' }),
    );
    expect(send).toHaveBeenCalledWith({ type: 'reaction', emoji: '👍' });
    ui.rerender(
      <CallAccessibility
        {...p}
        event={{
          type: 'reaction',
          reaction: {
            id: 'r',
            emoji: '👏',
            sender: { id: 'p', user_id: 'other', name: 'Teammate' },
            sent_at: new Date().toISOString(),
          },
        }}
      />,
    );
    expect(await screen.findByText('👏')).toBeTruthy();
    expect(screen.getByText('Teammate')).toBeTruthy();
  });
  it('requires explicit opt-in, captions own speech, aborts on mute and stops on unmount', async () => {
    const user = userEvent.setup(),
      p = props();
    const ui = render(<CallAccessibility {...p} />);
    await user.click(
      screen.getByRole('button', { name: 'Turn on captions' }),
    );
    expect(FakeSpeech.instances).toHaveLength(0);
    await user.click(
      screen.getByRole('button', {
        name: 'Start my speech captions',
      }),
    );
    await waitFor(() => expect(FakeSpeech.instances).toHaveLength(1));
    const engine = FakeSpeech.instances[0];
    engine.emit('Words from me');
    expect(send).toHaveBeenCalledWith({
      type: 'caption',
      text: 'Words from me',
      language: 'en-US',
    });
    ui.rerender(
      <CallAccessibility {...p} audio={false} isMicActive={() => false} />,
    );
    await waitFor(() => expect(engine.abort).toHaveBeenCalled());
    send.mockClear();
    engine.emit('Muted words');
    expect(send).not.toHaveBeenCalled();
    ui.unmount();
  });
  it('translates incoming captions while retaining original plain text', async () => {
    vi.mocked(callsApi.translate).mockResolvedValue({ text: 'नमस्ते टीम' });
    const user = userEvent.setup(),
      p = props();
    const ui = render(<CallAccessibility {...p} />);
    await user.click(
      screen.getByRole('button', { name: 'Translate speech' }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Translate new captions',
      }),
    );
    ui.rerender(<CallAccessibility {...p} event={caption()} />);
    expect(await screen.findByText('नमस्ते टीम')).toBeTruthy();
    expect(screen.getByText('Hello team')).toBeTruthy();
    expect(callsApi.translate).toHaveBeenCalledWith('test-meeting', {
      text: 'Hello team',
      source: 'en',
      target: 'hi',
    });
  });
  it('shows unconfigured translation and unsupported recognition without a fake success state', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const user = userEvent.setup();
    render(<CallAccessibility {...props()} translationReady={false} />);
    await user.click(
      screen.getByRole('button', { name: 'Translate speech' }),
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Translate new captions',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/This browser cannot caption your microphone/),
    ).toBeTruthy();
    expect(screen.getByText(/administrator must configure/)).toBeTruthy();
  });
});
