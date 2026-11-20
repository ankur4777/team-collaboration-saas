import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Users,
  X,
  Hand,
  MonitorUp,
  MessageSquare,
  LayoutGrid,
  Pin,
  Maximize,
  Minimize,
  Info,
  Copy,
  Send,
  Check,
} from 'lucide-react';
import { callsApi, type MeetingRecord } from './api';
import CallAccessibility, { type AccessEvent } from './CallAccessibility';
import './CallRoom.css';

type Person = {
  id: string;
  user_id: string;
  name: string;
  audio: boolean;
  video: boolean;
  hand_raised: boolean;
  screen_sharing: boolean;
};
type Peer = {
  person: Person;
  pc: RTCPeerConnection;
  stream: MediaStream;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
};
type Remote = {
  person: Person;
  stream: MediaStream;
  state: RTCPeerConnectionState;
};
type CallMessage = {
  id: string;
  sender: Person;
  text: string;
  sent_at: string;
};

function MediaTile({
  stream,
  person,
  state,
  local = false,
  focused = false,
  onPin,
}: {
  stream: MediaStream | null;
  person: Pick<
    Person,
    'name' | 'audio' | 'video' | 'hand_raised' | 'screen_sharing'
  >;
  state: string;
  local?: boolean;
  focused?: boolean;
  onPin?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    void el
      .play()
      .then(() => setBlocked(false))
      .catch(() => setBlocked(true));
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <div
      className={
        'call-tile' +
        (local ? ' local' : '') +
        (focused ? ' focused' : '') +
        (person.screen_sharing ? ' presenting' : '')
      }
      data-call-peer={local ? 'local' : 'remote'}
      data-state={state}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={local}
        className={person.video || person.screen_sharing ? '' : 'camera-hidden'}
      />
      {!person.video && !person.screen_sharing && (
        <span className="call-initials">
          {person.name
            .split(' ')
            .map((w) => w[0])
            .slice(0, 2)
            .join('')
            .toUpperCase()}
        </span>
      )}
      <div className="call-person">
        <span>
          {person.name}
          {local && person.name !== 'You' ? ' (you)' : ''}
        </span>
        {!person.audio && <MicOff size={15} aria-label="Microphone muted" />}
        {person.hand_raised && <Hand size={15} aria-label="Hand raised" />}
        {person.screen_sharing && (
          <span className="call-presenting-label">
            <MonitorUp size={14} /> Presenting
          </span>
        )}
        <small>{state === 'connected' ? '' : state}</small>
      </div>
      {onPin && (
        <button
          className="call-pin"
          aria-label={'Spotlight ' + person.name}
          onClick={onPin}
        >
          <Pin size={14} />
        </button>
      )}
      {blocked && !local && (
        <button
          className="call-enable-audio"
          onClick={() =>
            void video.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => {})
          }
        >
          Enable audio
        </button>
      )}
    </div>
  );
}

