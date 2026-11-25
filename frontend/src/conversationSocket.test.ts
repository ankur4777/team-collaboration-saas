import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {connectConversationSocket,mergeFreshHistory} from './conversationSocket';

class FakeSocket{
  static OPEN=1;
  static rows:FakeSocket[]=[];
  readyState=0;
  onopen?:()=>void;
  onclose?:(e:{code:number})=>void;
  onmessage?:(e:{data:string})=>void;
  onerror?:()=>void;
  send=vi.fn();
  constructor(public url:string){FakeSocket.rows.push(this);}
  open(){this.readyState=1;this.onopen?.();}
  close(code=1006){this.readyState=3;this.onclose?.({code});}
}
describe('conversation reconnection',()=>{
  beforeEach(()=>{vi.useFakeTimers();FakeSocket.rows=[];vi.stubGlobal('WebSocket',FakeSocket);vi.spyOn(navigator,'onLine','get').mockReturnValue(true);});
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
  function setup(){const callbacks={onAttempt:vi.fn(),onOpen:vi.fn(),onMessage:vi.fn(),onDisconnected:vi.fn(),onDenied:vi.fn()};const stop=connectConversationSocket('/ws/chats/test/',callbacks);return {callbacks,stop};}
  it('retries after disconnect and stops after access revocation',()=>{
    const {callbacks,stop}=setup();
    FakeSocket.rows[0].open();FakeSocket.rows[0].close();
    vi.advanceTimersByTime(1000);expect(FakeSocket.rows).toHaveLength(2);
    FakeSocket.rows[1].open();expect(callbacks.onOpen).toHaveBeenCalledTimes(2);
    FakeSocket.rows[1].close(4403);vi.advanceTimersByTime(60000);
    expect(callbacks.onDenied).toHaveBeenCalledOnce();expect(FakeSocket.rows).toHaveLength(2);stop();
  });
  it('reconnects if heartbeat receives no pong',()=>{
    const {stop}=setup();FakeSocket.rows[0].open();
    vi.advanceTimersByTime(25000);expect(FakeSocket.rows[0].send).toHaveBeenCalledWith('{"type":"ping"}');
    vi.advanceTimersByTime(11000);expect(FakeSocket.rows).toHaveLength(2);stop();
  });
  it('cleans up pending retries on conversation switch',()=>{
    const {stop}=setup();FakeSocket.rows[0].close();stop();
    vi.advanceTimersByTime(60000);expect(FakeSocket.rows).toHaveLength(1);
  });
  it('uses the newest live version without duplicating messages',()=>{
    const row={id:'a',created_at:'2026-01-01',body:'old'};
    const newer={...row,body:'edited'};const next={id:'b',created_at:'2026-01-02',body:'new'};
    expect(mergeFreshHistory([row],new Map([['a',newer],['b',next]]))).toEqual([newer,next]);
  });
});
