import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Video, VideoOff, Users, X } from 'lucide-react';
import { callsApi, type MeetingRecord } from './api';
import './CallRoom.css';

type Person = {
  id: string;
  user_id: string;
  name: string;
  audio: boolean;
  video: boolean;
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
function MediaTile({
  stream,
  person,
  state,
  local = false,
}: {
  stream: MediaStream | null;
  person: Pick<Person, 'name' | 'audio' | 'video'>;
  state: string;
  local?: boolean;
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
      className={'call-tile' + (local ? ' local' : '')}
      data-call-peer={local ? 'local' : 'remote'}
      data-state={state}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted={local}
        className={person.video ? '' : 'camera-hidden'}
      />
      {!person.video && (
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
          {local ? ' (you)' : ''}
        </span>
        {!person.audio && <MicOff size={15} />}
        <small>{state === 'connected' ? '' : state}</small>
      </div>
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
  const stream = useRef<MediaStream | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const self = useRef('');
  const peers = useRef(new Map<string, Peer>());
  const ice = useRef<RTCConfiguration>({});
  const alive = useRef(true);
  const starting = useRef(false);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshIce = useRef<ReturnType<typeof setInterval> | null>(null);
  const media = useRef({ audio: true, video: true });
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
      const track = stream.current?.getTracks().find((t) => t.kind === kind);
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
            } else if (data.type === 'joined') {
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
    const next = !media.current[kind];
    if (!joined) {
      media.current = { ...media.current, [kind]: next };
      kind === 'audio' ? setAudio(next) : setVideo(next);
      return;
    }
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
          if (transceiver) await transceiver.sender.replaceTrack(track);
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
  const owner = meeting.organizer.id === userId;
  return (
    <div
      className="call-room"
      role="dialog"
      aria-modal="true"
      aria-label={'Call: ' + meeting.title}
    >
      <header>
        <div>
          <span>TEAMWORKSPACE CALL</span>
          <h2>{meeting.title}</h2>
        </div>
        <div className="call-count">
          <Users size={16} />
          {Object.keys(remotes).length + (joined ? 1 : 0)} / 6
        </div>
        <button aria-label="Close call" onClick={leave}>
          <X size={20} />
        </button>
      </header>
      {error && (
        <div className="call-error" role="alert">
          {error}
        </div>
      )}
      {!joined ? (
        <div className="call-prejoin">
          <Video size={44} />
          <h3>Ready to join?</h3>
          <p>Speak and meet face-to-face right here in TeamWorkspace.</p>
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
          <div className="call-grid">
            <MediaTile
              stream={local}
              person={{ name: 'You', audio, video }}
              state="connected"
              local
            />
            {Object.values(remotes).map((p) => (
              <MediaTile
                key={p.person.id}
                stream={p.stream}
                person={p.person}
                state={p.state}
              />
            ))}
            {!Object.keys(remotes).length && (
              <div className="call-waiting">
                <Users size={32} />
                <h3>Waiting for your teammates</h3>
                <p>
                  Invited teammates can join this meeting from TeamWorkspace.
                </p>
              </div>
            )}
          </div>
          <footer>
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
          </footer>
        </>
      )}
    </div>
  );
}