export default function CallRoom({
  meeting,
  userId,
  onLeave,
}: {
  meeting: MeetingRecord;
  userId: string;
  onLeave: () => void;
}) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [audio, setAudio] = useState(true);
  const [video, setVideo] = useState(true);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [remotes, setRemotes] = useState<Record<string, Remote>>({});
  const [error, setError] = useState('');
  const [ending, setEnding] = useState(false);
  const [accessEvent, setAccessEvent] = useState<AccessEvent | null>(null);
  const [translationReady, setTranslationReady] = useState(false);
  const [stageElement, setStageElement] = useState<HTMLElement | null>(null);
  const [hand, setHand] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [panel, setPanel] = useState<'people' | 'chat' | 'info' | null>(null);
  const [layout, setLayout] = useState<'auto' | 'tiled' | 'spotlight'>('auto');
  const [pinned, setPinned] = useState<string | null>(null);
  const [chat, setChat] = useState<CallMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const room = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const display = useRef<MediaStream | null>(null);
  const shareLock = useRef(false);
  const joinedAt = useRef(0);
  const toggling = useRef(new Set<string>());

  const stream = useRef<MediaStream | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const self = useRef('');
  const peers = useRef(new Map<string, Peer>());
  const ice = useRef<RTCConfiguration>({});
  const alive = useRef(true);
  const starting = useRef(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshIce = useRef<ReturnType<typeof setInterval> | null>(null);
  const media = useRef({
    audio: true,
    video: true,
    hand_raised: false,
    screen_sharing: false,
  });
  const messages = useRef<Promise<void>>(Promise.resolve());
  function send(body: unknown) {
    if (ws.current?.readyState === WebSocket.OPEN)
      ws.current.send(JSON.stringify(body));
  }
  function publish() {
    send({
      type: 'media',
      audio: media.current.audio,
      video: media.current.video,
      hand_raised: media.current.hand_raised,
      screen_sharing: media.current.screen_sharing,
    });
  }
  function update(p: Peer) {
    if (alive.current)
      setRemotes((old) => ({
        ...old,
        [p.person.id]: {
          person: { ...p.person },
          stream: p.stream,
          state: p.pc.connectionState,
        },
      }));
  }
  function remove(id: string) {
    const p = peers.current.get(id);
    if (p) {
      p.pc.onnegotiationneeded = null;
      p.pc.onicecandidate = null;
      p.pc.onconnectionstatechange = null;
      p.pc.ontrack = null;
      p.pc.close();
      peers.current.delete(id);
    }
    if (alive.current)
      setRemotes((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      });
  }
  function cleanup() {
    if (heartbeat.current) clearInterval(heartbeat.current);
    if (refreshIce.current) clearInterval(refreshIce.current);
    heartbeat.current = null;
    refreshIce.current = null;
    const socket = ws.current;
    ws.current = null;
    display.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    display.current = null;
    shareLock.current = false;
    media.current.screen_sharing = false;
    media.current.hand_raised = false;
    joinedAt.current = 0;
    if (alive.current) {
      setSharing(false);
      setShareBusy(false);
      setHand(false);
      setChat([]);
      setUnread(0);
      setPinned(null);
      setElapsed(0);
    }
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.close();
    }
    for (const id of peers.current.keys()) remove(id);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (alive.current) {
      setLocal(null);
      setAccessEvent(null);
      setJoined(false);
      setJoining(false);
    }
    starting.current = false;
    self.current = '';
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cleanup();
    };
  }, []);
  function ensure(person: Person) {
    let p = peers.current.get(person.id);
    if (p) return p;
    const pc = new RTCPeerConnection(ice.current);
    p = {
      person,
      pc,
      stream: new MediaStream(),
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      candidates: [],
    };
    peers.current.set(person.id, p);
    const entry = p;
    for (const kind of ['audio', 'video'] as const) {
      const transceiver = pc.addTransceiver(kind, {
        direction: 'sendrecv',
        streams: stream.current ? [stream.current] : [],
      });
      const track =
        kind === 'video' && display.current
          ? display.current.getVideoTracks()[0]
          : stream.current?.getTracks().find((t) => t.kind === kind);
      if (track) void transceiver.sender.replaceTrack(track);
    }
    pc.ontrack = (e) => {
      if (!entry.stream.getTracks().some((t) => t.id === e.track.id))
        entry.stream.addTrack(e.track);
      update(entry);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate)
        send({
          type: 'signal',
          target: person.id,
          candidate: e.candidate.toJSON(),
        });
    };
    pc.onconnectionstatechange = () => {
      update(entry);
      if (pc.connectionState === 'failed')
        setError(
          'A participant could not connect. Try leaving and joining again; your administrator may need to configure the call relay.',
        );
    };
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        if (peers.current.get(person.id) === entry)
          send({
            type: 'signal',
            target: person.id,
            description: pc.localDescription,
          });
      } catch {
        if (alive.current && pc.signalingState !== 'closed')
          setError(
            'Could not negotiate the call connection. Leave and try again.',
          );
      } finally {
        entry.makingOffer = false;
      }
    };
    update(entry);
    return entry;
  }
  async function signal(data: {
    from: Person;
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  }) {
    const p = ensure(data.from),
      pc = p.pc;
    if (data.description) {
      const ready =
        !p.makingOffer && (pc.signalingState === 'stable' || p.settingAnswer);
      const collision = data.description.type === 'offer' && !ready;
      p.ignoreOffer = self.current.localeCompare(p.person.id) < 0 && collision;
      if (p.ignoreOffer) {
        p.candidates = [];
        return;
      }
      p.settingAnswer = data.description.type === 'answer';
      try {
        await pc.setRemoteDescription(data.description);
      } finally {
        p.settingAnswer = false;
      }
      for (const c of p.candidates) await pc.addIceCandidate(c);
      p.candidates = [];
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        send({
          type: 'signal',
          target: p.person.id,
          description: pc.localDescription,
        });
      }
    } else if (data.candidate && !p.ignoreOffer) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else p.candidates.push(data.candidate);
    }
  }
  async function join() {
    if (starting.current) return;
    starting.current = true;
    setJoining(true);
    setError('');
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error(
          'Camera and microphone access needs HTTPS or localhost in a supported browser.',
        );
      const config = await callsApi.config(meeting.id);
      if (!alive.current) return;
      ice.current = config.rtc;
      setTranslationReady(!!config.translation_enabled);
      let acquired: MediaStream;
      if (media.current.audio || media.current.video)
        acquired = await navigator.mediaDevices.getUserMedia({
          audio: media.current.audio
            ? { echoCancellation: true, noiseSuppression: true }
            : false,
          video: media.current.video
            ? { width: { ideal: 640 }, height: { ideal: 360 } }
            : false,
        });
      else acquired = new MediaStream();
      if (!alive.current) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = acquired;
      setLocal(acquired);
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(
        `${protocol}//${location.host}${config.websocket_path}`,
      );
      ws.current = socket;
      socket.onmessage = (e) => {
        messages.current = messages.current
          .then(async () => {
            if (!alive.current || ws.current !== socket) return;
            const data = JSON.parse(e.data);
            if (data.type === 'ready') {
              self.current = data.self.id;
              joinedAt.current = Date.now();
              setJoined(true);
              setJoining(false);
              publish();
              for (const person of data.peers) ensure(person);
              heartbeat.current = setInterval(
                () => send({ type: 'ping' }),
                15000,
              );
              refreshIce.current = setInterval(() => {
                void callsApi
                  .config(meeting.id)
                  .then((c) => {
                    ice.current = c.rtc;
                    for (const p of peers.current.values())
                      p.pc.setConfiguration(c.rtc);
                  })
                  .catch(() => {});
              }, 20 * 60000);
            } else if (data.type === 'reaction' || data.type === 'caption')
              setAccessEvent(data as AccessEvent);
            else if (data.type === 'chat') {
              setChat((old) => [...old, data.message].slice(-200));
              if (
                panelRef.current !== 'chat' &&
                data.message.sender.user_id !== userId
              )
                setUnread((n) => n + 1);
            } else if (data.type === 'notice') setError(data.text);
            else if (data.type === 'joined') {
              if (data.peer.id !== self.current) ensure(data.peer);
            } else if (data.type === 'signal') await signal(data);
            else if (data.type === 'left') remove(data.peer_id);
            else if (data.type === 'media') {
              const p = peers.current.get(data.peer_id);
              if (p) {
                p.person = {
                  ...p.person,
                  audio: data.audio,
                  video: data.video,
                  hand_raised: data.hand_raised,
                  screen_sharing: data.screen_sharing,
                };
                update(p);
              }
            }
          })
          .catch(() => {
            if (alive.current)
              setError(
                'A call connection could not be established. Leave and try again.',
              );
          });
      };
      socket.onerror = () => {
        if (alive.current)
          setError(
            'Could not connect to the call server. Check your connection and try again.',
          );
      };
      socket.onclose = (e) => {
        if (ws.current !== socket) return;
        cleanup();
        if (alive.current)
          setError(
            e.code === 4409
              ? 'This meeting is already open in another tab. Leave that call first.'
              : e.code === 4429
                ? 'This room is full (six people maximum).'
                : 'The call ended, expired, or your access changed. You can close this window or try again.',
          );
      };
    } catch (e) {
      cleanup();
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Could not access your camera or microphone. Check browser permissions, or join with them switched off.',
        );
    }
  }
  async function toggle(kind: 'audio' | 'video') {
    if (toggling.current.has(kind)) return;
    const next = !media.current[kind];
    if (!joined) {
      media.current = { ...media.current, [kind]: next };
      kind === 'audio' ? setAudio(next) : setVideo(next);
      return;
    }
    toggling.current.add(kind);
    setError('');
    try {
      let track = stream.current?.getTracks().find((t) => t.kind === kind);
      if (next && (!track || track.readyState === 'ended')) {
        const extra = await navigator.mediaDevices.getUserMedia(
          kind === 'audio'
            ? { audio: { echoCancellation: true }, video: false }
            : {
                audio: false,
                video: { width: { ideal: 640 }, height: { ideal: 360 } },
              },
        );
        if (!alive.current || !ws.current) {
          extra.getTracks().forEach((t) => t.stop());
          return;
        }
        track = extra.getTracks()[0];
        stream.current?.addTrack(track);
        for (const p of peers.current.values()) {
          const transceiver = p.pc
            .getTransceivers()
            .find((t) => t.receiver.track.kind === kind);
          if (transceiver && !(kind === 'video' && display.current))
            await transceiver.sender.replaceTrack(track);
        }
      }
      if (track) track.enabled = next;
      media.current = { ...media.current, [kind]: next };
      kind === 'audio' ? setAudio(next) : setVideo(next);
      publish();
    } catch {
      setError(
        'Could not access that device. Check browser permissions or choose another camera/microphone.',
      );
    } finally {
      toggling.current.delete(kind);
    }
  }
  async function endAll() {
    if (!window.confirm('End this call for everyone?')) return;
    setEnding(true);
    try {
      await callsApi.end(meeting.id);
      cleanup();
      onLeave();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the call.');
    } finally {
      setEnding(false);
    }
  }
  function leave() {
    cleanup();
    onLeave();
  }
  useEffect(() => {
    const timer = setInterval(() => {
      if (joinedAt.current)
        setElapsed(Math.floor((Date.now() - joinedAt.current) / 1000));
    }, 1000);
    const changed = () => setFull(document.fullscreenElement === room.current);
    document.addEventListener('fullscreenchange', changed);
    return () => {
      clearInterval(timer);
      document.removeEventListener('fullscreenchange', changed);
    };
  }, []);
  useEffect(() => {
    if (panel === 'chat') {
      setUnread(0);
      chatEnd.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [panel, chat]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    room.current?.focus();
    return () => before?.focus();
  }, []);
  async function replaceVideo(track: MediaStreamTrack | null) {
    await Promise.all(
      [...peers.current.values()].map(async (p) => {
        const sender = p.pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === 'video')?.sender;
        if (sender) await sender.replaceTrack(track);
      }),
    );
  }
  async function stopSharing() {
    const captured = display.current;
    display.current = null;
    captured?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    try {
      await replaceVideo(
        stream.current?.getVideoTracks().find((t) => t.readyState === 'live') ||
          null,
      );
    } catch {
      if (alive.current)
        setError(
          'The camera could not be restored. Leave and rejoin if needed.',
        );
    }
    if (!alive.current) return;
    media.current.screen_sharing = false;
    setSharing(false);
    publish();
  }
  async function shareScreen() {
    if (shareLock.current) return;
    if (display.current) {
      await stopSharing();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError(
        'Screen sharing is not supported by this browser. Try a desktop browser.',
      );
      return;
    }
    shareLock.current = true;
    setShareBusy(true);
    setError('');
    let captured: MediaStream | null = null;
    try {
      // Keep capture inside the user's click: browsers require transient activation.
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (!alive.current || !ws.current) {
        captured.getTracks().forEach((t) => t.stop());
        return;
      }
      display.current = captured;
      await replaceVideo(captured.getVideoTracks()[0]);
      if (!alive.current || !ws.current) {
        captured.getTracks().forEach((t) => t.stop());
        display.current = null;
        return;
      }
      if (captured.getVideoTracks()[0].readyState === 'ended') {
        await stopSharing();
        return;
      }
      captured.getVideoTracks()[0].onended = () => void stopSharing();
      media.current.screen_sharing = true;
      setSharing(true);
      publish();
    } catch (e) {
      if (display.current === captured && captured) await stopSharing();
      else captured?.getTracks().forEach((t) => t.stop());
      if (
        alive.current &&
        !(e instanceof DOMException && e.name === 'NotAllowedError')
      )
        setError(
          'Screen sharing could not start. Check browser permission and try again.',
        );
    } finally {
      shareLock.current = false;
      if (alive.current) setShareBusy(false);
    }
  }
  function raiseHand() {
    media.current.hand_raised = !media.current.hand_raised;
    setHand(media.current.hand_raised);
    publish();
  }
  function sendChat(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || ws.current?.readyState !== WebSocket.OPEN) return;
    send({ type: 'chat', text: draft.trim() });
    setDraft('');
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await room.current?.requestFullscreen();
    } catch {
      setError('Full screen is not available in this browser.');
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        location.origin + '/?meeting=' + meeting.id,
      );
      setCopied(true);
    } catch {
      setError(
        'Could not copy the link. Open Meeting details to select it manually.',
      );
    }
  }
  function spotlight(id: string) {
    setPinned(id);
    setLayout('spotlight');
  }
  const owner = meeting.organizer.id === userId;
  const people = Object.values(remotes);
  const localPerson = {
    name: 'You',
    audio,
    video,
    hand_raised: hand,
    screen_sharing: sharing,
  };
  const focusId =
    pinned && (pinned === 'local' || remotes[pinned])
      ? pinned
      : sharing
        ? 'local'
        : people.find((p) => p.person.screen_sharing)?.person.id ||
          people[0]?.person.id ||
          'local';
  const spotlightLayout =
    layout === 'spotlight' ||
    (layout === 'auto' &&
      (sharing || people.some((p) => p.person.screen_sharing)));
  const duration =
    Math.floor(elapsed / 60)
      .toString()
      .padStart(2, '0') +
    ':' +
    (elapsed % 60).toString().padStart(2, '0');
  function trapFocus(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && panel) {
      setPanel(null);
      e.stopPropagation();
    }
    if (e.key !== 'Tab') return;
    const nodes = [
      ...(room.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input,textarea,select,a[href]',
      ) || []),
    ].filter((n) => n.offsetParent !== null);
    const first = nodes[0],
      last = nodes[nodes.length - 1];
    if (
      e.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === room.current)
    ) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  return (
    <div
      className="call-room"
      ref={room}
      tabIndex={-1}
      onKeyDown={trapFocus}
      role="dialog"
      aria-modal="true"
      aria-label={'Call: ' + meeting.title}
    >
      <header>
        <div>
          <span className="call-brand">TEAMWORKSPACE CALL</span>
          <h2>{meeting.title}</h2>
        </div>
        {joined && (
          <span className="call-timer" aria-label="Time in call">
            {duration}
          </span>
        )}
        <div className="call-count">
          <Users size={16} />
          {people.length + (joined ? 1 : 0)} / 6
        </div>
        <button
          aria-label={full ? 'Exit full screen' : 'Enter full screen'}
          onClick={() => void fullscreen()}
        >
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
        <button aria-label="Close call" onClick={leave}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <div className="call-error" role="alert">
          {error}
          <button
            aria-label="Dismiss call message"
            onClick={() => setError('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!joined ? (
        <div className="call-prejoin">
          <div className="call-prejoin-icon">
            <Video size={34} />
          </div>
          <span className="call-eyebrow">YOUR TEAM. ONE ROOM.</span>
          <h3>Ready to join?</h3>
          <p>Speak, present and collaborate right here in TeamWorkspace.</p>
          <div className="call-prejoin-controls">
            <button
              aria-pressed={audio}
              onClick={() => void toggle('audio')}
              disabled={joining}
            >
              {audio ? <Mic /> : <MicOff />}Microphone {audio ? 'on' : 'off'}
            </button>
            <button
              aria-pressed={video}
              onClick={() => void toggle('video')}
              disabled={joining}
            >
              {video ? <Video /> : <VideoOff />}Camera {video ? 'on' : 'off'}
            </button>
          </div>
          <button
            className="call-join"
            onClick={() => void join()}
            disabled={joining}
          >
            {joining ? 'Connecting…' : 'Join call'}
          </button>
          <small>
            Your browser will ask for camera/microphone permission. You can also
            join with both switched off.
          </small>
        </div>
      ) : (
        <>
          {sharing && (
            <div className="call-share-banner">
              <MonitorUp size={16} />
              <span>
                You are presenting your screen. Your screen replaces your camera
                in the call.
              </span>
              <button onClick={() => void stopSharing()}>
                Stop presenting
              </button>
            </div>
          )}
          <div className="call-workspace">
            <main className="call-stage" ref={setStageElement}>
              <div className="call-stage-tools">
                <span>
                  {sharing || people.some((p) => p.person.screen_sharing)
                    ? 'Presentation in progress'
                    : 'Meeting room'}
                </span>
                <label>
                  <LayoutGrid size={15} />
                  <select
                    aria-label="Call layout"
                    value={layout}
                    onChange={(e) => {
                      setLayout(e.target.value as typeof layout);
                      setPinned(null);
                    }}
                  >
                    <option value="auto">Auto layout</option>
                    <option value="tiled">Tiled</option>
                    <option value="spotlight">Spotlight</option>
                  </select>
                </label>
              </div>
              <div
                className={'call-grid' + (spotlightLayout ? ' spotlight' : '')}
              >
                <MediaTile
                  stream={sharing ? display.current : local}
                  person={localPerson}
                  state="connected"
                  local
                  focused={spotlightLayout && focusId === 'local'}
                  onPin={() => spotlight('local')}
                />
                {people.map((p) => (
                  <MediaTile
                    key={p.person.id}
                    stream={p.stream}
                    person={p.person}
                    state={p.state}
                    focused={spotlightLayout && focusId === p.person.id}
                    onPin={() => spotlight(p.person.id)}
                  />
                ))}
                {!people.length && (
                  <div className="call-waiting">
                    <Users size={30} />
                    <h3>Waiting for your teammates</h3>
                    <p>
                      Invited teammates can join this meeting from
                      TeamWorkspace.
                    </p>
                    <button
                      onClick={() => {
                        setPanel('info');
                      }}
                    >
                      Meeting details
                    </button>
                  </div>
                )}
              </div>
            </main>
            {panel && (
              <aside
                className="call-sidebar"
                aria-label={
                  panel === 'people'
                    ? 'Participants'
                    : panel === 'chat'
                      ? 'In-call chat'
                      : 'Meeting details'
                }
              >
                <div className="call-sidebar-head">
                  <h3>
                    {panel === 'people'
                      ? 'Participants'
                      : panel === 'chat'
                        ? 'In-call chat'
                        : 'Meeting details'}
                  </h3>
                  <button
                    aria-label="Close side panel"
                    onClick={() => setPanel(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
                {panel === 'people' && (
                  <div className="call-people">
                    <p>{people.length + 1} in this call · 6 maximum</p>
                    {[
                      {
                        person: {
                          ...localPerson,
                          id: 'local',
                          user_id: userId,
                        },
                        state: 'connected',
                      },
                      ...people,
                    ].map((p) => (
                      <div className="call-person-row" key={p.person.id}>
                        <span className="call-avatar">
                          {p.person.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <strong>
                            {p.person.name}
                            {p.person.user_id === meeting.organizer.id
                              ? ' · Host'
                              : ''}
                          </strong>
                          <small>
                            {p.person.screen_sharing
                              ? 'Presenting'
                              : p.person.hand_raised
                                ? 'Hand raised'
                                : p.state === 'connected'
                                  ? 'In call'
                                  : p.state}
                          </small>
                        </div>
                        <span className="call-person-icons">
                          {p.person.hand_raised && (
                            <Hand size={15} aria-label="Hand raised" />
                          )}
                          {!p.person.audio && (
                            <MicOff size={15} aria-label="Microphone muted" />
                          )}
                          {!p.person.video && (
                            <VideoOff size={15} aria-label="Camera off" />
                          )}
                        </span>
                        <button
                          aria-label={'Spotlight ' + p.person.name}
                          onClick={() => spotlight(p.person.id)}
                        >
                          <Pin size={14} />
                        </button>
                      </div>
                    ))}
                    <small className="call-panel-note">
                      Only invited workspace members can join this room.
                    </small>
                  </div>
                )}
                {panel === 'chat' && (
                  <>
                    <p className="call-panel-note">
                      Messages are live only. They are not saved and new
                      arrivals cannot see earlier messages.
                    </p>
                    <div
                      className="call-messages"
                      role="log"
                      aria-label="Call messages"
                      aria-live="polite"
                    >
                      {!chat.length && (
                        <p className="call-chat-empty">
                          Share a thought or a useful link with everyone in the
                          call.
                        </p>
                      )}
                      {chat.map((m) => (
                        <article
                          key={m.id}
                          className={m.sender.user_id === userId ? 'own' : ''}
                        >
                          <div>
                            <strong>
                              {m.sender.user_id === userId
                                ? 'You'
                                : m.sender.name}
                            </strong>
                            <time>
                              {new Date(m.sent_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </time>
                          </div>
                          <p>{m.text}</p>
                        </article>
                      ))}
                      <div ref={chatEnd} />
                    </div>
                    <form className="call-chat-form" onSubmit={sendChat}>
                      <label htmlFor="call-chat-input">Message everyone</label>
                      <div>
                        <textarea
                          id="call-chat-input"
                          value={draft}
                          maxLength={2000}
                          rows={2}
                          placeholder="Write a message…"
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (
                              e.key === 'Enter' &&
                              !e.shiftKey &&
                              !e.nativeEvent.isComposing
                            ) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                        />
                        <button
                          type="submit"
                          aria-label="Send chat message"
                          disabled={!draft.trim()}
                        >
                          <Send size={18} />
                        </button>
                      </div>
                      <small>
                        Enter to send · Shift + Enter for a new line
                      </small>
                    </form>
                  </>
                )}
                {panel === 'info' && (
                  <div className="call-info">
                    <h4>{meeting.title}</h4>
                    <p>
                      {new Date(meeting.starts_at).toLocaleString()} –{' '}
                      {new Date(meeting.ends_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                    <label>
                      Meeting link
                      <input
                        readOnly
                        value={location.origin + '/?meeting=' + meeting.id}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                    <button onClick={() => void copyLink()}>
                      {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                      {copied ? 'Link copied' : 'Copy meeting link'}
                    </button>
                    <p>
                      Sharing this link does not grant access. Invite teammates
                      from the meeting details first.
                    </p>
                  </div>
                )}
              </aside>
            )}
          </div>
          <footer>
            <div className="call-device-controls">
              <button
                aria-label={audio ? 'Mute microphone' : 'Unmute microphone'}
                aria-pressed={audio}
                onClick={() => void toggle('audio')}
              >
                {audio ? <Mic /> : <MicOff />}
                <span>Microphone</span>
              </button>
              <button
                aria-label={video ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={video}
                onClick={() => void toggle('video')}
              >
                {video ? <Video /> : <VideoOff />}
                <span>Camera</span>
              </button>
              <button
                aria-label={sharing ? 'Stop presenting' : 'Present screen'}
                aria-pressed={sharing}
                disabled={shareBusy}
                onClick={() => void shareScreen()}
              >
                <MonitorUp />
                <span>{sharing ? 'Stop presenting' : 'Present screen'}</span>
              </button>
              <button
                aria-label={hand ? 'Lower hand' : 'Raise hand'}
                aria-pressed={hand}
                onClick={raiseHand}
              >
                <Hand />
                <span>{hand ? 'Lower hand' : 'Raise hand'}</span>
              </button>
              <button className="call-leave" onClick={leave}>
                <PhoneOff />
                <span>Leave call</span>
              </button>
              {owner && (
                <button
                  className="call-end"
                  disabled={ending}
                  onClick={() => void endAll()}
                >
                  End for everyone
                </button>
              )}
            </div>
            <CallAccessibility
              meetingId={meeting.id}
              userId={userId}
              event={accessEvent}
              send={send}
              audio={audio}
              isMicActive={() =>
                !!stream.current
                  ?.getAudioTracks()
                  .some((t) => t.enabled && t.readyState === 'live')
              }
              stage={stageElement}
              translationReady={translationReady}
            />
            <div className="call-panel-controls">
              <button
                aria-label="Participants"
                aria-expanded={panel === 'people'}
                onClick={() => setPanel(panel === 'people' ? null : 'people')}
              >
                <Users />
                <span>{people.length + 1}</span>
              </button>
              <button
                aria-label="In-call chat"
                aria-expanded={panel === 'chat'}
                onClick={() => setPanel(panel === 'chat' ? null : 'chat')}
              >
                <MessageSquare />
                {unread > 0 && (
                  <b className="call-unread">{unread > 9 ? '9+' : unread}</b>
                )}
              </button>
              <button
                aria-label="Meeting details"
                aria-expanded={panel === 'info'}
                onClick={() => setPanel(panel === 'info' ? null : 'info')}
              >
                <Info />
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
