local file = select(1, ...)
local ensure_buffer = select(2, ...) -- when true, always create a buffer (needed for queries)
-- Optional list of client names that must have reported diagnostics for this
-- buffer, along with any pull-diagnostic client. If one hasn't (e.g. a previous
-- call timed out), force a resync so it sends a fresh report instead of
-- trusting an empty, never-populated buffer. Keep in sync with
-- isRequiredClient in lib.ts.
local required_clients = select(3, ...)

-- Diagnostic reports at or after this time are fresh for this sync.
local since = vim.uv.now()

-- Check if buffer already exists (user has it open)
local bufnr = vim.fn.bufnr(file)

if bufnr == -1 and not ensure_buffer then
  -- File is NOT open and caller doesn't need a buffer — use lightweight LSP notification.
  -- This tells all LSP servers "this file changed on disk" without creating a buffer.
  -- The server will re-read from disk and update its index (imports, types, etc.)
  -- which propagates diagnostics to any dependent files the user DOES have open.
  local uri = vim.uri_from_fname(file)
  local notified = false
  for _, client in ipairs(vim.lsp.get_clients()) do
    client:notify('workspace/didChangeWatchedFiles', {
      changes = {
        { uri = uri, type = 2 } -- 2 = FileChangeType.Changed
      }
    })
    notified = true
  end

  if not notified then
    return { error = "No LSP clients running to notify about " .. file }
  end

  -- Give LSP servers a moment to process the file change
  vim.wait(500, function() return false end, 50)

  return { bufnr = -1, notified = true }
end

-- Buffer exists or caller needs one — full sync path
if bufnr == -1 then
  bufnr = vim.fn.bufnr(file, true)
  -- Mark as unlisted so it doesn't clutter the user's buffer list
  vim.api.nvim_set_option_value('buflisted', false, { buf = bufnr })
  -- Bridge-created buffers are transient sync targets, not user editing sessions.
  -- Disabling swapfile *before* the first disk read prevents this nvim instance
  -- from grabbing the global swap-lock for `file`, which would otherwise wedge
  -- any other nvim instance that has the file open behind an E325 modal prompt.
  vim.api.nvim_set_option_value('swapfile', false, { buf = bufnr })
end

-- Ensure buffer is loaded (reads from disk if not yet loaded)
if not vim.api.nvim_buf_is_loaded(bufnr) then
  vim.fn.bufload(bufnr)
end

-- Check if buffer content differs from disk
local ok, disk_lines = pcall(vim.fn.readfile, file)
if not ok then
  return { error = "Could not read file: " .. file }
end

local buf_lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
local changed = not vim.deep_equal(buf_lines, disk_lines)

-- Use :edit! to reload from disk — this triggers the LSP on_reload callback
-- which sends didClose + didOpen to ALL attached clients (full resync)
local function reload()
  local was_listed = vim.api.nvim_get_option_value('buflisted', { buf = bufnr })
  -- Belt-and-suspenders for the :edit! path: auto-respond 'e' (edit anyway) to
  -- any SwapExists prompt, in case 'swapfile' didn't take effect or the user
  -- already had this buffer open with swapfile on. Without this, a swap-conflict
  -- prompt blocks the event loop indefinitely (wait_return/vgetc on kevent).
  local swap_group = vim.api.nvim_create_augroup('nvim_lsp_bridge_swap', { clear = true })
  vim.api.nvim_create_autocmd('SwapExists', {
    group = swap_group,
    callback = function()
      vim.v.swapchoice = 'e'
    end,
  })
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd('edit!')
  end)
  pcall(vim.api.nvim_del_augroup_by_id, swap_group)
  -- Refresh bufnr in case it changed during reload
  bufnr = vim.fn.bufnr(file)
  -- edit! can re-list the buffer; restore unlisted state if it wasn't listed before
  if not was_listed then
    vim.api.nvim_set_option_value('buflisted', false, { buf = bufnr })
  end
end

if changed then
  reload()
end

-- Ensure LSP is attached
local clients = vim.lsp.get_clients({ bufnr = bufnr })
if #clients == 0 then
  local was_listed = vim.api.nvim_get_option_value('buflisted', { buf = bufnr })
  -- Trigger filetype detection to get LSP attached via autocmds
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd('filetype detect')
  end)
  -- Restore unlisted state if it wasn't listed before
  if not was_listed then
    vim.api.nvim_set_option_value('buflisted', false, { buf = bufnr })
  end
  -- Wait for LSP client to attach (up to 5s)
  vim.wait(5000, function()
    return #vim.lsp.get_clients({ bufnr = bufnr }) > 0
  end, 50)

  clients = vim.lsp.get_clients({ bufnr = bufnr })
  if #clients == 0 then
    return { error = "No LSP client attached to " .. file }
  end
  -- LSP just attached and needs to process the initial didOpen
  changed = true
end

-- An attached client we need diagnostics from has never reported for this
-- buffer: resync so it does. Clean files still get an (empty) report.
if not changed and required_clients then
  local reports = (_G.__nvim_lsp_bridge and _G.__nvim_lsp_bridge.reports[bufnr]) or {}
  for _, client in ipairs(clients) do
    local required = vim.tbl_contains(required_clients, client.name)
      or client.server_capabilities.diagnosticProvider ~= nil
      or client:supports_method('textDocument/diagnostic', bufnr)
    if required and not reports[client.id] then
      reload()
      changed = true
      break
    end
  end
end

-- Trigger BufWritePost so Neovim's built-in LSP handler sends didSave to all clients
-- This is needed for on-save linters like ESLint
if changed then
  vim.api.nvim_exec_autocmds('BufWritePost', { buffer = bufnr })
end

-- The caller polls diagnostics_status.lua to wait for fresh reports, so long
-- waits (a cold tsserver can take 30s+) don't block Neovim's event loop.
return { bufnr = bufnr, synced = changed, since = since }
