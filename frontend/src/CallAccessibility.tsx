import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smile, Captions, Languages, X, Mic, Volume2 } from 'lucide-react';
import { callsApi } from './api';

type Speaker = { id: string; user_id: string; name: string };
type Caption = {
  id: string;
  sender: Speaker;
  text: string;
  language: string;
  sent_at: string;
  translated?: string;
  received?: number;
};
type Reaction = {
  id: string;
  sender: Speaker;
  emoji: string;
  sent_at: string;
  received?: number;
};
export type AccessEvent =
  | { type: 'caption'; caption: Caption }
  | { type: 'reaction'; reaction: Reaction };
type SpeechResultEvent = {
  resultIndex: number;
  results: {
    length: number;
    [n: number]: { isFinal: boolean; [n: number]: { transcript: string } };
  };
};
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['hi-IN', 'Hindi'],
  ['pa-IN', 'Punjabi'],
  ['fr-FR', 'French'],
  ['es-ES', 'Spanish'],
  ['de-DE', 'German'],
  ['pt-BR', 'Portuguese'],
  ['ar-SA', 'Arabic'],
  ['bn-IN', 'Bengali'],
  ['ja-JP', 'Japanese'],
];
const TARGETS = LANGUAGES.filter(([code]) => code !== 'en-GB').map(
  ([code, label]) => [
    code.split('-')[0],
    label === 'English (US)' ? 'English' : label,
  ],
);
const EMOJI = [
  ['👍', 'Thumbs up'],
  ['👏', 'Applause'],
  ['❤️', 'Heart'],
  ['😂', 'Laugh'],
  ['🎉', 'Celebrate'],
  ['🙌', 'Raised hands'],
  ['😮', 'Surprised'],
  ['👎', 'Thumbs down'],
];

