import {ShieldCheck,UserRound} from 'lucide-react';
import ThemedPicker,{type PickerOption} from './ThemedPicker';

type Role='member'|'admin';
interface Props {label:string;value:Role;onChange:(role:Role)=>void;disabled?:boolean;allowAdmin?:boolean;fullWidth?:boolean}
const options:PickerOption<Role>[]=[{value:'member',label:'Member',icon:UserRound},{value:'admin',label:'Admin',icon:ShieldCheck}];
export default function RolePicker({allowAdmin=true,...props}:Props){
  return <ThemedPicker {...props} options={allowAdmin?options:options.slice(0,1)}/>;
}
