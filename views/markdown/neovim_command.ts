// Neovim's command for the editor pane's terminal (terminal_editor.ts).
//
// Nothing uses this: the pane runs Helix. This and neovim.ts are an example
// of another terminal editor. They were tested lightly, to exercise the
// interface, by swapping them in in files.ts and client.ts. The pane drew the
// file, and ⌘-click, ⌘S and auto-save worked.
//
// Neovim loads ah's Lua setup before the user's config. It keeps to
// editor.ts's rules:
//
// - Save 650ms after typing stops, and when the pane loses focus.
// - Check the file on disk every 300ms and when the pane gains focus
//   (`checktime`). An unmodified buffer reloads. A modified one gets the
//   file on disk merged into it by the server's merge route (routes.ts, at
//   AH_MERGE_URL), with the text as of the last read or save as the base.
//   The agent's edits and the unsaved typing both survive, with both
//   versions marked where they overlap (merge.ts). Every save checks
//   first, so it writes the merged text and never writes over the agent's.
//   If a merge fails, saves stop until the next change on disk merges.
// - ⌘S saves: the page sends it as a kitty keyboard protocol super chord,
//   which Neovim reads as <D-s>.

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TerminalCommand } from "./terminal_editor.ts"

const SETUP = `
local SAVE_DELAY, CHECK_EVERY = 650, 300

-- The file's text as of the last read or save, per buffer: the merge base
local base = {}
-- Buffers whose last merge failed, which mustn't be saved over the file
local unmerged = {}

local function read(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end

local function text_of(buf)
  local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\\n")
  if vim.bo[buf].eol then text = text .. "\\n" end
  return text
end

local function set_text(buf, text)
  local eol = text:sub(-1) == "\\n"
  if eol then text = text:sub(1, -2) end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\\n", { plain = true }))
  vim.bo[buf].eol = eol
end

local function remember(ev)
  base[ev.buf] = read(vim.api.nvim_buf_get_name(ev.buf))
end
vim.api.nvim_create_autocmd({ "BufReadPost", "BufWritePost" }, { callback = remember })

local function merge(buf)
  local disk = read(vim.api.nvim_buf_get_name(buf))
  if not disk then return end
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  local args = { "curl", "--silent", "--fail", "--max-time", "5" }
  local texts = { base = base[buf] or disk, unsaved = text_of(buf), disk = disk }
  for name, text in pairs(texts) do
    local f = assert(io.open(dir .. "/" .. name, "wb"))
    f:write(text)
    f:close()
    vim.list_extend(args, { "--form", name .. "=@" .. dir .. "/" .. name })
  end
  -- The merged text to a file, and the number of conflicts it marked to stdout
  vim.list_extend(args, { "--output", dir .. "/merged", "--write-out", "%header{ah-conflicts}" })
  table.insert(args, vim.env.AH_MERGE_URL)
  local result = vim.system(args, { text = true }):wait()
  local merged = read(dir .. "/merged")
  vim.fn.delete(dir, "rf")
  if result.code ~= 0 or not merged then
    unmerged[buf] = true
    vim.notify("ah: couldn't merge the file on disk, not saving: is ah running?", vim.log.levels.ERROR)
    return
  end
  unmerged[buf] = nil
  set_text(buf, merged)
  base[buf] = disk
  local conflicts = tonumber(result.stdout) or 0
  if conflicts > 0 then
    vim.notify("ah: merged the file on disk, with " .. conflicts .. (conflicts == 1 and " conflict" or " conflicts") .. " marked", vim.log.levels.WARN)
  end
end

vim.api.nvim_create_autocmd("FileChangedShell", {
  callback = function(ev)
    if vim.v.fcs_reason == "deleted" then return end
    if not vim.bo[ev.buf].modified then
      vim.v.fcs_choice = "reload"
      return
    end
    -- Handled here: the buffer keeps its unsaved state, now with the disk's
    -- changes merged in, and the next save writes it
    vim.v.fcs_choice = ""
    merge(ev.buf)
  end,
})

local function check()
  if vim.fn.getcmdwintype() == "" then vim.cmd("silent! checktime") end
end

-- update! because Neovim still counts a merged file as changed since it was
-- read, and would ask before writing; the check just before has merged
-- whatever is on disk
local function save()
  check()
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo.modified and vim.bo.buftype == "" and vim.api.nvim_buf_get_name(0) ~= "" and not unmerged[buf] then
    vim.cmd("silent! update!")
  end
end

local save_timer = vim.uv.new_timer()
vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
  callback = function()
    save_timer:stop()
    save_timer:start(SAVE_DELAY, 0, vim.schedule_wrap(save))
  end,
})
vim.api.nvim_create_autocmd("FocusLost", { callback = save })
vim.api.nvim_create_autocmd("FocusGained", { callback = check })
vim.uv.new_timer():start(CHECK_EVERY, CHECK_EVERY, vim.schedule_wrap(check))

vim.keymap.set({ "n", "i", "v" }, "<D-s>", save)
`

let setup: Promise<string> | null = null

/** Writes the Lua setup to a temp file once per server, on the first pane,
 * and tries again on the next pane if that failed */
function neovimSetup(): Promise<string> {
  if (!setup) {
    setup = (async () => {
      const path = join(await mkdtemp(join(tmpdir(), "ah-nvim-")), "ah.lua")
      await writeFile(path, SETUP)
      return path
    })()
    setup.catch(() => (setup = null))
  }
  return setup
}

export const neovimCommand: TerminalCommand = async (file) => ({
  command: "nvim",
  // --cmd runs it before the file loads, so the first BufReadPost sets the
  // merge base
  args: ["--cmd", `luafile ${await neovimSetup()}`, file],
})
