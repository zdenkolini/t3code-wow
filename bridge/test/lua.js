// Lua interpreters on PATH. Found by running them, since `which` doesn't exist on
// Windows. Tests that need Lua skip when none is found.
import { execFileSync } from 'node:child_process';

export function hasLua(bin) {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The first interpreter found, in order of preference, or undefined.
export const anyLua = () => ['lua5.1', 'luajit', 'lua'].find(hasLua);

export const NO_LUA = 'no lua interpreter';
