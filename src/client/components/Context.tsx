import { createContext, useContext } from 'react';
import type { Lang, Theme, User } from '../../shared/types';
export interface UIState { lang:Lang; theme:Theme; setLang:(l:Lang)=>void; setTheme:(t:Theme)=>void; user:User|null; setUser:(u:User|null)=>void; path:string; navigate:(p:string)=>void; text:(ar:string,en:string)=>string; speak:(text:string)=>void; toast:(text:string)=>void; }
export const UIContext=createContext<UIState>(null as unknown as UIState);
export const useUI=()=>useContext(UIContext);
