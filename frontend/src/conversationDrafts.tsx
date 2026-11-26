import {createContext,useCallback,useContext,useState,type Dispatch,type SetStateAction,type ReactNode} from 'react';

type Drafts=Record<string,string>;
type DraftStore=[Drafts,Dispatch<SetStateAction<Drafts>>];
const Context=createContext<DraftStore|null>(null);

// Kept in memory for the signed-in workspace; never shared with other accounts.
export function DraftProvider({children}:{children:ReactNode}){
  const store=useState<Drafts>({});
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useConversationDraft(userId:string,workspaceId:string|null,kind:'chat'|'channel',id:string|null){
  const shared=useContext(Context);
  const local=useState<Drafts>({});
  const [drafts,setDrafts]=shared||local;
  const keyFor=(conversation:string)=>JSON.stringify([userId,workspaceId,kind,conversation]);
  const writeDraft=useCallback((conversation:string|null,value:SetStateAction<string>)=>{
    if(!conversation||!workspaceId)return;
    const key=JSON.stringify([userId,workspaceId,kind,conversation]);
    setDrafts(old=>{
      const previous=old[key]||'';
      const next=typeof value==='function'?value(previous):value;
      if(next===previous)return old;
      if(next)return {...old,[key]:next};
      const copy={...old};delete copy[key];return copy;
    });
  },[userId,workspaceId,kind,setDrafts]);
  const setDraft=useCallback((value:SetStateAction<string>)=>writeDraft(id,value),[id,writeDraft]);
  return {draft:id&&workspaceId?drafts[keyFor(id)]||'':'',setDraft,writeDraft};
}