export default function CallAccessibility({
  meetingId,
  userId,
  event,
  send,
  audio,
  isMicActive,
  stage,
  translationReady,
}: {
  meetingId: string;
  userId: string;
  event: AccessEvent | null;
  send: (body: unknown) => void;
  audio: boolean;
  isMicActive: () => boolean;
  stage: HTMLElement | null;
  translationReady: boolean;
}) {
  const [popover, setPopover] = useState<
    'emoji' | 'captions' | 'translate' | null
  >(null);
  const [enabled, setEnabled] = useState(false);
  const [share, setShare] = useState(false);
  const [language, setLanguage] = useState('en-US');
  const [target, setTarget] = useState('hi');
  const [translate, setTranslate] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const live = useRef(true),
    generation = useRef(0),
    pending = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const voiceOwned = useRef(false);
  const mic = useRef(isMicActive);
  mic.current = isMicActive;
  const outbound = useRef(send);
  outbound.current = send;
  const preferences = useRef({ enabled, translate, target, readAloud });
  preferences.current = { enabled, translate, target, readAloud };
  const engine =
    (window as SpeechWindow).SpeechRecognition ||
    (window as SpeechWindow).webkitSpeechRecognition;
  const spoken = useRef(new Set<string>());
  function stopVoice() {
    if (voiceOwned.current) {
      window.speechSynthesis?.cancel();
      voiceOwned.current = false;
    }
  }
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      stopVoice();
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setCaptions([]);
    setError('');
    stopVoice();
    if (!enabled) setShare(false);
  }, [enabled, translate, target]);
  useEffect(() => {
    if (!readAloud) stopVoice();
  }, [readAloud]);
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setReactions((old) => old.filter((r) => now - (r.received || 0) < 4000));
      setCaptions((old) => old.filter((c) => now - (c.received || 0) < 18000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!share || !enabled || !audio || !engine) {
      setStatus(
        share && !audio ? 'Paused while your microphone is muted.' : '',
      );
      return;
    }
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const recognition = new engine();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = false;
    let failures = 0;
    function start() {
      if (!active || !mic.current()) return;
      try {
        recognition.start();
        setStatus('Listening to your microphone…');
      } catch {
        setError(
          'Speech recognition could not start. Check microphone permission or try another supported browser.',
        );
        setShare(false);
      }
    }
    recognition.onresult = (e) => {
      if (!active || !mic.current() || !preferences.current.enabled) return;
      failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim().slice(0, 500);
          if (text) outbound.current({ type: 'caption', text, language });
        }
    };
    recognition.onerror = (e) => {
      if (!active) return;
      if (e.error === 'no-speech') return;
      active = false;
      setShare(false);
      setStatus('');
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Speech recognition permission was denied. You can still read captions shared by teammates.'
          : 'The browser speech service is unavailable or does not support this language. You can still read teammates’ captions.',
      );
    };
    recognition.onend = () => {
      if (active && mic.current()) {
        if (++failures > 3) {
          setShare(false);
          setStatus('');
          setError('Speech recognition stopped repeatedly. Please try again.');
          return;
        }
        timer = setTimeout(start, 800);
      }
    };
    start();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        /* Already stopped by the browser. */
      }
    };
  }, [share, enabled, audio, language, engine]);
  useEffect(() => {
    if (!event) return;
    if (event.type === 'reaction') {
      setReactions((old) =>
        [...old, { ...event.reaction, received: Date.now() }].slice(-5),
      );
      return;
    }
    if (!preferences.current.enabled) return;
    const caption = { ...event.caption, received: Date.now() };
    setCaptions((old) => [...old, caption].slice(-3));
    const pref = { ...preferences.current },
      version = generation.current;
    if (!pref.translate || !translationReady || pending.current >= 8) return;
    pending.current++;
    queue.current = queue.current
      .then(async () => {
        if (!live.current || version !== generation.current) return;
        try {
          const result = await callsApi.translate(meetingId, {
            text: caption.text,
            source: caption.language.split('-')[0],
            target: pref.target,
          });
          if (!live.current || version !== generation.current) return;
          setCaptions((old) =>
            old.map((c) =>
              c.id === caption.id ? { ...c, translated: result.text } : c,
            ),
          );
          if (
            pref.readAloud &&
            preferences.current.readAloud &&
            caption.sender.user_id !== userId &&
            window.speechSynthesis &&
            !spoken.current.has(caption.id)
          ) {
            spoken.current.add(caption.id);
            if (spoken.current.size > 100)
              spoken.current.delete(spoken.current.values().next().value!);
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(result.text);
            utterance.lang = pref.target;
            voiceOwned.current = true;
            window.speechSynthesis.speak(utterance);
          }
        } catch (e) {
          if (live.current && version === generation.current)
            setError(
              e instanceof Error
                ? e.message
                : 'Translation is unavailable. Original captions are still shown.',
            );
        }
      })
      .finally(() => {
        pending.current--;
      });
  }, [event, meetingId, translationReady, userId]);
  function captionsToggle() {
    setEnabled((value) => !value);
    setPopover(enabled ? null : 'captions');
  }
  const overlay = stage
    ? createPortal(
        <>
          <div
            className="call-reactions"
            role="status"
            aria-label="Live reactions"
          >
            {reactions.map((r) => (
              <div key={r.id}>
                <span>{r.emoji}</span>
                <small>
                  {r.sender.user_id === userId ? 'You' : r.sender.name}
                </small>
              </div>
            ))}
          </div>
          {enabled && (
            <div
              className="call-captions-overlay"
              role="log"
              aria-label="Live captions"
              aria-live="polite"
            >
              {captions.length ? (
                captions.map((c) => (
                  <div key={c.id}>
                    <strong>
                      {c.sender.user_id === userId ? 'You' : c.sender.name}
                    </strong>
                    <p>{c.translated || c.text}</p>
                    {c.translated && <small>{c.text}</small>}
                  </div>
                ))
              ) : (
                <div className="call-caption-waiting">
                  Captions on · Waiting for a speaker to share speech captions
                </div>
              )}
            </div>
          )}
        </>,
        stage,
      )
    : null;
  return (
    <div className="call-access-controls">
      <button
        aria-label="Emoji reactions"
        aria-expanded={popover === 'emoji'}
        onClick={() => setPopover(popover === 'emoji' ? null : 'emoji')}
      >
        <Smile size={19} />
      </button>
      <button
        aria-label={enabled ? 'Turn off captions' : 'Turn on captions'}
        aria-pressed={enabled}
        onClick={captionsToggle}
      >
        <Captions size={19} />
      </button>
      <button
        aria-label="Translate speech"
        aria-expanded={popover === 'translate'}
        onClick={() => {
          setEnabled(true);
          setPopover(popover === 'translate' ? null : 'translate');
        }}
      >
        <Languages size={19} />
      </button>
      {popover && (
        <section
          className="call-access-popover"
          aria-label={
            popover === 'emoji'
              ? 'Emoji reactions'
              : popover === 'translate'
                ? 'Translate speech'
                : 'Caption settings'
          }
        >
          <div className="call-access-heading">
            <h3>
              {popover === 'emoji'
                ? 'Reactions'
                : popover === 'translate'
                  ? 'Translate speech'
                  : 'Live captions'}
            </h3>
            <button
              aria-label="Close accessibility settings"
              onClick={() => setPopover(null)}
            >
              <X size={17} />
            </button>
          </div>
          {popover === 'emoji' ? (
            <div className="call-emoji-picker">
              {EMOJI.map(([emoji, label]) => (
                <button
                  key={emoji}
                  aria-label={'React with ' + label}
                  onClick={() => {
                    send({ type: 'reaction', emoji });
                    setPopover(null);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : (
            <>
              <p className="call-access-note">
                Each speaker must enable captions for their own voice. Captions
                are live only and are not saved.
              </p>
              <label className="call-access-field">
                My speaking language
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  {LANGUAGES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="call-access-note">
                Starting shares your recognized words with this call. Your
                browser may send microphone audio to its speech recognition
                provider. Muting pauses recognition.
              </p>
              {!engine ? (
                <p className="call-access-warning">
                  This browser cannot caption your microphone. You can still
                  read teammates’ captions. Try a browser with speech
                  recognition support.
                </p>
              ) : (
                <button
                  className="call-speech-start"
                  aria-pressed={share}
                  onClick={() => {
                    setError('');
                    setShare((v) => !v);
                  }}
                >
                  <Mic size={16} />
                  {share
                    ? 'Stop my speech captions'
                    : 'Start my speech captions'}
                </button>
              )}
              {status && (
                <p className="call-access-note" role="status">
                  {status}
                </p>
              )}
              <div className="call-translation-options">
                <h4>Translate incoming speech</h4>
                {!translationReady && (
                  <p className="call-access-warning">
                    Your administrator must configure the translation service
                    before translation is available.
                  </p>
                )}
                <label className="call-access-check">
                  <input
                    type="checkbox"
                    checked={translate}
                    disabled={!translationReady}
                    onChange={(e) => setTranslate(e.target.checked)}
                  />
                  Translate new captions
                </label>
                <label className="call-access-field">
                  Translate to
                  <select
                    value={target}
                    disabled={!translationReady}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {TARGETS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="call-access-note">
                  Enabling translation sends new caption text to your
                  workspace’s configured translation service. Language
                  availability depends on that service.
                </p>
                <label className="call-access-check">
                  <input
                    type="checkbox"
                    checked={readAloud}
                    disabled={!translate || !window.speechSynthesis}
                    onChange={(e) => setReadAloud(e.target.checked)}
                  />
                  <Volume2 size={15} />
                  Read translations aloud
                </label>
              </div>
              {error && (
                <p className="call-access-warning" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </section>
      )}
      {error && enabled && popover === null && (
        <button
          className="call-caption-error"
          onClick={() => setPopover('captions')}
        >
          Caption/translation service needs attention
        </button>
      )}
      {overlay}
    </div>
  );
}
