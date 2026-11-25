/** Reconnect a conversation socket with bounded exponential backoff. */
export interface SocketCallbacks {
  onAttempt:()=>void;
  onOpen:(socket:WebSocket)=>void;
  onMessage:(event:MessageEvent)=>void;
  onDisconnected:()=>void;
  onDenied:()=>void;
}
export function connectConversationSocket(path:string, callbacks:SocketCallbacks){
  let stopped=false,attempt=0, socket:WebSocket|null=null;
  let retry:ReturnType<typeof setTimeout>|undefined;
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  function clearHealth(){clearInterval(heartbeat);clearTimeout(deadline);heartbeat=undefined;deadline=undefined;}
  function stop(){
    stopped=true;clearTimeout(retry);clearHealth();
    window.removeEventListener('online',wake);
    window.removeEventListener('offline',offline);
    if(socket){const old=socket;socket=null;old.close();}
  }
  function schedule(){
    if(stopped||retry!==undefined||!navigator.onLine)return;
    const delay=Math.min(30000,1000*2**Math.min(attempt++,5));
    retry=setTimeout(()=>{retry=undefined;connect();},delay);
  }
  function wake(){if(stopped)return;clearTimeout(retry);retry=undefined;if(!socket)connect();}
  function offline(){clearTimeout(retry);retry=undefined;if(socket){socket.close();}callbacks.onDisconnected();}
  function connect(){
    if(stopped||socket||!navigator.onLine)return;
    callbacks.onAttempt();
    const protocol=location.protocol==='https:'?'wss:':'ws:';
    let ws:WebSocket;
    try{ws=new WebSocket(protocol+'//'+location.host+path);}catch{callbacks.onDisconnected();schedule();return;}
    socket=ws;
    deadline=setTimeout(()=>{if(socket===ws)ws.close();},15000);
    ws.onopen=()=>{
      if(stopped||socket!==ws)return;
      clearHealth();attempt=0;callbacks.onOpen(ws);
      heartbeat=setInterval(()=>{
        if(stopped||socket!==ws||ws.readyState!==WebSocket.OPEN)return;
        if(deadline!==undefined){ws.close();return;}
        try{ws.send(JSON.stringify({type:'ping'}));deadline=setTimeout(()=>{if(socket===ws)ws.close();},10000);}catch{ws.close();}
      },25000);
    };
    ws.onmessage=event=>{
      if(stopped||socket!==ws)return;
      try{if(JSON.parse(event.data).type==='pong'){clearTimeout(deadline);deadline=undefined;return;}}catch{/* consumer handles invalid messages */}
      callbacks.onMessage(event);
    };
    ws.onerror=()=>{if(!stopped&&socket===ws)ws.close();};
    ws.onclose=event=>{
      if(stopped||socket!==ws)return;
      socket=null;clearHealth();callbacks.onDisconnected();
      if(event.code===4401||event.code===4403){stop();callbacks.onDenied();return;}
      schedule();
    };
  }
  window.addEventListener('online',wake);window.addEventListener('offline',offline);
  connect();
  return stop;
}

/** Overlay live message events received while a fresh history page was loading. */
export function mergeFreshHistory<T extends {id:string;created_at:string}>(rows:T[],events:Map<string,T>){
  const byId=new Map(rows.map(row=>[row.id,row]));
  for(const [id,row] of events)byId.set(id,row);
  return [...byId.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
}
