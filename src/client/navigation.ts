type NavigationGuard=()=>Promise<boolean>;
const guards=new Set<NavigationGuard>();
let checking:Promise<boolean>|null=null;
export function registerNavigationGuard(guard:NavigationGuard):()=>void {guards.add(guard);return()=>{guards.delete(guard)};}
export async function canNavigate():Promise<boolean> {if(checking)return checking;checking=(async()=>{for(const guard of [...guards])if(!await guard())return false;return true})().catch(()=>false).finally(()=>{checking=null});return checking;}
