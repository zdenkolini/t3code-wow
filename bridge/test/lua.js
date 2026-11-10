// Lua interpreters on PATH. Found by running them, since `which` doesn't exist on
// Windows. Tests that need Lua skip when none is found.
import { spawnSync } from 'node:child_process';

// The `-v` banner (Lua 5.1 prints it on stderr, LuaJIT on stdout), or null if it didn't run.
function luaVersion(bin) {
  const r = spawnSync(bin, ['-v'], { encoding: 'utf8' });
  return r.status === 0 ? `${r.stdout}${r.stderr}` : null;
}

export const hasLua = (bin) => luaVersion(bin) != null;

// The first interpreter found, in order of preference, or undefined.
export const anyLua = () => ['lua5.1', 'luajit', 'lua'].find(hasLua);

// Only interpreters with the game's Lua 5.1 semantics, for tests that load addon files.
// A plain `lua` counts only when it reports 5.1.
export const lua51 = () => ['lua5.1', 'luajit'].find(hasLua) || (/Lua 5\.1/.test(luaVersion('lua') || '') ? 'lua' : undefined);

export const NO_LUA = 'no lua interpreter';

// Lua's output as text. On Windows the C runtime writes stdout in text mode, so each
// newline Lua prints arrives as CRLF; turn those back into plain newlines.
export const luaText = (out) => out.toString('utf8').replace(/\r\n/g, '\n');
