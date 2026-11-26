// A list refresh may preserve a valid explicit selection, but never select the first row.
export function retainSelection(current:string|null,rows:readonly {id:string}[]):string|null{
  return current!==null&&rows.some(row=>row.id===current)?current:null;
}
